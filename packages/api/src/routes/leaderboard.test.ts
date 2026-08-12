import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  CONFIG,
} from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';
import { ANONYMOUS_AVATAR_SEED, anonymousDisplayName } from './anonymity.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

const baseEnv = {
  NODE_ENV: 'test',
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
};

const validRegisterBody = {
  password: 'correct horse battery staple',
  securityQuestion: 'First pet?',
  securityAnswer: 'Rex',
  ageConfirmed: true,
};

const PLAYABLE_CELLS = 5000;

let dbPath: string;
let db: Database.Database;
let app: FastifyInstance;
let cityId: number;

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

// Registers a real user through the HTTP API (argon2id hash and all) —
// used only for the one "viewer" whose session actually calls
// GET /api/leaderboard, and for any user a test also needs a session for
// (e.g. to exercise PATCH /api/settings). Competing users are seeded
// directly (insertUser below), the same split badges.test.ts and
// account.test.ts already make, so bulk fixtures do not pay for password
// hashing they never need.
async function registerUser(username: string): Promise<{ cookie: string; userId: number }> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return { cookie: extractSessionCookie(response), userId: response.json().id as number };
}

// Same shape as badges.test.ts's own insertUser — a user row with no real
// password, fine for a competitor who never logs in during the test.
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
    .run('karlsruhe', 'Karlsruhe', 49.0, 8.4, 100, 100, 50, PLAYABLE_CELLS);
  return Number(result.lastInsertRowid);
}

function seedBar(name: string): number {
  const result = db
    .prepare(
      `INSERT INTO bars (city_id, district_id, name, address, lat, lon, cell_index, source, status, created_at)
       VALUES (?, NULL, ?, NULL, 49.01, 8.41, 42, 'community', 'active', 0)`,
    )
    .run(cityId, name);
  return Number(result.lastInsertRowid);
}

