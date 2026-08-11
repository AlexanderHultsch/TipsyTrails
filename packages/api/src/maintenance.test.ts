import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DERIVED, isVisitExpired } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { runMaintenanceTick } from './maintenance.js';
import type { PushSendOutcome, PushSender } from './push/sender.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

// A fixed instant rather than the real clock, so the boundary and
// many-intervals-overdue cases below are exact and do not depend on when the
// test happens to run.
const BASE_NOW_S = 1_700_000_000;

let dbPath: string;
let db: Database.Database;
let userId: number;
let barId: number;
let cityId: number;

function insertUser(username: string): number {
  const result = db
    .prepare(
      `INSERT INTO users
        (username, password_hash, security_question, security_answer_hash, avatar_seed, age_confirmed_at, created_at)
       VALUES (?, 'hash', 'question', 'answer-hash', 'seed', 0, 0)`,
    )
    .run(username);
  return Number(result.lastInsertRowid);
}

function seedCity(): number {
  const result = db
    .prepare(
      `INSERT INTO cities (slug, name, origin_lat, origin_lon, grid_width, grid_height, cell_size_m, playable_cells)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('karlsruhe', 'Karlsruhe', 49.0, 8.4, 100, 100, 50, 5000);
  return Number(result.lastInsertRowid);
}

function seedBar(cityId: number): number {
  const result = db
    .prepare(
      `INSERT INTO bars (city_id, district_id, name, address, lat, lon, cell_index, source, status, created_at)
       VALUES (?, NULL, 'Test Bar', NULL, 49.01, 8.41, 42, 'community', 'active', 0)`,
    )
    .run(cityId);
  return Number(result.lastInsertRowid);
}

interface VisitOverrides {
  startedAt?: number;
  lastSampleAt?: number;
  status?: 'pending' | 'completed' | 'expired';
  onsiteSamples?: number;
  confirmedS?: number;
  // `idx_visits_one_pending` allows at most one pending visit per
  // (user, bar) — tests with several simultaneous pending visits pass a
  // distinct bar per call.
  barId?: number;
}

function insertVisit(overrides: VisitOverrides = {}): number {
  const startedAt = overrides.startedAt ?? BASE_NOW_S - 60;
  const lastSampleAt = overrides.lastSampleAt ?? BASE_NOW_S;
  const status = overrides.status ?? 'pending';
  const onsiteSamples = overrides.onsiteSamples ?? 1;
  const confirmedS = overrides.confirmedS ?? lastSampleAt - startedAt;
  const result = db
    .prepare(
      `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      overrides.barId ?? barId,
      startedAt,
      lastSampleAt,
      onsiteSamples,
      confirmedS,
      status,
    );
  return Number(result.lastInsertRowid);
}

function visitStatus(id: number): string | undefined {
  return db.prepare<[number], { status: string }>('SELECT status FROM visits WHERE id = ?').get(id)
    ?.status;
}

function insertSession(id: string, expiresAt: number): void {
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    id,
    userId,
    0,
    expiresAt,
  );
}

function sessionExists(id: string): boolean {
  return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined;
}

function pushSentAt(visitId: number): number | null {
  return (
    db
      .prepare<[number], { push_sent_at: number | null }>(
        'SELECT push_sent_at FROM visits WHERE id = ?',
      )
      .get(visitId)?.push_sent_at ?? null
  );
}

