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
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBars } from '../db/seed-bars.js';
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';

// SPEC.md Sections 5.7, 7.5, 9.2: `POST /api/samples`'s `visitUpdates` field
// (Phase 5 step 2). Kept out of routes/fog.test.ts, which does not seed any
// bars, rather than growing that file's fixtures just for this — this file
// mirrors routes/visits.test.ts's bar/visit fixture instead, since a
// pending visit is a precondition for every test here.

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

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
// routes/bars.test.ts, routes/fog.test.ts and routes/visits.test.ts).
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };
const SCHLOSS_CELL_INDEX = toCell(SCHLOSS.lat, SCHLOSS.lon, GRID_PARAMS);
if (SCHLOSS_CELL_INDEX === null) {
  throw new Error('SCHLOSS is expected to fall inside the committed Karlsruhe grid');
}

// Local reimplementation of SPEC.md Section 6.1's projection constants, the
// same choice routes/visits.test.ts and routes/bars.test.ts make.
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

// 500 m north of SCHLOSS: outside BAR_ONSITE_RADIUS_M + BAR_ACCURACY_TOLERANCE_M
// (100 m, the largest on-site radius any sample in these tests can have),
// but a plausible walking distance for the teleport guard, exactly as
// routes/visits.test.ts uses it for the check-in route's own radius.
const MOVED_AWAY = offsetMeters(SCHLOSS, 500, 0);
if (500 <= CONFIG.BAR_ONSITE_RADIUS_M + CONFIG.BAR_ACCURACY_TOLERANCE_M) {
  throw new Error('MOVED_AWAY is expected to fall outside the largest possible on-site radius');
}

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-visit-samples-test-vapid-${randomUUID()}`);

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

function postSamples(cookie: string, samples: unknown[]): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/samples',
    headers: { cookie },
    payload: { samples },
  });
}

function checkIn(cookie: string, barId: number): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'POST',
    url: '/api/visits',
    headers: { cookie },
    payload: { barId },
  });
}

function barIdByName(name: string): number {
  return db.prepare<[string], { id: number }>('SELECT id FROM bars WHERE name = ?').get(name)!.id;
}

interface VisitRow {
  id: number;
  bar_id: number;
  started_at: number;
  last_sample_at: number;
  onsite_samples: number;
  confirmed_s: number;
  status: string;
  completed_at: number | null;
}

function getVisit(visitId: number): VisitRow {
  return db.prepare<[number], VisitRow>('SELECT * FROM visits WHERE id = ?').get(visitId)!;
}

function findUpdate(
  response: LightMyRequestResponse,
  visitId: number,
): { id: number; status: string; onsiteSamples: number; completedAt?: number } | undefined {
  return response.json().visitUpdates.find((v: { id: number }) => v.id === visitId) as
    { id: number; status: string; onsiteSamples: number; completedAt?: number } | undefined;
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

// Checks a discovered bar in at SCHLOSS and returns its pending visit's id
// and (server-time) started_at.
async function checkInAtSchloss(cookie: string): Promise<{ visitId: number; startedAt: number }> {
  await postSamples(cookie, [sample()]);
  const barId = barIdByName('Zum Schlossgarten');
  const created = await checkIn(cookie, barId);
  const body = created.json();
  return { visitId: body.id as number, startedAt: body.startedAt as number };
}

beforeEach(() => {
  tempRoot = join(tmpdir(), `tipsytrails-visit-samples-test-fixture-${randomUUID()}`);
  cpSync(REAL_CITIES_DIR, join(tempRoot, 'cities'), { recursive: true });
  cpSync(join(REAL_SEED_DIR, 'karlsruhe'), join(tempRoot, 'seed', 'karlsruhe'), {
    recursive: true,
  });
  tempSeedDir = join(tempRoot, 'seed');
  writeBarsFixture([{ osm_id: 'node/1', name: 'Zum Schlossgarten', ...SCHLOSS }]);

  dbPath = join(tmpdir(), `tipsytrails-visit-samples-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv({ ...baseEnv, SEED_DIR: tempSeedDir });
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

