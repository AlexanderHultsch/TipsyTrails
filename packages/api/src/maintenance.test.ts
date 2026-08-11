import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, DERIVED, isVisitExpired } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { runMaintenanceTick } from './maintenance.js';

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
  it('expires a pending visit past VISIT_EXPIRY_S and leaves one inside the window untouched', () => {
    const otherBarId = seedBar(cityId);
    const overdue = insertVisit({ lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 1 });
    const fresh = insertVisit({ lastSampleAt: BASE_NOW_S - 10, barId: otherBarId });

    const result = runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(1);
    expect(visitStatus(overdue)).toBe('expired');
    expect(visitStatus(fresh)).toBe('pending');
  });

  it('matches the shared isVisitExpired predicate exactly at the VISIT_EXPIRY_S boundary', () => {
    const lastSampleAt = BASE_NOW_S - DERIVED.VISIT_EXPIRY_S;
    const expectedExpired = isVisitExpired(BASE_NOW_S, lastSampleAt);
    const visit = insertVisit({ lastSampleAt });

    runMaintenanceTick(db, BASE_NOW_S);

    expect(visitStatus(visit)).toBe(expectedExpired ? 'expired' : 'pending');
  });

  it('never touches a completed visit, no matter its age', () => {
    const veryOld = BASE_NOW_S - 10 * DERIVED.VISIT_EXPIRY_S;
    const visit = insertVisit({
      startedAt: veryOld - 3600,
      lastSampleAt: veryOld,
      status: 'completed',
    });

    const result = runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(0);
    expect(visitStatus(visit)).toBe('completed');
  });

  it('deletes expired sessions and leaves unexpired ones in place', () => {
    const expiredId = randomUUID();
    const liveId = randomUUID();
    insertSession(expiredId, BASE_NOW_S - 1);
    insertSession(liveId, BASE_NOW_S + 1000);

    const result = runMaintenanceTick(db, BASE_NOW_S);

    expect(result.purgedSessions).toBe(1);
    expect(sessionExists(expiredId)).toBe(false);
    expect(sessionExists(liveId)).toBe(true);
  });

  it('reports no work on a second run', () => {
    insertVisit({ lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - 1 });
    insertSession(randomUUID(), BASE_NOW_S - 1);

    const first = runMaintenanceTick(db, BASE_NOW_S);
    const second = runMaintenanceTick(db, BASE_NOW_S);

    expect(first.expiredVisits).toBe(1);
    expect(first.purgedSessions).toBe(1);
    expect(second).toEqual({ expiredVisits: 0, purgedSessions: 0 });
  });

  it('expires every overdue visit in a single tick after several missed intervals (restart case)', () => {
    const intervalS = CONFIG.MAINTENANCE_INTERVAL_MS / 1000;
    const visitIds = [1, 2, 3, 4, 5, 6, 7, 8].map((multiplier) =>
      insertVisit({
        lastSampleAt: BASE_NOW_S - DERIVED.VISIT_EXPIRY_S - multiplier * intervalS,
        barId: seedBar(cityId),
      }),
    );

    const result = runMaintenanceTick(db, BASE_NOW_S);

    expect(result.expiredVisits).toBe(visitIds.length);
    for (const id of visitIds) {
      expect(visitStatus(id)).toBe('expired');
    }
  });
});
