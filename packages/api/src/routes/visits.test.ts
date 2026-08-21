import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DERIVED, toCell, type GridParams } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { runMaintenanceTick } from '../maintenance.js';
import type { PushSender } from '../push/sender.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBars } from '../db/seed-bars.js';
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// Same real committed trees routes/bars.test.ts reaches, copied into a temp
// directory per test so a synthetic bars.json can be dropped alongside the
// real grid.bin/grid-meta.json without ever writing
// data/seed/karlsruhe/bars.json itself.
const REAL_DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const REAL_SEED_DIR = join(REAL_DATA_DIR, 'seed');
const REAL_CITIES_DIR = join(REAL_DATA_DIR, 'cities');

const REAL_CITY_CONFIG = JSON.parse(
  readFileSync(join(REAL_CITIES_DIR, 'karlsruhe.json'), 'utf-8'),
) as { cell_size_m: number; bounding_box: { south: number; west: number } };
const REAL_GRID_META = JSON.parse(
  readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
) as { grid_width: number; grid_height: number };

const GRID_PARAMS: GridParams = {
  origin_lat: REAL_CITY_CONFIG.bounding_box.south,
  origin_lon: REAL_CITY_CONFIG.bounding_box.west,
  grid_width: REAL_GRID_META.grid_width,
  grid_height: REAL_GRID_META.grid_height,
  cell_size_m: REAL_CITY_CONFIG.cell_size_m,
};

// Karlsruhe Schloss (SPEC.md's own worked example, also used by
// routes/bars.test.ts and routes/fog.test.ts): well inside the bounding
// box, in a single district.
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };
const SCHLOSS_CELL_INDEX = toCell(SCHLOSS.lat, SCHLOSS.lon, GRID_PARAMS);
if (SCHLOSS_CELL_INDEX === null) {
  throw new Error('SCHLOSS is expected to fall inside the committed Karlsruhe grid');
}

// Local reimplementation of SPEC.md Section 6.1's projection constants
// (mirrored, with the same values, in packages/shared/src/grid.ts — not
// exported from the package's public entry point, so a fixture-only offset
// helper reimplements it here rather than reaching past that boundary; the
// same choice routes/bars.test.ts makes).
const M_PER_DEG_LAT = 110574;
function mPerDegLon(lat: number): number {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
function offsetMeters(
  base: { lat: number; lon: number },
  northM: number,
  eastM: number,
): { lat: number; lon: number } {
  return {
    lat: base.lat + northM / M_PER_DEG_LAT,
    lon: base.lon + eastM / mPerDegLon(base.lat),
  };
}

// A second bar 20 m east of SCHLOSS: within both BAR_DISCOVERY_RADIUS_M and
// the check-in route's most generous on-site radius, so a single sample at
// SCHLOSS discovers and stands on-site for both at once.
const NEARBY = offsetMeters(SCHLOSS, 0, 20);
// A third bar 5 km north: outside every radius a SCHLOSS-area sample could
// ever reach, so it stays undiscovered without a dedicated "stay away"
// assertion.
const FAR_AWAY = offsetMeters(SCHLOSS, 5000, 0);
// 500 m north of SCHLOSS: outside BAR_ONSITE_RADIUS_M + BAR_ACCURACY_TOLERANCE_M
// (100 m), the radius POST /api/visits checks the last accepted sample
// against, but a plausible walking distance for the teleport guard.
const MOVED_AWAY = offsetMeters(SCHLOSS, 500, 0);
if (500 <= CONFIG.BAR_ONSITE_RADIUS_M + CONFIG.BAR_ACCURACY_TOLERANCE_M) {
  throw new Error("MOVED_AWAY is expected to fall outside the check-in route's onsite radius");
}

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-visits-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
};

const validRegisterBody = {
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;
let tempRoot: string;
let tempSeedDir: string;
let env: ReturnType<typeof loadEnv>;

function injectWithOrigin(options: InjectOptions): Promise<LightMyRequestResponse> {
  return app.inject({
    ...options,
    headers: { origin: baseEnv.PUBLIC_ORIGIN, ...options.headers },
  });
}

function extractSessionCookie(response: LightMyRequestResponse): string {
  const setCookie = response.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!cookieHeader) {
    throw new Error('expected a Set-Cookie header');
  }
  return cookieHeader.split(';')[0];
}

async function registerUser(username: string): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return extractSessionCookie(response);
}