describe('POST /api/samples visitUpdates', () => {
  it('an on-site sample updates last_sample_at, increments onsite_samples, and recomputes confirmed_s from started_at', async () => {
    const cookie = await registerUser('walker');
    const { visitId, startedAt } = await checkInAtSchloss(cookie);

    const response = await postSamples(cookie, [sample({ timestamp: Date.now() + 5000 })]);

    expect(response.statusCode).toBe(200);
    const update = findUpdate(response, visitId);
    expect(update).toBeDefined();
    expect(update?.status).toBe('pending');
    expect(update?.onsiteSamples).toBe(2);

    const row = getVisit(visitId);
    expect(row.status).toBe('pending');
    expect(row.onsite_samples).toBe(2);
    expect(row.confirmed_s).toBe(row.last_sample_at - startedAt);
  });

  it('two on-site samples at least VISIT_REQUIRED_S apart complete the visit with nothing sent in between', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    // Simulates the app being closed for VISIT_REQUIRED_S (SPEC.md Section
    // 7.5: "Because completion needs only two valid samples 20 minutes
    // apart, the app does not have to stay open") by pushing started_at
    // back rather than waiting in real time. last_sample_at is left recent
    // so the visit is not judged expired at the same time.
    const pushedBackStartedAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_REQUIRED_S - 5;
    db.prepare('UPDATE visits SET started_at = ? WHERE id = ?').run(pushedBackStartedAt, visitId);

    const response = await postSamples(cookie, [sample({ timestamp: Date.now() })]);

    expect(response.statusCode).toBe(200);
    const update = findUpdate(response, visitId);
    expect(update).toBeDefined();
    expect(update?.status).toBe('completed');

    const row = getVisit(visitId);
    expect(row.status).toBe('completed');
    expect(row.completed_at).not.toBeNull();
    expect(row.onsite_samples).toBe(2);
  });

  it('an on-site sample that satisfies confirmed_s but leaves onsite_samples one short of VISIT_MIN_ONSITE_SAMPLES does not complete the visit', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);
    expect(CONFIG.VISIT_MIN_ONSITE_SAMPLES).toBe(2);

    // Forces the two conditions of isVisitComplete apart at the moment this
    // handler actually evaluates them. started_at is pushed back so that,
    // once a real on-site sample lands and recomputes confirmed_s =
    // last_sample_at - started_at, the duration condition is already
    // satisfied; onsite_samples is dropped to 0 (below what check-in itself
    // guarantees) so that after this handler's own increment it lands on
    // exactly 1 -- still one short of VISIT_MIN_ONSITE_SAMPLES (2).
    const pushedBackStartedAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_REQUIRED_S - 5;
    db.prepare(
      'UPDATE visits SET onsite_samples = 0, started_at = ?, confirmed_s = ? WHERE id = ?',
    ).run(pushedBackStartedAt, DERIVED.VISIT_REQUIRED_S + 5, visitId);

    const response = await postSamples(cookie, [sample({ timestamp: Date.now() })]);

    expect(response.statusCode).toBe(200);
    const update = findUpdate(response, visitId);
    expect(update).toBeDefined();
    expect(update?.status).toBe('pending');
    expect(update?.onsiteSamples).toBe(1);

    const row = getVisit(visitId);
    expect(row.status).toBe('pending');
    expect(row.onsite_samples).toBe(1);
    expect(row.confirmed_s).toBeGreaterThanOrEqual(DERIVED.VISIT_REQUIRED_S);
  });

  it('a sample outside the on-site radius leaves the visit untouched and pending', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const response = await postSamples(cookie, [
      sample({ ...MOVED_AWAY, timestamp: Date.now() + 60_000 }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json().visitUpdates).toEqual([]);

    const row = getVisit(visitId);
    expect(row.status).toBe('pending');
    expect(row.onsite_samples).toBe(1);
    expect(row.confirmed_s).toBe(0);
  });

  it('a sample rejected as stale by Section 7.2 validation does not touch the visit', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const staleTimestamp = Date.now() - CONFIG.SAMPLE_MAX_AGE_MS - 1000;
    const response = await postSamples(cookie, [sample({ timestamp: staleTimestamp })]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
    });

    const row = getVisit(visitId);
    expect(row.status).toBe('pending');
    expect(row.onsite_samples).toBe(1);
  });

  it('a fast-moving sample that reveals no fog still updates an on-site visit', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);
    // 10 m/s = 36 km/h, above CONFIG.FOG_MAX_SPEED_KMH (30).
    expect(10 * 3.6).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);

    const response = await postSamples(cookie, [
      sample({ speed: 10, timestamp: Date.now() + 5000 }),
    ]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.newCells).toBe(0);
    const update = findUpdate(response, visitId);
    expect(update).toBeDefined();
    expect(update?.onsiteSamples).toBe(2);
  });

  it('a completed visit is not modified by a later on-site sample', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const pushedBackStartedAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_REQUIRED_S - 5;
    db.prepare('UPDATE visits SET started_at = ? WHERE id = ?').run(pushedBackStartedAt, visitId);
    const completion = await postSamples(cookie, [sample({ timestamp: Date.now() })]);
    expect(findUpdate(completion, visitId)?.status).toBe('completed');
    const afterCompletion = getVisit(visitId);

    const later = await postSamples(cookie, [sample({ timestamp: Date.now() + 5000 })]);

    expect(later.statusCode).toBe(200);
    expect(findUpdate(later, visitId)).toBeUndefined();
    expect(getVisit(visitId)).toEqual(afterCompletion);
  });

  it('a pending visit already past VISIT_EXPIRY_S is not revived by a late on-site sample', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    const response = await postSamples(cookie, [sample({ timestamp: Date.now() })]);

    expect(response.statusCode).toBe(200);
    // Reported, not merely written: this response is the client's only
    // notice while the screen stays visible (SPEC.md Section 7.5 step 5).
    expect(findUpdate(response, visitId)?.status).toBe('expired');

    const row = getVisit(visitId);
    expect(row.status).toBe('expired');
    expect(row.onsite_samples).toBe(1);
  });

  // SPEC.md Section 7.5 step 5, and the defect Open Item O14 described
  // before v1.51 closed it: the player checked in, walked away, and kept the
  // app open. Every sample of this batch comes from somewhere else entirely,
  // so the on-site test can never reach this visit — the sweep is the only
  // thing that judges it, and without one the banner showed the visit for as
  // long as the app was open.
  it('expires and reports a pending visit the player walked away from, with no on-site sample in the batch', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    const response = await postSamples(cookie, [
      sample({ ...MOVED_AWAY, timestamp: Date.now() + 60_000 }),
    ]);

    expect(response.statusCode).toBe(200);
    const update = findUpdate(response, visitId);
    expect(update?.status).toBe('expired');
    expect(update?.onsiteSamples).toBe(1);

    const row = getVisit(visitId);
    expect(row.status).toBe('expired');
    // The row records what happened rather than being reset by the expiry.
    expect(row.last_sample_at).toBe(staleLastSampleAt);
    expect(row.onsite_samples).toBe(1);
    expect(row.completed_at).toBeNull();
  });

  // The same walk-away, but with every sample of the batch rejected by
  // Section 7.2's accuracy gate: the sweep reads nothing from any sample, so
  // a batch that accepted none of them still judges the visit.
  it('expires a stale visit even when every sample in the batch is rejected', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    const response = await postSamples(cookie, [
      sample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M + 1, timestamp: Date.now() }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json().newCells).toBe(0);
    expect(findUpdate(response, visitId)?.status).toBe('expired');
    expect(getVisit(visitId).status).toBe('expired');
  });

  // The sweep's clock is the server's, not a timestamp taken out of the
  // batch. `last_sample_at` is a server second, so the other side of the
  // comparison has to be one too — a batch whose oldest sample is two
  // minutes old must not make a visit that ran out five seconds ago look
  // like one that is still short of `VISIT_EXPIRY_S` (SPEC.md Sections 7.2,
  // 7.5).
  it('judges expiry on the server clock, not on the oldest timestamp in the batch', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    // One accepted sample away from the bar first, so the batch below is
    // compared against a position at MOVED_AWAY: its own samples are at that
    // same point, cover no distance, and so pass Section 7.2's teleport
    // guard whatever their timestamps say.
    await postSamples(cookie, [sample({ ...MOVED_AWAY, timestamp: Date.now() + 30_000 })]);

    const staleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S - 5;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(staleLastSampleAt, visitId);

    const response = await postSamples(cookie, [
      sample({ ...MOVED_AWAY, timestamp: Date.now() - 120_000 }),
      sample({ ...MOVED_AWAY, timestamp: Date.now() + 30_000 }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(findUpdate(response, visitId)?.status).toBe('expired');
    expect(getVisit(visitId).status).toBe('expired');
  });

  // The failure that would be worse than the one the sweep fixes: expiring a
  // visit the player is standing in the middle of. A minute short of
  // VISIT_EXPIRY_S, with no on-site sample in the batch, the visit must come
  // through untouched, unreported and still pending — an inverted comparison
  // or a different clock on either side of it would cancel a real check-in.
  // A minute rather than a second because both sides are real wall-clock
  // seconds here; the exact `>=` boundary is pinned where the rule lives
  // (packages/shared/src/visits.test.ts).
  it('leaves a pending visit a minute short of VISIT_EXPIRY_S pending, and says nothing about it', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const almostStaleLastSampleAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_EXPIRY_S + 60;
    db.prepare('UPDATE visits SET last_sample_at = ? WHERE id = ?').run(
      almostStaleLastSampleAt,
      visitId,
    );

    const response = await postSamples(cookie, [
      sample({ ...MOVED_AWAY, timestamp: Date.now() + 60_000 }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json().visitUpdates).toEqual([]);

    const row = getVisit(visitId);
    expect(row.status).toBe('pending');
    expect(row.last_sample_at).toBe(almostStaleLastSampleAt);
  });

  it('a single batch can complete a visit whose check-in was more than VISIT_REQUIRED_S ago', async () => {
    const cookie = await registerUser('walker');
    const { visitId } = await checkInAtSchloss(cookie);

    const pushedBackStartedAt = Math.floor(Date.now() / 1000) - DERIVED.VISIT_REQUIRED_S - 5;
    db.prepare('UPDATE visits SET started_at = ? WHERE id = ?').run(pushedBackStartedAt, visitId);

    const now = Date.now();
    const response = await postSamples(cookie, [
      sample({ timestamp: now - 4000 }),
      sample({ timestamp: now - 2000 }),
      sample({ timestamp: now }),
    ]);

    expect(response.statusCode).toBe(200);
    const update = findUpdate(response, visitId);
    expect(update).toBeDefined();
    expect(update?.status).toBe('completed');

    const row = getVisit(visitId);
    expect(row.status).toBe('completed');
    // Only the first on-site sample of the batch is counted: it alone
    // completes the visit, and per "a completed visit must never ... have
    // its counters moved" the remaining two in-order samples of this same
    // batch are skipped rather than pushing onsite_samples past 2.
    expect(row.onsite_samples).toBe(2);
  });
});