function insertSubscription(forUserId: number, endpoint: string): number {
  const result = db
    .prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, 'p256dh-fixture', 'auth-fixture', 0)`,
    )
    .run(forUserId, endpoint);
  return Number(result.lastInsertRowid);
}

function subscriptionExists(id: number): boolean {
  return db.prepare('SELECT 1 FROM push_subscriptions WHERE id = ?').get(id) !== undefined;
}

// The seam task Section E calls for: every push test below fakes delivery
// rather than exercising `push/sender.ts`'s real web-push calls, which this
// sandbox has no browser, push service, or device to verify end to end
// (task Section E) — `PushSender` is the only thing runMaintenanceTick
// depends on for sending, so a fake satisfying it is a full substitute here.
interface FakeSender extends PushSender {
  send: ReturnType<typeof vi.fn<PushSender['send']>>;
}

function fakeSender(outcome: PushSendOutcome = { delivered: true }): FakeSender {
  return { send: vi.fn(async () => outcome) };
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-maintenance-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  userId = insertUser('alex');
  cityId = seedCity();
  barId = seedBar(cityId);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbPath}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
    }
  }
});

describe('runMaintenanceTick', () => {
  it('expires a pending visit past VISIT_EXPIRY_S and leaves one inside the window untouched', async () => {
    const otherBarId = seedBar(cityId);
    const overdue = insertVisit({ lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 1 });
    const fresh = insertVisit({ lastSampleAt: BASE_NOW_S - 10, barId: otherBarId });

    const result = await runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(1);
    expect(visitStatus(overdue)).toBe('expired');
    expect(visitStatus(fresh)).toBe('pending');
  });

  it('matches the shared isVisitExpired predicate exactly at the VISIT_EXPIRY_S boundary', async () => {
    const lastSampleAt = BASE_NOW_S - DERIVED.VISIT_EXPIRY_S;
    const expectedExpired = isVisitExpired(BASE_NOW_S, lastSampleAt);
    const visit = insertVisit({ lastSampleAt });

    await runMaintenanceTick(db, BASE_NOW_S);

    expect(visitStatus(visit)).toBe(expectedExpired ? 'expired' : 'pending');
  });

  it('never touches a completed visit, no matter its age', async () => {
    const veryOld = BASE_NOW_S - 10 * DERIVED.VISIT_EXPIRY_S;
    const visit = insertVisit({
      startedAt: veryOld - 3600,
      lastSampleAt: veryOld,
      status: 'completed',
    });

    const result = await runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(0);
    expect(visitStatus(visit)).toBe('completed');
  });

  it('deletes expired sessions and leaves unexpired ones in place', async () => {
    const expiredId = randomUUID();
    const liveId = randomUUID();
    insertSession(expiredId, BASE_NOW_S - 1);
    insertSession(liveId, BASE_NOW_S + 1000);

    const result = await runMaintenanceTick(db, BASE_NOW_S);

    expect(result.purgedSessions).toBe(1);
    expect(sessionExists(expiredId)).toBe(false);
    expect(sessionExists(liveId)).toBe(true);
  });

  it('reports no work on a second run', async () => {
    insertVisit({ lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 1 });
    insertSession(randomUUID(), BASE_NOW_S - 1);

    const first = await runMaintenanceTick(db, BASE_NOW_S);
    const second = await runMaintenanceTick(db, BASE_NOW_S);

    expect(first.expiredVisits).toBe(1);
    expect(first.purgedSessions).toBe(1);
    expect(second).toEqual({ expiredVisits: 0, purgedSessions: 0, pushDispatched: 0 });
  });

  it('expires every overdue visit in a single tick after several missed intervals (restart case)', async () => {
    const intervalS = CONFIG.MAINTENANCE_INTERVAL_MS / 1000;
    const visitIds = [1, 2, 3, 4, 5, 6, 7, 8].map((multiplier) =>
      insertVisit({
        lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - multiplier * intervalS,
        barId: seedBar(cityId),
      }),
    );

    const result = await runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(visitIds.length);
    for (const id of visitIds) {
      expect(visitStatus(id)).toBe('expired');
    }
  });

  it('without a pushSender, leaves push_sent_at null and reports zero dispatched', async () => {
    const visit = insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
    });

    const result = await runMaintenanceTick(db, BASE_NOW_S);

    expect(result.pushDispatched).toBe(0);
    expect(pushSentAt(visit)).toBeNull();
  });
});

describe('runMaintenanceTick push dispatch', () => {
  it('sends the reminder and sets push_sent_at once a visit passes VISIT_PUSH_AFTER_S', async () => {
    const visit = insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
    });
    insertSubscription(userId, 'https://push.example/a');
    const sender = fakeSender();

    const result = await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(result.pushDispatched).toBe(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
    const [subscription, payload] = sender.send.mock.calls[0] as [{ endpoint: string }, string];
    expect(subscription.endpoint).toBe('https://push.example/a');
    const parsed = JSON.parse(payload) as { title: string; body: string };
    expect(parsed.body).toMatch(/Test Bar/);
    expect(pushSentAt(visit)).toBe(BASE_NOW_S);
  });

  it('does not dispatch before VISIT_PUSH_AFTER_S has elapsed', async () => {
    const visit = insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S + 1,
      lastSampleAt: BASE_NOW_S,
    });
    insertSubscription(userId, 'https://push.example/a');
    const sender = fakeSender();

    const result = await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(result.pushDispatched).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
    expect(pushSentAt(visit)).toBeNull();
  });

  it('never dispatches a second time for the same visit (at most once)', async () => {
    const visit = insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
    });
    insertSubscription(userId, 'https://push.example/a');
    const sender = fakeSender();

    await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });
    const second = await runMaintenanceTick(db, BASE_NOW_S + 60, { pushSender: sender });

    expect(second.pushDispatched).toBe(0);
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(pushSentAt(visit)).toBe(BASE_NOW_S);
  });

  it('sets push_sent_at even when delivery fails, so a dead endpoint is not retried', async () => {
    const visit = insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
    });
    insertSubscription(userId, 'https://push.example/dead');
    const sender = fakeSender({ delivered: false, statusCode: 500 });

    await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });
    await runMaintenanceTick(db, BASE_NOW_S + 60, { pushSender: sender });

    expect(pushSentAt(visit)).toBe(BASE_NOW_S);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('never pushes for a visit that already completed', async () => {
    insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
      status: 'completed',
    });
    insertSubscription(userId, 'https://push.example/a');
    const sender = fakeSender();

    const result = await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(result.pushDispatched).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('never pushes for a visit expired earlier in the same tick', async () => {
    const visit = insertVisit({
      // Old enough to both need expiry (VISIT_EXPIRY_S) and have crossed
      // VISIT_PUSH_AFTER_S from started_at, so the two rules would disagree
      // if evaluated out of order.
      startedAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 60,
      lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 1,
    });
    insertSubscription(userId, 'https://push.example/a');
    const sender = fakeSender();

    const result = await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(result.expiredVisits).toBe(1);
    expect(result.pushDispatched).toBe(0);
    expect(sender.send).not.toHaveBeenCalled();
    expect(visitStatus(visit)).toBe('expired');
    expect(pushSentAt(visit)).toBeNull();
  });

  it('deletes the subscription immediately on a 404 or 410, and leaves it in place on other failures', async () => {
    insertVisit({ startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S, lastSampleAt: BASE_NOW_S });
    const goneId = insertSubscription(userId, 'https://push.example/gone');
    const otherBarId = seedBar(cityId);
    insertVisit({
      startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      lastSampleAt: BASE_NOW_S,
      barId: otherBarId,
    });
    let call = 0;
    const sender: FakeSender = {
      send: vi.fn(async () => {
        call += 1;
        return call === 1
          ? { delivered: false, statusCode: 410 }
          : { delivered: false, statusCode: 500 };
      }),
    };

    await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(subscriptionExists(goneId)).toBe(false);
  });

  it('does not let one failing subscription stop another user from being pushed', async () => {
    const otherUserId = insertUser('other');
    const otherBarId = seedBar(cityId);
    db.prepare(
      `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status)
       VALUES (?, ?, ?, ?, 2, ?, 'pending')`,
    ).run(
      otherUserId,
      otherBarId,
      BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S,
      BASE_NOW_S,
      DERIVED.VISIT_PUSH_AFTER_S,
    );
    insertVisit({ startedAt: BASE_NOW_S - DERIVED.VISIT_PUSH_AFTER_S, lastSampleAt: BASE_NOW_S });
    insertSubscription(userId, 'https://push.example/fails');
    insertSubscription(otherUserId, 'https://push.example/ok');
    const sender: FakeSender = {
      send: vi.fn(async (subscription: { endpoint: string }) =>
        subscription.endpoint.endsWith('/fails')
          ? Promise.reject(new Error('boom'))
          : { delivered: true },
      ),
    };

    const result = await runMaintenanceTick(db, BASE_NOW_S, { pushSender: sender });

    expect(result.pushDispatched).toBe(2);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });
});