function insertFogState(userId: number, revealedCells: number, updatedAtS: number): void {
  db.prepare(
    `INSERT INTO fog_state (user_id, city_id, mask, revealed_cells, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, cityId, Buffer.from([0]), revealedCells, updatedAtS);
}

function insertDailyProgress(userId: number, day: string, revealedCells: number): void {
  db.prepare(
    `INSERT INTO fog_daily_progress (user_id, city_id, day, revealed_cells) VALUES (?, ?, ?, ?)`,
  ).run(userId, cityId, day, revealedCells);
}

function insertCompletedVisit(userId: number, barId: number, completedAtS: number): void {
  db.prepare(
    `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status, completed_at)
     VALUES (?, ?, ?, ?, 2, 1200, 'completed', ?)`,
  ).run(userId, barId, completedAtS - 1200, completedAtS, completedAtS);
}

function insertBadge(userId: number, kind: string, period: string, periodKey: string): void {
  db.prepare(
    `INSERT INTO badges (user_id, kind, period, period_key, value, awarded_at) VALUES (?, ?, ?, ?, 1, 0)`,
  ).run(userId, kind, period, periodKey);
}

function getLeaderboard(cookie: string, query = ''): Promise<LightMyRequestResponse> {
  return injectWithOrigin({ method: 'GET', url: `/api/leaderboard${query}`, headers: { cookie } });
}

interface LeaderboardEntry {
  rank: number;
  userId: number;
  displayName: string;
  isAnonymous: boolean;
  avatarSeed: string;
  value: number;
  badges: unknown[];
}

function entryFor(response: LightMyRequestResponse, userId: number): LeaderboardEntry {
  const entry = (response.json().entries as LeaderboardEntry[]).find((e) => e.userId === userId);
  if (!entry) {
    throw new Error(`expected an entry for user ${userId}`);
  }
  return entry;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-leaderboard-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  cityId = seedCity();
  app = buildApp(loadEnv(baseEnv), db);
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

describe('GET /api/leaderboard', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/leaderboard' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown metric, period, and non-positive page with 400', async () => {
    const { cookie } = await registerUser('viewer');

    const badMetric = await getLeaderboard(cookie, '?metric=speed');
    const badPeriod = await getLeaderboard(cookie, '?period=year');
    const badPage = await getLeaderboard(cookie, '?page=0');

    expect(badMetric.statusCode).toBe(400);
    expect(badPeriod.statusCode).toBe(400);
    expect(badPage.statusCode).toBe(400);
  });

  it('defaults to metric=area and period=all', async () => {
    const { cookie, userId } = await registerUser('viewer');
    insertFogState(userId, 100, 1000);

    const response = await getLeaderboard(cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ metric: 'area', period: 'all', page: 1 });
  });
});

describe('ranking — area metric', () => {
  it('all-time: ranks by fog_state.revealed_cells / playable_cells, matching a hand-computed percent', async () => {
    const { cookie, userId: viewerId } = await registerUser('viewer');
    const loId = insertUser('lo');
    const hiId = insertUser('hi');
    insertFogState(viewerId, 0, 1000);
    insertFogState(loId, 50, 1000);
    insertFogState(hiId, 250, 1000);

    const response = await getLeaderboard(cookie, '?metric=area&period=all');

    expect(response.statusCode).toBe(200);
    expect(entryFor(response, hiId).value).toBeCloseTo((250 / PLAYABLE_CELLS) * 100);
    expect(entryFor(response, loId).value).toBeCloseTo((50 / PLAYABLE_CELLS) * 100);
    expect(entryFor(response, viewerId).value).toBe(0);
    const order = (response.json().entries as LeaderboardEntry[]).map((e) => e.userId);
    expect(order.indexOf(hiId)).toBeLessThan(order.indexOf(loId));
    expect(order.indexOf(loId)).toBeLessThan(order.indexOf(viewerId));
  });

  it('week: sums fog_daily_progress over the current ISO week only, matching a hand-computed percent', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const weekKey = badgePeriodKey('week', Date.now());
    const days = badgePeriodDays('week', weekKey);
    insertDailyProgress(userId, days[0], 30);
    insertDailyProgress(userId, days[1], 20);
    // Outside the current week entirely — must not be summed in.
    insertDailyProgress(userId, '2020-01-01', 9999);

    const response = await getLeaderboard(cookie, '?metric=area&period=week');

    expect(response.statusCode).toBe(200);
    expect(entryFor(response, userId).value).toBeCloseTo(((30 + 20) / PLAYABLE_CELLS) * 100);
  });

  it('month: sums fog_daily_progress over the current month only, matching a hand-computed percent', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const monthKey = badgePeriodKey('month', Date.now());
    const days = badgePeriodDays('month', monthKey);
    insertDailyProgress(userId, days[0], 12);
    insertDailyProgress(userId, days[days.length - 1], 8);

    const response = await getLeaderboard(cookie, '?metric=area&period=month');

    expect(response.statusCode).toBe(200);
    expect(entryFor(response, userId).value).toBeCloseTo(((12 + 8) / PLAYABLE_CELLS) * 100);
  });
});

describe('ranking — bars metric', () => {
  it('all-time: counts distinct mastered bars regardless of when they were mastered', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const barA = seedBar('Bar A');
    const barB = seedBar('Bar B');
    insertCompletedVisit(userId, barA, 1000);
    insertCompletedVisit(userId, barB, 2_000_000);

    const response = await getLeaderboard(cookie, '?metric=bars&period=all');

    expect(entryFor(response, userId).value).toBe(2);
  });

  it('week: counts only bars whose earliest completion falls in the current week', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const weekKey = badgePeriodKey('week', Date.now());
    const { startS } = badgePeriodBoundaries('week', weekKey);
    const inWeek = seedBar('This Week Bar');
    const beforeWeek = seedBar('Last Week Bar');
    insertCompletedVisit(userId, inWeek, startS + 3600);
    insertCompletedVisit(userId, beforeWeek, startS - 3600);

    const response = await getLeaderboard(cookie, '?metric=bars&period=week');

    expect(entryFor(response, userId).value).toBe(1);
  });

  it('a bar mastered twice counts once, at the leaderboard level, in the period of its first completion', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const weekKey = badgePeriodKey('week', Date.now());
    const { startS } = badgePeriodBoundaries('week', weekKey);
    const barId = seedBar('Repeat Bar');
    // Two completions in the same current week.
    insertCompletedVisit(userId, barId, startS + 100);
    insertCompletedVisit(userId, barId, startS + 200);

    const allTime = await getLeaderboard(cookie, '?metric=bars&period=all');
    const thisWeek = await getLeaderboard(cookie, '?metric=bars&period=week');

    expect(entryFor(allTime, userId).value).toBe(1);
    expect(entryFor(thisWeek, userId).value).toBe(1);
  });

  it('a repeat completion in the current period does not resurrect a bar whose first mastering was earlier', async () => {
    const { cookie, userId } = await registerUser('viewer');
    const weekKey = badgePeriodKey('week', Date.now());
    const { startS } = badgePeriodBoundaries('week', weekKey);
    const barId = seedBar('Old Mastery Bar');
    // First (counting) completion well before the current week.
    insertCompletedVisit(userId, barId, startS - 10_000);
    // A second completion at the same bar, inside the current week — must
    // not make this week's count 1; the earliest completion is what counts,
    // and it falls outside this period entirely.
    insertCompletedVisit(userId, barId, startS + 3600);

    const thisWeek = await getLeaderboard(cookie, '?metric=bars&period=week');
    const allTime = await getLeaderboard(cookie, '?metric=bars&period=all');

    expect(entryFor(thisWeek, userId).value).toBe(0);
    expect(entryFor(allTime, userId).value).toBe(1);
  });
});

describe('stable tie-breaking', () => {
  it('breaks a value tie by earliest achievement, and repeats the same order on a second call', async () => {
    const { cookie } = await registerUser('viewer');
    const earlyId = insertUser('early');
    const lateId = insertUser('late');
    // Same value (100 cells), different achievement instants.
    insertFogState(earlyId, 100, 1000);
    insertFogState(lateId, 100, 2000);

    const first = await getLeaderboard(cookie, '?metric=area&period=all');
    const second = await getLeaderboard(cookie, '?metric=area&period=all');

    const order = (first.json().entries as LeaderboardEntry[])
      .filter((e) => e.userId === earlyId || e.userId === lateId)
      .map((e) => e.userId);
    expect(order).toEqual([earlyId, lateId]);
    expect(second.json().entries).toEqual(first.json().entries);
  });

  it('falls back to users.id when value and achievement instant both tie', async () => {
    const { cookie } = await registerUser('viewer');
    const lowerId = insertUser('lower');
    const higherId = insertUser('higher');
    expect(lowerId).toBeLessThan(higherId);
    insertFogState(lowerId, 42, 1000);
    insertFogState(higherId, 42, 1000);

    const response = await getLeaderboard(cookie, '?metric=area&period=all');

    const order = (response.json().entries as LeaderboardEntry[])
      .filter((e) => e.userId === lowerId || e.userId === higherId)
      .map((e) => e.userId);
    expect(order).toEqual([lowerId, higherId]);
  });
});

describe('anonymous users', () => {
  it('are ranked and counted, with identity masked but badges present', async () => {
    const { cookie } = await registerUser('viewer');
    const { cookie: anonCookie, userId: anonId } = await registerUser('shy_walker');
    insertFogState(anonId, 300, 1000);
    const weekKey = badgePeriodKey('week', Date.now());
    insertBadge(anonId, 'explorer', 'week', weekKey);

    const toggle = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: anonCookie },
      payload: { isAnonymous: true },
    });
    expect(toggle.statusCode).toBe(200);

    const response = await getLeaderboard(cookie, '?metric=area&period=all');

    const entry = entryFor(response, anonId);
    expect(entry.isAnonymous).toBe(true);
    expect(entry.displayName).toBe(anonymousDisplayName(anonId));
    expect(entry.avatarSeed).toBe(ANONYMOUS_AVATAR_SEED);
    expect(entry.value).toBeCloseTo((300 / PLAYABLE_CELLS) * 100);
    expect(entry.badges).toHaveLength(1);
  });

  it('toggling isAnonymous changes the displayed name on the very next read, without changing rank or statistics', async () => {
    const { cookie: viewerCookie } = await registerUser('viewer');
    const { cookie: aliceCookie, userId: aliceId } = await registerUser('alice');
    const bobId = insertUser('bob');
    insertFogState(aliceId, 200, 1000);
    insertFogState(bobId, 100, 1000);

    const before = await getLeaderboard(viewerCookie, '?metric=area&period=all');
    const beforeEntry = entryFor(before, aliceId);
    expect(beforeEntry.displayName).toBe('alice');
    expect(beforeEntry.isAnonymous).toBe(false);

    const toggle = await injectWithOrigin({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: aliceCookie },
      payload: { isAnonymous: true },
    });
    expect(toggle.statusCode).toBe(200);

    const after = await getLeaderboard(viewerCookie, '?metric=area&period=all');
    const afterEntry = entryFor(after, aliceId);

    expect(afterEntry.displayName).toBe(anonymousDisplayName(aliceId));
    expect(afterEntry.isAnonymous).toBe(true);
    expect(afterEntry.rank).toBe(beforeEntry.rank);
    expect(afterEntry.value).toBe(beforeEntry.value);
  });
});

describe('paging', () => {
  it('respects LEADERBOARD_PAGE_SIZE and neither drops nor duplicates a row at the page boundary', async () => {
    const { cookie, userId: viewerId } = await registerUser('viewer');
    insertFogState(viewerId, 0, 1000);
    const extraCount = CONFIG.LEADERBOARD_PAGE_SIZE + 4; // + the viewer = pageSize + 5
    const seededIds: number[] = [viewerId];
    for (let i = 0; i < extraCount; i++) {
      const userId = insertUser(`bulk-${i}`);
      insertFogState(userId, (i + 1) * 10, 1000);
      seededIds.push(userId);
    }

    const page1 = await getLeaderboard(cookie, '?metric=area&period=all&page=1');
    const page2 = await getLeaderboard(cookie, '?metric=area&period=all&page=2');

    expect(page1.json().pageSize).toBe(CONFIG.LEADERBOARD_PAGE_SIZE);
    expect(page1.json().totalUsers).toBe(seededIds.length);
    const page1Ids = (page1.json().entries as LeaderboardEntry[]).map((e) => e.userId);
    const page2Ids = (page2.json().entries as LeaderboardEntry[]).map((e) => e.userId);

    expect(page1Ids).toHaveLength(CONFIG.LEADERBOARD_PAGE_SIZE);
    expect(page2Ids).toHaveLength(seededIds.length - CONFIG.LEADERBOARD_PAGE_SIZE);

    const combined = [...page1Ids, ...page2Ids];
    expect(new Set(combined).size).toBe(combined.length); // no duplicate row
    expect(combined.sort((a, b) => a - b)).toEqual([...seededIds].sort((a, b) => a - b)); // none dropped

    const page1Ranks = (page1.json().entries as LeaderboardEntry[]).map((e) => e.rank);
    const page2Ranks = (page2.json().entries as LeaderboardEntry[]).map((e) => e.rank);
    expect(page1Ranks).toEqual(page1Ranks.slice().sort((a, b) => a - b));
    expect(Math.max(...page1Ranks) + 1).toBe(Math.min(...page2Ranks));
  });
});