function sample(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    lat: SCHLOSS.lat,
    lon: SCHLOSS.lon,
    accuracy: 10,
    speed: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function postSamples(
  cookie: string,
  samples: unknown[],
  targetApp: FastifyInstance = app,
): Promise<LightMyRequestResponse> {
  return targetApp.inject({
    method: 'POST',
    url: '/api/samples',
    headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
    payload: { samples },
  });
}

function checkIn(
  cookie: string,
  barId: number,
  targetApp: FastifyInstance = app,
): Promise<LightMyRequestResponse> {
  return targetApp.inject({
    method: 'POST',
    url: '/api/visits',
    headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
    payload: { barId },
  });
}

function cancelVisit(cookie: string, visitId: number | string): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: `/api/visits/${visitId}/cancel`,
    headers: { cookie },
  });
}

function statusOfVisit(visitId: number): string | undefined {
  return db
    .prepare<[number], { status: string }>('SELECT status FROM visits WHERE id = ?')
    .get(visitId)?.status;
}

function getPending(cookie: string): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'GET',
    url: '/api/visits/pending',
    headers: { cookie },
  });
}

function barIdByName(name: string): number {
  return db.prepare<[string], { id: number }>('SELECT id FROM bars WHERE name = ?').get(name)!.id;
}

function writeBarsFixture(
  bars: { osm_id: string; name: string; lat: number; lon: number }[],
): void {
  writeFileSync(
    join(tempSeedDir, 'karlsruhe', 'bars.json'),
    JSON.stringify(
      bars.map((bar) => ({
        osm_id: bar.osm_id,
        name: bar.name,
        address: null,
        lat: bar.lat,
        lon: bar.lon,
        cell_index: SCHLOSS_CELL_INDEX,
        source: 'osm',
      })),
    ),
  );
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `tipsytrails-visits-test-fixture-${randomUUID()}`);
  cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
  cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
    recursive: true,
  });
  tempSeedDir = join(tempRoot, 'seed');
  writeBarsFixture([
    { osm_id: 'node/1', name: 'Zum Schlossgarten', ...SCHLOSS },
    { osm_id: 'node/2', name: 'Nahe Ecke', ...NEARBY },
    { osm_id: 'node/3', name: 'Weit Weg', ...FAR_AWAY },
  ]);

  dbPath = join(tmpdir(), `tipsytrails-visits-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
  seedCity(db, env);
  seedBars(db, env);
  app = buildApp(env, db);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(vapidTestDir, { recursive: true, force: true });
});

describe('POST /api/visits', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/visits',
      payload: { barId: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  it('checks in at a discovered bar with a recent on-site sample and creates one pending row', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    const response = await checkIn(cookie, barId);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      barId,
      barName: 'Zum Schlossgarten',
      status: 'pending',
      onsiteSamples: 1,
      confirmedS: 0,
      remainingS: DERIVED.VISIT_REQUIRED_S,
    });
    expect(typeof body.id).toBe('number');

    const rows = db.prepare('SELECT * FROM visits').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bar_id: barId, status: 'pending', onsite_samples: 1 });
  });

  it('returns the same visit id on a second check-in and leaves exactly one row', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    const first = await checkIn(cookie, barId);
    const second = await checkIn(cookie, barId);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const count = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM visits').get();
    expect(count?.count).toBe(1);
  });

  it('returns byte-identical 404s for an undiscovered bar and a nonexistent bar', async () => {
    const cookie = await registerUser('walker');
    // Discovers "Zum Schlossgarten" and "Nahe Ecke" but never "Weit Weg".
    await postSamples(cookie, [sample()]);
    const undiscoveredBarId = barIdByName('Weit Weg');

    const undiscovered = await checkIn(cookie, undiscoveredBarId);
    const nonexistent = await checkIn(cookie, 999999);

    expect(undiscovered.statusCode).toBe(404);
    expect(nonexistent.statusCode).toBe(404);
    expect(undiscovered.body).toBe(nonexistent.body);
    expect(undiscovered.json()).toEqual(nonexistent.json());
  });

  it('rejects a check-in with no last accepted sample on record with 422', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    // A fresh app over the same database models an API restart: the bar
    // discovery persisted, but the in-memory lastAccepted map did not
    // (SPEC.md Section 10.2).
    const restarted = buildApp(env, db);
    const response = await checkIn(cookie, barId, restarted);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('no_recent_sample');

    const count = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM visits').get();
    expect(count?.count).toBe(0);
  });

  it('rejects a check-in when the last accepted sample is out of range with 422', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');

    // A later, distinct sample moves lastAccepted away from the bar without
    // tripping the teleport guard (500 m in 60 s ~= 30 km/h).
    await postSamples(cookie, [sample({ ...MOVED_AWAY, timestamp: Date.now() + 60_000 })]);

    const response = await checkIn(cookie, barId);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('not_onsite');

    const count = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM visits').get();
    expect(count?.count).toBe(0);
  });

  it('expires a stale pending visit on check-in and starts a fresh one instead of returning it', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ?, confirmed_s = 999 WHERE id = ?').run(
      staleLastSampleAt,
      visitId,
    );

    const again = await checkIn(cookie, barId);

    expect(again.statusCode).toBe(200);
    expect(again.json().id).not.toBe(visitId);
    expect(again.json().confirmedS).toBe(0);
  });

  it('leaves the replaced stale visit at status=expired rather than deleting or reusing it', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    await checkIn(cookie, barId);

    const row = db
      .prepare<[number], { status: string }>('SELECT status FROM visits WHERE id = ?')
      .get(visitId);
    expect(row?.status).toBe('expired');

    const count = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM visits').get();
    expect(count?.count).toBe(2);
  });
});

describe('GET /api/visits/pending', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/visits/pending' });
    expect(response.statusCode).toBe(401);
  });

  it('expires a stale visit on read, persists status=expired, and omits it', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    const response = await getPending(cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json().visits).toEqual([]);

    const row = db
      .prepare<[number], { status: string }>('SELECT status FROM visits WHERE id = ?')
      .get(visitId);
    expect(row?.status).toBe('expired');
  });

  it('returns pending visits for two different bars', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const schlossId = barIdByName('Zum Schlossgarten');
    const nearbyId = barIdByName('Nahe Ecke');

    await checkIn(cookie, schlossId);
    await checkIn(cookie, nearbyId);

    const response = await getPending(cookie);

    expect(response.statusCode).toBe(200);
    const barIds = response.json().visits.map((visit: { barId: number }) => visit.barId);
    expect(barIds.sort()).toEqual([schlossId, nearbyId].sort());
  });
});

// SPEC.md Sections 5.7, 7.5 ("A pending visit can be cancelled"), 9.2, 9.5.
describe('POST /api/visits/:id/cancel', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'POST', url: '/api/visits/1/cancel' });
    expect(response.statusCode).toBe(401);
  });

  it("moves the caller's own pending visit to cancelled, keeps the row, and drops it from the banner", async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;

    const response = await cancelVisit(cookie, visitId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: visitId, barId, status: 'cancelled' });

    // Section 5.7: "The row is kept rather than deleted" — a record of what
    // happened, not a mistake to erase.
    const count = db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM visits').get();
    expect(count?.count).toBe(1);
    expect(statusOfVisit(visitId)).toBe('cancelled');
    // Nothing was completed, so nothing may claim to have been.
    const row = db
      .prepare<[number], { completed_at: number | null }>(
        'SELECT completed_at FROM visits WHERE id = ?',
      )
      .get(visitId);
    expect(row?.completed_at).toBeNull();

    const pending = await getPending(cookie);
    expect(pending.json().visits).toEqual([]);
  });

  // Section 5.7's whole reason for keeping cancel a status change rather
  // than a deletion: leaving `pending` releases the partial unique index
  // `idx_visits_one_pending`, so the same bar is checkable again at once.
  it('releases the one-pending-visit index so the same bar can be checked into again immediately', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const first = await checkIn(cookie, barId);
    const firstId = first.json().id as number;

    await cancelVisit(cookie, firstId);
    const second = await checkIn(cookie, barId);

    expect(second.statusCode).toBe(200);
    expect(second.json().id).not.toBe(firstId);
    expect(second.json()).toMatchObject({ barId, status: 'pending', confirmedS: 0 });

    // Two rows, one cancelled and one pending — the second check-in created
    // a new visit rather than reviving or replacing the cancelled one.
    const rows = db
      .prepare<[], { id: number; status: string }>('SELECT id, status FROM visits ORDER BY id')
      .all();
    expect(rows.map((visit) => visit.status)).toEqual(['cancelled', 'pending']);
  });

  it("does not cancel another user's pending visit", async () => {
    const ownerCookie = await registerUser('walker');
    await postSamples(ownerCookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(ownerCookie, barId);
    const visitId = created.json().id as number;

    const strangerCookie = await registerUser('stranger');
    const response = await cancelVisit(strangerCookie, visitId);

    expect(response.statusCode).toBe(404);
    expect(statusOfVisit(visitId)).toBe('pending');
    expect((await getPending(ownerCookie)).json().visits).toHaveLength(1);
  });

  it('does not cancel a completed visit', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;
    const completedAtS = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE visits SET status = 'completed', completed_at = ? WHERE id = ?`).run(
      completedAtS,
      visitId,
    );

    const response = await cancelVisit(cookie, visitId);

    expect(response.statusCode).toBe(404);
    // Mastering is permanent (Section 5.7) — a cancel must not be able to
    // reach back and unmaster a bar.
    expect(statusOfVisit(visitId)).toBe('completed');
  });

  it('does not cancel an expired visit, and cannot cancel the same visit twice', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const schlossId = barIdByName('Zum Schlossgarten');
    const nearbyId = barIdByName('Nahe Ecke');

    const stale = await checkIn(cookie, schlossId);
    const staleId = stale.json().id as number;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(
      Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60,
      staleId,
    );

    const staleResponse = await cancelVisit(cookie, staleId);

    expect(staleResponse.statusCode).toBe(404);
    // Section 7.9's lazy expiry, and Section 5.7's "cancelled ... only by
    // the caller's own explicit request": the six-hour rule already ended
    // this visit, so the row records `expired` and not the player's choice.
    expect(statusOfVisit(staleId)).toBe('expired');

    const live = await checkIn(cookie, nearbyId);
    const liveId = live.json().id as number;
    expect((await cancelVisit(cookie, liveId)).statusCode).toBe(200);
    const second = await cancelVisit(cookie, liveId);
    expect(second.statusCode).toBe(404);
    expect(statusOfVisit(liveId)).toBe('cancelled');
  });

  // SPEC.md Section 9.5: `visits.id` is a global sequence, so telling these
  // cases apart would make this route an oracle for other players' visits —
  // the same argument that makes `GET /api/bars/:id` answer one identical
  // 404 for "does not exist" and "not discovered by you".
  it("returns byte-identical 404s for another user's visit, a terminal visit, and ids that never existed", async () => {
    const ownerCookie = await registerUser('walker');
    await postSamples(ownerCookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(ownerCookie, barId);
    const otherUsersVisitId = created.json().id as number;

    const cookie = await registerUser('stranger');
    const nearbyId = barIdByName('Nahe Ecke');
    await postSamples(cookie, [sample()]);
    const own = await checkIn(cookie, nearbyId);
    const ownVisitId = own.json().id as number;
    await cancelVisit(cookie, ownVisitId);

    const responses = [
      await cancelVisit(cookie, otherUsersVisitId),
      await cancelVisit(cookie, ownVisitId),
      await cancelVisit(cookie, 999999),
      await cancelVisit(cookie, 'not-a-number'),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(responses[0].body);
    }
  });

  // SPEC.md Section 5.7: "it is never reached by a sample or by the
  // maintenance tick". The tick's two visit passes (expiry and the
  // 21-minute push) both select `status = 'pending'`, so a cancelled row is
  // outside both — proven here rather than asserted, because a fourth
  // status is exactly the kind of change a status-blind sweep would swallow.
  it('leaves cancelled rows alone in the maintenance tick, however stale they are', async () => {
    const cookie = await registerUser('walker');
    await postSamples(cookie, [sample()]);
    const barId = barIdByName('Zum Schlossgarten');
    const created = await checkIn(cookie, barId);
    const visitId = created.json().id as number;

    await cancelVisit(cookie, visitId);
    // Older than both VISIT_EXPIRY_S and VISIT_PUSH_AFTER_S, so a sweep that
    // ignored `status` would expire it and push for it.
    const longAgoS = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 3600;
    db.prepare('UPDATE visits SET started_at = ?, last_sample_at = ? WHERE id = ?').run(
      longAgoS,
      longAgoS,
      visitId,
    );

    const sent: string[] = [];
    const pushSender: PushSender = {
      send: async (subscription) => {
        sent.push(subscription.endpoint);
        return { delivered: true };
      },
    };
    const result = await runMaintenanceTick(db, Math.floor(Date.now() / 1000), { pushSender });

    expect(result.expiredVisits).toBe(0);
    expect(result.pushDispatched).toBe(0);
    expect(sent).toEqual([]);
    expect(statusOfVisit(visitId)).toBe('cancelled');
    const row = db
      .prepare<[number], { push_sent_at: number | null }>(
        'SELECT push_sent_at FROM visits WHERE id = ?',
      )
      .get(visitId);
    expect(row?.push_sent_at).toBeNull();
  });
});
