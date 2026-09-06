import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedCity } from '../db/seed-city.js';
import { loadEnv } from '../env.js';
import type { RejectedSampleCounts } from './fog.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// The real committed data/seed/karlsruhe tree, four levels up from this
// file's own directory to the repository root — the same style
// routes/city.test.ts and routes/static-data.test.ts use.
const REAL_SEED_DIR = fileURLToPath(new URL('../../../../data/seed', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-fog-test-vapid-${randomUUID()}`);

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: join(vapidTestDir, 'tipsytrails.db'),
  SESSION_SECRET: '0123456789012345678901234567890123',
  SEED_DIR: REAL_SEED_DIR,
};

const validRegisterBody = {
  username: 'trailwalker',
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

// Karlsruhe Schloss (SPEC.md's own worked example city). Well inside the
// bounding box, and — verified once against the committed grid.bin/
// grid-meta.json — its 100 m reveal circle lands entirely inside a single
// district ("Innenstadt-West"), which keeps the percentage tests below from
// having to handle a reveal straddling a district border.
const SCHLOSS = { lat: 49.0135, lon: 8.4044 };

// Northeast of Bruchsal, well outside Karlsruhe's bounding box
// (48.9400–49.0950 N, 8.2750–8.5600 E — SPEC.md Section 6.2).
const OUTSIDE_BBOX = { lat: 0, lon: 0 };

// Local reimplementation of SPEC.md Section 6.1's projection constants
// (mirrored, with the same values, in packages/shared/src/grid.ts — not
// exported from the package's public entry point, so a fixture-only offset
// helper reimplements it here rather than reaching past that boundary; the
// same choice routes/bars.test.ts and routes/visits.test.ts make).
const M_PER_DEG_LAT = 110574;
function offsetMeters(base: { lat: number; lon: number }, northM: number): { lat: number } {
  return { lat: base.lat + northM / M_PER_DEG_LAT };
}

// SPEC.md Section 9.6's `rejected`, as an expected value. Every exact-body
// assertion in this file carries all five counts and most batches here fail
// no gate at all, so the zeroes are written once and the interesting count
// is passed in — `rejected({ accuracy: 1 })` reads as "this batch failed the
// accuracy gate once and no other gate at all", which is exactly the claim
// each per-gate test below is making.
//
// The return type is the API's own `RejectedSampleCounts` rather than a
// second declaration of the shape: a count added to or renamed on the server
// must break this file's expectations, and a locally declared twin would let
// the two drift while every assertion still passed.
function rejected(overrides: Partial<RejectedSampleCounts> = {}): RejectedSampleCounts {
  return { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0, ...overrides };
}

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;

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

async function registerUser(username = validRegisterBody.username): Promise<string> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return extractSessionCookie(response);
}

function goodSample(overrides: Partial<Record<string, unknown>> = {}) {
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

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-fog-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv(baseEnv);
  seedCity(db, env);
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
  rmSync(vapidTestDir, { recursive: true, force: true });
});

describe('POST /api/samples', () => {
  it('requires a session', async () => {
    const response = await postSamplesUnauthenticated();
    expect(response.statusCode).toBe(401);

    function postSamplesUnauthenticated() {
      return injectWithOrigin({
        method: 'POST',
        url: '/api/samples',
        payload: { samples: [goodSample()] },
      });
    }
  });

  it('reveals roughly a 100 m radius (~13 cells at 50 m, SPEC.md Section 7.3)', async () => {
    const cookie = await registerUser();

    const response = await postSamples(cookie, [goodSample()]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      newCells: expect.any(Number),
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: rejected(),
    });
    expect(body.newCells).toBeGreaterThanOrEqual(9);
    expect(body.newCells).toBeLessThanOrEqual(17);
  });

  // SPEC.md Section 7.3: the reveal is skipped, and — since v1.26 — the
  // response says so, because a map that does not clear is otherwise
  // indistinguishable from a broken one.
  it('reveals nothing for a sample above FOG_MAX_SPEED_KMH, and says that is why', async () => {
    const cookie = await registerUser();
    // 10 m/s = 36 km/h, above CONFIG.FOG_MAX_SPEED_KMH (30).
    expect(10 * 3.6).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);

    const response = await postSamples(cookie, [goodSample({ speed: 10 })]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: true,
      rejected: rejected(),
    });
  });

  // The boundary itself, both sides of it, because "above" is `>=` in the
  // code and a `>` there would be invisible to the test above.
  // What this pins, and what it deliberately does not.
  //
  // The threshold itself - exactly FOG_MAX_SPEED_KMH - is not reachable
  // through this path at all. The server reads metres per second and
  // multiplies by 3.6, and no double `s` satisfies `s * 3.6 === 30`: the
  // nearest candidate, 30 / 3.6, comes back as 30.000000000000004, and
  // walking either neighbouring representable value steps over the line
  // rather than onto it. So `>=` and `>` cannot be told apart from outside,
  // and this test does not claim to - an earlier version's name promised
  // "from FOG_MAX_SPEED_KMH upwards" while its fixture sat four
  // quadrillionths above the line and passed under either operator.
  //
  // What is worth pinning is the pair either operator must agree on: the
  // closest speed above the threshold refuses, the closest below reveals,
  // and both sides are asserted against CONFIG rather than against a
  // hard-coded 30, so moving the constant moves the test with it.
  it('refuses just above FOG_MAX_SPEED_KMH and reveals just below it', async () => {
    const cookie = await registerUser();
    const atThresholdMs = CONFIG.FOG_MAX_SPEED_KMH / 3.6;

    // The fixture is above the line, not on it - assert that rather than
    // assume it, since it is a float round-trip and not a chosen value.
    expect(atThresholdMs * 3.6).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);
    const above = await postSamples(cookie, [goodSample({ speed: atThresholdMs })]);
    expect(above.json().tooFastToReveal).toBe(true);
    expect(above.json().newCells).toBe(0);

    const belowMs = atThresholdMs * 0.99;
    expect(belowMs * 3.6).toBeLessThan(CONFIG.FOG_MAX_SPEED_KMH);
    const below = await postSamples(cookie, [
      goodSample({ speed: belowMs, timestamp: Date.now() }),
    ]);
    expect(below.json().tooFastToReveal).toBe(false);
    expect(below.json().newCells).toBeGreaterThan(0);
  });

  // The case the client could not report on its own, and the reason this
  // verdict lives in the response at all (SPEC.md Section 7.3): the fix
  // carries no speed, so the server derives one from the previous accepted
  // sample — a position the browser does not keep.
  it('reports a speed it derived itself for a sample the device gave no speed for', async () => {
    const cookie = await registerUser();
    const startedAt = Date.now();
    const first = await postSamples(cookie, [
      goodSample({ speed: null, timestamp: startedAt - 10_000 }),
    ]);
    // Nothing to derive from and no speed on the sample: it reveals, and no
    // refusal is reported.
    expect(first.json()).toMatchObject({ tooFastToReveal: false });
    expect(first.json().newCells).toBeGreaterThan(0);

    // 200 m in 10 s is 72 km/h: above FOG_MAX_SPEED_KMH and well below
    // SAMPLE_TELEPORT_SPEED_KMH, so the sample is accepted and then refused
    // a reveal.
    const impliedKmh = (200 / 10) * 3.6;
    expect(impliedKmh).toBeGreaterThan(CONFIG.FOG_MAX_SPEED_KMH);
    expect(impliedKmh).toBeLessThan(CONFIG.SAMPLE_TELEPORT_SPEED_KMH);

    const moved = offsetMeters(SCHLOSS, 200);
    const second = await postSamples(cookie, [
      goodSample({ ...moved, speed: null, timestamp: startedAt }),
    ]);

    expect(second.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: true,
      rejected: rejected(),
    });
  });

  // SPEC.md Section 7.3's mixed-batch rule: the last accepted sample decides,
  // because the message it feeds is present tense. Both directions, since a
  // rule of "any sample in the batch" passes the first half and fails here.
  it('lets the last accepted sample of a mixed batch decide the speed verdict', async () => {
    const arrivingCookie = await registerUser('arriving');
    const startedAt = Date.now();

    // Fast, then slow: the player got off the train, and by the end of the
    // batch was walking. Nothing should be said about the train.
    const arriving = await postSamples(arrivingCookie, [
      goodSample({ speed: 10, timestamp: startedAt - 20_000 }),
      goodSample({ speed: 0, timestamp: startedAt - 10_000 }),
    ]);
    expect(arriving.json().tooFastToReveal).toBe(false);
    expect(arriving.json().newCells).toBeGreaterThan(0);

    // Slow, then fast: the same two samples the other way round. The player
    // is moving now, so the message is owed to them now.
    const leavingCookie = await registerUser('leaving');
    const leaving = await postSamples(leavingCookie, [
      goodSample({ speed: 0, timestamp: startedAt - 20_000 }),
      goodSample({ speed: 10, timestamp: startedAt - 10_000 }),
    ]);
    expect(leaving.json().tooFastToReveal).toBe(true);
    // The slow sample still revealed: the verdict reports the batch's last
    // accepted sample, it does not undo what an earlier one did.
    expect(leaving.json().newCells).toBeGreaterThan(0);
  });

  it('discards a sample with accuracy worse than FOG_MAX_ACCURACY_M entirely', async () => {
    const cookie = await registerUser();
    const badAccuracy = CONFIG.FOG_MAX_ACCURACY_M + 1;

    const response = await postSamples(cookie, [goodSample({ accuracy: badAccuracy })]);

    expect(response.statusCode).toBe(200);
    // No sample was accepted, so nothing was refused for speed either: the
    // verdict is not entitled to assert a speed no sample established.
    expect(response.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: rejected({ accuracy: 1 }),
    });
  });

  // SPEC.md Section 7.2 step 2's first clause — "discard if `timestamp` is
  // more than SAMPLE_MAX_CLOCK_SKEW_MS in the future". The staleness half of
  // the same step is covered by routes/visit-samples.test.ts; these four are
  // the future-dated half, which nothing tested until v1.58 and which would
  // have survived the whole guard being deleted.
  //
  // Every fixture below carries an accuracy of 10 m, well inside
  // FOG_MAX_ACCURACY_M: the accuracy gate runs *before* this one, so a
  // fixture with a bad accuracy would be discarded for the wrong reason and
  // these tests would pass while proving nothing.
  describe('the clock-skew guard', () => {
    // Far enough ahead that no plausible delay between this line and the
    // route's own Date.now() could bring it back inside the tolerance.
    const wellAheadMs = CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS + 60_000;

    it('discards a sample dated further ahead than SAMPLE_MAX_CLOCK_SKEW_MS', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ accuracy: 10, timestamp: Date.now() + wellAheadMs }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        newCells: 0,
        newBars: [],
        visitUpdates: [],
        tooFastToReveal: false,
        rejected: rejected({ future: 1 }),
      });

      // Not merely absent from the response: nothing was written either.
      const fogResponse = await injectWithOrigin({
        method: 'GET',
        url: '/api/fog',
        headers: { cookie },
      });
      const progress = JSON.parse(fogResponse.headers['x-fog-progress'] as string);
      expect(progress.revealedCells).toBe(0);
    });

    // The consequence worth asserting, and the one a "no cells revealed"
    // test misses: a discarded sample must not become the previous accepted
    // position, or it would poison the teleport guard the *next* sample is
    // measured against and refuse a perfectly good fix.
    //
    // The control half is what makes this falsifiable. The same far-away
    // fixture, posted with a present timestamp, is accepted and does refuse
    // the sample that follows it — so the pair shows the position is inside
    // the bounding box, that the jump really is a teleport, and that the
    // only difference between the two halves is the clock-skew guard.
    it('does not let a discarded future-dated sample poison the teleport guard', async () => {
      // ~1.4 km from SCHLOSS and still inside Karlsruhe's bounding box, the
      // same fixture the teleport test above uses. Posted milliseconds
      // before the SCHLOSS sample, it implies a speed far above
      // SAMPLE_TELEPORT_SPEED_KMH whichever way round the two timestamps
      // fall.
      const FAR_AWAY = { lat: 49.02, lon: 8.42 };

      const controlCookie = await registerUser('control');
      const accepted = await postSamples(controlCookie, [
        goodSample({ ...FAR_AWAY, accuracy: 10, timestamp: Date.now() }),
      ]);
      expect(accepted.json().newCells).toBeGreaterThan(0);
      const afterAccepted = await postSamples(controlCookie, [
        goodSample({ accuracy: 10, timestamp: Date.now() }),
      ]);
      expect(afterAccepted.json().newCells).toBe(0);

      const cookie = await registerUser('unpoisoned');
      const discarded = await postSamples(cookie, [
        goodSample({ ...FAR_AWAY, accuracy: 10, timestamp: Date.now() + wellAheadMs }),
      ]);
      expect(discarded.json().newCells).toBe(0);

      const afterDiscarded = await postSamples(cookie, [
        goodSample({ accuracy: 10, timestamp: Date.now() }),
      ]);
      expect(afterDiscarded.json().newCells).toBeGreaterThan(0);
    });

    // Without this one the tolerance could be tightened to zero and nothing
    // would notice — and a phone a few seconds fast is the ordinary case the
    // tolerance exists for.
    it('accepts a sample dated inside SAMPLE_MAX_CLOCK_SKEW_MS', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ accuracy: 10, timestamp: Date.now() + CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS / 2 }),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.json().newCells).toBeGreaterThan(0);
    });

    // The boundary, pinned as the code actually has it: the comparison is
    // `skewMs > CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS`, so a skew of exactly the
    // tolerance is *accepted* and one millisecond more is not.
    //
    // The clock has to be frozen for this and for nothing else in this file.
    // `nowMs` is the route's own Date.now(), so with a real clock the
    // milliseconds that pass between building the fixture and the route
    // reading the time make the skew strictly smaller than the tolerance —
    // which is accepted under `>` and under `>=` alike, and would leave the
    // boundary untested while looking tested. Only Date is faked, so the
    // timers the server and this test await are the real ones.
    describe('at exactly the tolerance, on a frozen clock', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('accepts a skew of exactly SAMPLE_MAX_CLOCK_SKEW_MS and refuses one millisecond more', async () => {
        // Two users, because the second sample must reveal cells of its own
        // rather than re-reveal the first one's.
        const atLimitCookie = await registerUser('at-the-limit');
        const overLimitCookie = await registerUser('over-the-limit');

        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.now();

        const atLimit = await postSamples(atLimitCookie, [
          goodSample({ accuracy: 10, timestamp: now + CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS }),
        ]);
        expect(atLimit.json().newCells).toBeGreaterThan(0);

        const overLimit = await postSamples(overLimitCookie, [
          goodSample({ accuracy: 10, timestamp: now + CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS + 1 }),
        ]);
        expect(overLimit.json()).toEqual({
          newCells: 0,
          newBars: [],
          visitUpdates: [],
          tooFastToReveal: false,
          rejected: rejected({ future: 1 }),
        });
      });
    });
  });

  it('discards a sample outside the active city bounding box', async () => {
    const cookie = await registerUser();

    const response = await postSamples(cookie, [
      goodSample({ lat: OUTSIDE_BBOX.lat, lon: OUTSIDE_BBOX.lon }),
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: rejected({ outsideCity: 1 }),
    });
  });

  it('rejects a teleport between two accepted samples', async () => {
    const cookie = await registerUser();
    const first = goodSample({ timestamp: Date.now() });
    const firstResponse = await postSamples(cookie, [first]);
    expect(firstResponse.json().newCells).toBeGreaterThan(0);

    // ~1.4 km from Schloss, posted immediately after — far above
    // SAMPLE_TELEPORT_SPEED_KMH (300) for any realistic elapsed wall time.
    const teleported = goodSample({ lat: 49.02, lon: 8.42, timestamp: Date.now() });
    const secondResponse = await postSamples(cookie, [teleported]);

    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: rejected({ tooFast: 1 }),
    });
  });

  it('does not double-count revealing the same cell twice', async () => {
    const cookie = await registerUser();

    const first = await postSamples(cookie, [goodSample()]);
    const firstNewCells = first.json().newCells;
    expect(firstNewCells).toBeGreaterThan(0);

    const second = await postSamples(cookie, [goodSample({ timestamp: Date.now() })]);
    expect(second.json()).toEqual({
      newCells: 0,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: rejected(),
    });

    const fogResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    const progress = JSON.parse(fogResponse.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(firstNewCells);
  });

  // SPEC.md Section 9.6's `rejected`: one count per gate of Section 7.2, for
  // the samples of this request only.
  //
  // One test per gate, each posting a batch that fails THAT gate and no
  // other, and each asserting all five counts rather than the one it is
  // about. Asserting only the count under test would pass on an
  // implementation that incremented every counter, and asserting only that
  // "some rejection happened" would pass on one that incremented the wrong
  // one — which is the single most likely way this feature is wrong, because
  // the five increments sit on five neighbouring `continue`s that differ by
  // one identifier.
  //
  // The bodies of the gate tests above already carry these counts, since
  // every exact-body assertion in this file does. These are here all the same
  // and are deliberately not folded into them: those tests are about what the
  // gate does to the fog, they would still be worth having if `rejected` did
  // not exist, and a gate whose fog behaviour is asserted somewhere other
  // than this file (staleness, in routes/visit-samples.test.ts) would
  // otherwise have no count asserted here at all.
  describe('the rejected counts', () => {
    it('counts a sample refused for accuracy, and nothing else', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M + 1 }),
      ]);

      expect(response.json().rejected).toEqual(rejected({ accuracy: 1 }));
    });

    it('counts a future-dated sample as future, and nothing else', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ timestamp: Date.now() + CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS + 60_000 }),
      ]);

      expect(response.json().rejected).toEqual(rejected({ future: 1 }));
    });

    // The other half of Section 7.2 step 2. `stale` and `future` are separate
    // counts of one step, and this pair is what tells them apart: the two
    // fixtures differ only in the sign of the offset, so an implementation
    // that incremented `stale` where `future` belongs fails exactly one of
    // them.
    it('counts a stale sample as stale, and nothing else', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ timestamp: Date.now() - CONFIG.SAMPLE_MAX_AGE_MS - 60_000 }),
      ]);

      expect(response.json().rejected).toEqual(rejected({ stale: 1 }));
    });

    it('counts a sample outside the bounding box as outsideCity, and nothing else', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [
        goodSample({ lat: OUTSIDE_BBOX.lat, lon: OUTSIDE_BBOX.lon }),
      ]);

      expect(response.json().rejected).toEqual(rejected({ outsideCity: 1 }));
    });

    // Section 7.2 step 4's teleport guard, which needs a previous accepted
    // sample to measure against — so the first post seeds it and the second
    // is the one under test.
    it('counts a sample refused by the teleport guard as tooFast, and nothing else', async () => {
      const cookie = await registerUser();
      const seed = await postSamples(cookie, [goodSample({ timestamp: Date.now() })]);
      expect(seed.json().rejected).toEqual(rejected());

      const response = await postSamples(cookie, [
        goodSample({ lat: 49.02, lon: 8.42, timestamp: Date.now() }),
      ]);

      expect(response.json().rejected).toEqual(rejected({ tooFast: 1 }));
    });

    // `tooFast` is Section 7.2 step 4's guard and NOT Section 7.3's
    // reveal-speed gate, and the two are easy to conflate because both are
    // about speed and one of them is even reported in the same body. A sample
    // above FOG_MAX_SPEED_KMH is ACCEPTED — it discovers bars and advances
    // visits — and merely reveals nothing, so it is refused by no gate and
    // counted nowhere. `tooFastToReveal: true` beside five zeroes is the
    // whole distinction, and this is the only test that states it.
    it('does not count a sample refused a reveal for speed as rejected at all', async () => {
      const cookie = await registerUser();

      const response = await postSamples(cookie, [goodSample({ speed: 10 })]);

      expect(response.json().tooFastToReveal).toBe(true);
      expect(response.json().rejected).toEqual(rejected());
    });

    // The counts are a partition of the batch: every sample the request did
    // not accept is counted exactly once, under exactly one gate. Six
    // samples, five of them failing one gate each, and the sum is five.
    //
    // "One accepted" is not taken on trust from the arithmetic either. The
    // control user posts the accepted sample alone, and the two reveals match
    // cell for cell — which they could not if the mixed batch had accepted
    // the far-away sample too, since that one is 1.4 km away and reveals a
    // different circle.
    it('counts every refused sample of a mixed batch exactly once', async () => {
      const cookie = await registerUser();
      const controlCookie = await registerUser('control');
      const now = Date.now();

      // Ordering within a batch is by client timestamp (Section 7.2 step 2),
      // so these are written in the order the loop will see them: the
      // accepted sample first among the ones that matter, because the
      // teleport guard needs it to measure the jump against.
      const accepted = goodSample({ timestamp: now - 5_000 });
      const samples = [
        goodSample({ timestamp: now - CONFIG.SAMPLE_MAX_AGE_MS - 60_000 }),
        accepted,
        // 1.4 km from the Schloss, one millisecond later.
        goodSample({ lat: 49.02, lon: 8.42, timestamp: now - 4_999 }),
        goodSample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M + 1, timestamp: now - 4_000 }),
        goodSample({ lat: OUTSIDE_BBOX.lat, lon: OUTSIDE_BBOX.lon, timestamp: now - 3_000 }),
        goodSample({ timestamp: now + CONFIG.SAMPLE_MAX_CLOCK_SKEW_MS + 60_000 }),
      ];

      const response = await postSamples(cookie, samples);
      const body = response.json();

      expect(body.rejected).toEqual({
        accuracy: 1,
        future: 1,
        stale: 1,
        outsideCity: 1,
        tooFast: 1,
      });
      const counts: number[] = Object.values(body.rejected);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(samples.length - 1);

      const control = await postSamples(controlCookie, [accepted]);
      expect(control.json().newCells).toBeGreaterThan(0);
      expect(body.newCells).toBe(control.json().newCells);
    });
  });

  it('caps a batch over SAMPLE_MAX_BATCH with a 400', async () => {
    const cookie = await registerUser();
    const samples = Array.from({ length: CONFIG.SAMPLE_MAX_BATCH + 1 }, () => goodSample());

    const response = await postSamples(cookie, samples);

    expect(response.statusCode).toBe(400);
  });

  it('returns 429 once the samples rate limit is exceeded', async () => {
    const cookie = await registerUser();
    const limit = CONFIG.RATE_LIMITS.samples.limit;

    for (let i = 0; i < limit; i++) {
      await postSamples(cookie, []);
    }
    const blocked = await postSamples(cookie, []);

    expect(blocked.statusCode).toBe(429);
  });

  it('fog_daily_progress sums to fog_state.revealed_cells for the user', async () => {
    const cookie = await registerUser();
    await postSamples(cookie, [goodSample()]);

    const userId = db
      .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
      .get(validRegisterBody.username)!.id;

    const fogState = db
      .prepare<[number], { revealed_cells: number }>(
        'SELECT revealed_cells FROM fog_state WHERE user_id = ?',
      )
      .get(userId)!;

    const dailySum = db
      .prepare<[number], { total: number | null }>(
        'SELECT SUM(revealed_cells) AS total FROM fog_daily_progress WHERE user_id = ?',
      )
      .get(userId)!;

    expect(dailySum.total).toBe(fogState.revealed_cells);
  });

  it('never stores anything resembling the submitted raw coordinates', async () => {
    const cookie = await registerUser();
    await postSamples(cookie, [goodSample(), goodSample({ lat: 49.014, lon: 8.405 })]);

    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    const suspects = [SCHLOSS.lat, SCHLOSS.lon, 49.014, 8.405];

    for (const table of tables) {
      const rows = db.prepare(`SELECT * FROM "${table.name}"`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === 'number') {
            for (const suspect of suspects) {
              expect(
                Math.abs(value - suspect) < 1e-6,
                `${table.name}.${column} = ${value} looks like a raw coordinate (${suspect})`,
              ).toBe(false);
            }
          }
          if (typeof value === 'string') {
            for (const suspect of suspects) {
              expect(
                value.includes(String(suspect)),
                `${table.name}.${column} contains a raw coordinate substring (${suspect})`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe('GET /api/fog', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/fog' });
    expect(response.statusCode).toBe(401);
  });

  it('returns an all-zero mask of the right size for a user who never walked', async () => {
    const cookie = await registerUser();

    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    // 417 x 343 cells (SPEC.md Section 6.2), one bit per cell.
    expect(response.rawPayload.length).toBe(Math.ceil((417 * 343) / 8));
    expect(response.rawPayload.every((byte: number) => byte === 0)).toBe(true);

    const progress = JSON.parse(response.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(0);
    expect(progress.districts).toHaveLength(27);
  });

  it('carries the no-store cache header like every other /api response', async () => {
    const cookie = await registerUser();
    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  it('the mask survives across a fresh app instance on the same database', async () => {
    const cookie = await registerUser();
    const postResponse = await postSamples(cookie, [goodSample()]);
    const revealed = postResponse.json().newCells;
    expect(revealed).toBeGreaterThan(0);

    const env = loadEnv(baseEnv);
    const app2 = buildApp(env, db);
    const response = await app2.inject({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie, origin: baseEnv.PUBLIC_ORIGIN },
    });

    expect(response.statusCode).toBe(200);
    const progress = JSON.parse(response.headers['x-fog-progress'] as string);
    expect(progress.revealedCells).toBe(revealed);
  });
});

describe('GET /api/progress', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/progress' });
    expect(response.statusCode).toBe(401);
  });

  it('percentages match a hand-computed reference from grid-meta.json', async () => {
    const cookie = await registerUser();
    const postResponse = await postSamples(cookie, [goodSample()]);
    const newCells: number = postResponse.json().newCells;
    expect(newCells).toBeGreaterThan(0);

    const cityResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/city',
      headers: { cookie },
    });
    const city = cityResponse.json();

    const gridMeta = JSON.parse(
      readFileSync(join(REAL_SEED_DIR, 'karlsruhe', 'grid-meta.json'), 'utf-8'),
    ) as {
      playable_cells: number;
      districts: { name: string; playable_cells: number }[];
    };

    const fogResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/fog',
      headers: { cookie },
    });
    const fogProgress = JSON.parse(fogResponse.headers['x-fog-progress'] as string) as {
      revealedCells: number;
      districts: { id: number; revealedCells: number }[];
    };
    expect(fogProgress.revealedCells).toBe(newCells);

    const touchedDistrict = fogProgress.districts.find((d) => d.revealedCells > 0);
    expect(touchedDistrict).toBeDefined();
    const districtInCity = city.districts.find((d: { id: number }) => d.id === touchedDistrict!.id);
    expect(districtInCity).toBeDefined();
    const districtMeta = gridMeta.districts.find((d) => d.name === districtInCity.name);
    expect(districtMeta).toBeDefined();

    // Every revealed cell landed in this one district — SCHLOSS's reveal
    // circle is verified (see the SCHLOSS comment above) to fall entirely
    // inside a single district.
    expect(touchedDistrict!.revealedCells).toBe(newCells);

    const expectedCityPercent = (newCells / gridMeta.playable_cells) * 100;
    const expectedDistrictPercent = (newCells / districtMeta!.playable_cells) * 100;

    const progressResponse = await injectWithOrigin({
      method: 'GET',
      url: '/api/progress',
      headers: { cookie },
    });
    const progress = progressResponse.json();

    expect(progress.city.revealedCells).toBe(newCells);
    expect(progress.city.playableCells).toBe(gridMeta.playable_cells);
    expect(progress.city.percent).toBeCloseTo(expectedCityPercent, 10);

    const progressDistrict = progress.districts.find(
      (d: { id: number }) => d.id === touchedDistrict!.id,
    );
    expect(progressDistrict.revealedCells).toBe(newCells);
    expect(progressDistrict.playableCells).toBe(districtMeta!.playable_cells);
    expect(progressDistrict.percent).toBeCloseTo(expectedDistrictPercent, 10);
  });

  it('carries the no-store cache header like every other /api response', async () => {
    const cookie = await registerUser();
    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/progress',
      headers: { cookie },
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });

  // SPEC.md Section 7.6's two bar figures, which this route answers so that
  // the start screen (Section 8.3) does not have to fetch every discovered
  // bar to count two integers.
  //
  // The fixtures here are deliberately not "one user, one city": a
  // `COUNT(*)` that forgot either scope answers correctly in that fixture
  // and wrongly in a real database, and those are the two failures a careless
  // implementation actually has.
  describe('the two bar counts', () => {
    function userIdOf(username: string): number {
      return db
        .prepare<[string], { id: number }>('SELECT id FROM users WHERE username = ?')
        .get(username)!.id;
    }

    function activeCityId(): number {
      return db.prepare<[], { id: number }>('SELECT id FROM cities WHERE is_active = 1').get()!.id;
    }

    // A second city row, inactive, so `loadActiveCity` still answers
    // Karlsruhe and a bar hung off this one is a bar in another city.
    function insertOtherCity(): number {
      const result = db
        .prepare(
          `INSERT INTO cities
             (slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m,
              playable_cells, is_active)
           VALUES ('mannheim', 'Mannheim', 49.4, 8.4, 10, 10, 50, 100, 0)`,
        )
        .run();
      return Number(result.lastInsertRowid);
    }

    function insertBar(
      name: string,
      options: { cityId?: number; status?: 'active' | 'hidden' } = {},
    ): number {
      const result = db
        .prepare(
          `INSERT INTO bars
             (city_id, district_id, name, address, lat, lon, cell_index, source, status, created_at)
           VALUES (?, NULL, ?, NULL, ?, ?, 0, 'osm', ?, 0)`,
        )
        .run(
          options.cityId ?? activeCityId(),
          name,
          SCHLOSS.lat,
          SCHLOSS.lon,
          options.status ?? 'active',
        );
      return Number(result.lastInsertRowid);
    }

    function discover(username: string, barId: number): void {
      db.prepare(
        'INSERT INTO bar_discoveries (user_id, bar_id, discovered_at) VALUES (?, ?, 0)',
      ).run(userIdOf(username), barId);
    }

    // Section 5.7's definition: a `visits` row with `status = 'completed'`.
    // `status` is a parameter so the tests can show that the other three
    // master nothing.
    function insertVisit(
      username: string,
      barId: number,
      status: 'pending' | 'completed' | 'expired' | 'cancelled',
    ): void {
      db.prepare(
        `INSERT INTO visits
           (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status, completed_at)
         VALUES (?, ?, 0, 100, 2, 100, ?, ?)`,
      ).run(userIdOf(username), barId, status, status === 'completed' ? 100 : null);
    }

    async function progressOf(cookie: string): Promise<{
      barsDiscovered: number;
      barsMastered: number;
    }> {
      const response = await injectWithOrigin({
        method: 'GET',
        url: '/api/progress',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      return response.json().city;
    }

    it('are zero for a player who has discovered nothing', async () => {
      const cookie = await registerUser('walker');
      insertBar('Undiscovered Bar');

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 0, barsMastered: 0 });
    });

    it('counts a discovered bar as discovered and not as mastered', async () => {
      const cookie = await registerUser('walker');
      discover('walker', insertBar('Zum Schlossgarten'));

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 1, barsMastered: 0 });
    });

    it('counts a bar with a completed visit as mastered, and only that one', async () => {
      const cookie = await registerUser('walker');
      const mastered = insertBar('Zum Schlossgarten');
      const merelyFound = insertBar('Kneipe am Eck');
      discover('walker', mastered);
      discover('walker', merelyFound);
      insertVisit('walker', mastered, 'completed');

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 2, barsMastered: 1 });
    });

    it.each(['pending', 'expired', 'cancelled'] as const)(
      'does not count a visit with status %s as mastery',
      async (status) => {
        const cookie = await registerUser('walker');
        const barId = insertBar('Zum Schlossgarten');
        discover('walker', barId);
        insertVisit('walker', barId, status);

        expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 1, barsMastered: 0 });
      },
    );

    // The scope a single-city fixture cannot see. The area figures beside
    // these two are the active city's; a bar somewhere else must not be
    // counted into them.
    it('counts neither figure for a bar in another city', async () => {
      const cookie = await registerUser('walker');
      const here = insertBar('Zum Schlossgarten');
      const elsewhere = insertBar('Mannheimer Bar', { cityId: insertOtherCity() });
      discover('walker', here);
      discover('walker', elsewhere);
      insertVisit('walker', here, 'completed');
      insertVisit('walker', elsewhere, 'completed');

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 1, barsMastered: 1 });
    });

    // The scope a single-user fixture cannot see, and the one that would
    // leak another player's play into this player's screen.
    it('counts neither figure for another player’s discoveries and mastery', async () => {
      const cookie = await registerUser('walker');
      const otherCookie = await registerUser('stranger');
      const mine = insertBar('Zum Schlossgarten');
      const theirs = insertBar('Kneipe am Eck');
      discover('walker', mine);
      discover('stranger', mine);
      discover('stranger', theirs);
      insertVisit('stranger', mine, 'completed');
      insertVisit('stranger', theirs, 'completed');

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 1, barsMastered: 0 });
      expect(await progressOf(otherCookie)).toMatchObject({ barsDiscovered: 2, barsMastered: 2 });
    });

    // Section 5.7: a hidden bar leaves play, and `GET /api/bars` stops
    // returning it. These figures sit under the same rule, so the start
    // screen cannot claim more bars than the map draws.
    it('leaves a hidden bar out of both figures, exactly as GET /api/bars does', async () => {
      const cookie = await registerUser('walker');
      const visible = insertBar('Zum Schlossgarten');
      const hidden = insertBar('Hidden Dive Bar', { status: 'hidden' });
      discover('walker', visible);
      discover('walker', hidden);
      insertVisit('walker', hidden, 'completed');

      expect(await progressOf(cookie)).toMatchObject({ barsDiscovered: 1, barsMastered: 0 });

      const barsResponse = await injectWithOrigin({
        method: 'GET',
        url: '/api/bars',
        headers: { cookie },
      });
      expect(barsResponse.json().bars).toHaveLength(1);
    });
  });
});
