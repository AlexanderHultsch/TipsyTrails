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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBadgeProgress, evaluateBadges, runBadgeCatchUp } from './badges.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';

const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

// A fixed week, chosen the same way maintenance.test.ts picks BASE_NOW_S: an
// arbitrary real instant rather than the live clock, so every test below is
// exact and independent of when it happens to run.
const PERIOD = 'week' as const;
const PERIOD_KEY = '2026-W32';
const { startS: PERIOD_START_S, endS: PERIOD_END_S } = badgePeriodBoundaries(PERIOD, PERIOD_KEY);
const PERIOD_DAYS = badgePeriodDays(PERIOD, PERIOD_KEY);
const PLAYABLE_CELLS = 5000;

let dbPath: string;
let db: Database.Database;
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

function insertDailyProgress(userId: number, day: string, revealedCells: number): void {
  db.prepare(
    `INSERT INTO fog_daily_progress (user_id, city_id, day, revealed_cells) VALUES (?, ?, ?, ?)`,
  ).run(userId, cityId, day, revealedCells);
}

function insertCompletedVisit(userId: number, barId: number, completedAtS: number): void {
  db.prepare(
    `INSERT INTO visits (user_id, bar_id, started_at, last_sample_at, onsite_samples, confirmed_s, status, completed_at)
     VALUES (?, ?, ?, ?, 2, ?, 'completed', ?)`,
  ).run(userId, barId, completedAtS - 1200, completedAtS, 1200, completedAtS);
}

function badgeRow(userId: number, kind: string): { value: number; awarded_at: number } | undefined {
  return db
    .prepare<[number, string, string, string], { value: number; awarded_at: number }>(
      'SELECT value, awarded_at FROM badges WHERE user_id = ? AND kind = ? AND period = ? AND period_key = ?',
    )
    .get(userId, kind, PERIOD, PERIOD_KEY);
}

function badgeCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM badges').get() as { n: number }).n;
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-badges-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  cityId = seedCity();
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

describe('evaluateBadges — explorer', () => {
  it('awards a user at exactly the week threshold', () => {
    const userId = insertUser('alex');
    const thresholdCells = Math.ceil(
      (CONFIG.BADGE_THRESHOLDS.explorer.week / 100) * PLAYABLE_CELLS,
    );
    insertDailyProgress(userId, PERIOD_DAYS[0], thresholdCells);

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(result.awarded).toContainEqual({
      userId,
      kind: 'explorer',
      value: (thresholdCells / PLAYABLE_CELLS) * 100,
    });
    expect(badgeRow(userId, 'explorer')?.value).toBeCloseTo(
      (thresholdCells / PLAYABLE_CELLS) * 100,
    );
  });

  it('does not award a user just below the threshold', () => {
    const userId = insertUser('alex');
    const thresholdCells = (CONFIG.BADGE_THRESHOLDS.explorer.week / 100) * PLAYABLE_CELLS;
    insertDailyProgress(userId, PERIOD_DAYS[0], Math.floor(thresholdCells) - 1);

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(
      result.awarded.find((a) => a.kind === 'explorer' && a.userId === userId),
    ).toBeUndefined();
    expect(badgeRow(userId, 'explorer')).toBeUndefined();
  });

  it('a user who registered but never moved receives nothing', () => {
    const userId = insertUser('dormant');

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(result.awarded.filter((a) => a.userId === userId)).toHaveLength(0);
    expect(badgeCount()).toBe(0);
  });

  it('week explorer percent matches a hand-computed reference from fog_daily_progress', () => {
    const userId = insertUser('alex');
    insertDailyProgress(userId, PERIOD_DAYS[0], 30);
    insertDailyProgress(userId, PERIOD_DAYS[1], 20);
    // Outside the period entirely — must not be summed in.
    insertDailyProgress(userId, '2026-01-01', 9999);

    evaluateBadges(db, PERIOD, PERIOD_KEY);

    const expectedPercent = ((30 + 20) / PLAYABLE_CELLS) * 100;
    expect(expectedPercent).toBeGreaterThanOrEqual(CONFIG.BADGE_THRESHOLDS.explorer.week);
    expect(badgeRow(userId, 'explorer')?.value).toBeCloseTo(expectedPercent);
  });

  it('month explorer percent matches a hand-computed reference from fog_daily_progress', () => {
    const monthKey = '2026-08';
    const days = badgePeriodDays('month', monthKey);
    const userId = insertUser('alex');
    insertDailyProgress(userId, days[0], 12);
    insertDailyProgress(userId, days[10], 8);

    evaluateBadges(db, 'month', monthKey);

    const expectedPercent = ((12 + 8) / PLAYABLE_CELLS) * 100;
    const row = db
      .prepare<[number, string], { value: number }>(
        `SELECT value FROM badges WHERE user_id = ? AND kind = 'explorer' AND period = 'month' AND period_key = ?`,
      )
      .get(userId, monthKey);
    expect(expectedPercent).toBeGreaterThanOrEqual(CONFIG.BADGE_THRESHOLDS.explorer.month);
    expect(row?.value).toBeCloseTo(expectedPercent);
  });
});

describe('evaluateBadges — barfly', () => {
  it('awards a user at exactly the week threshold', () => {
    const userId = insertUser('alex');
    const barId = seedBar('Threshold Bar');
    insertCompletedVisit(userId, barId, PERIOD_START_S + 3600);

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(CONFIG.BADGE_THRESHOLDS.barfly.week).toBe(1);
    expect(result.awarded).toContainEqual({ userId, kind: 'barfly', value: 1 });
  });

  it('does not award a user just below the threshold (zero mastered bars)', () => {
    const userId = insertUser('alex');
    insertUser('unrelated');

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(result.awarded.find((a) => a.kind === 'barfly' && a.userId === userId)).toBeUndefined();
  });

  it('a bar mastered twice counts once, in the period of its first completion', () => {
    const userId = insertUser('alex');
    const barId = seedBar('Repeat Bar');
    // Earliest completion inside PERIOD_KEY.
    insertCompletedVisit(userId, barId, PERIOD_START_S + 3600);
    // Second completion at the same bar, a full week later — must count for nothing.
    insertCompletedVisit(userId, barId, PERIOD_END_S + 3600);

    const thisPeriod = evaluateBadges(db, PERIOD, PERIOD_KEY);
    const nextPeriodKey = badgePeriodKey(PERIOD, (PERIOD_END_S + 3600) * 1000);
    const nextPeriod = evaluateBadges(db, PERIOD, nextPeriodKey);

    expect(thisPeriod.awarded).toContainEqual({ userId, kind: 'barfly', value: 1 });
    expect(
      nextPeriod.awarded.find((a) => a.kind === 'barfly' && a.userId === userId),
    ).toBeUndefined();
  });

  it('a bar mastered twice in the SAME period still counts once, not as two masteries', () => {
    const userId = insertUser('alex');
    const barId = seedBar('Same Period Repeat Bar');
    insertCompletedVisit(userId, barId, PERIOD_START_S + 100);
    insertCompletedVisit(userId, barId, PERIOD_START_S + 200);

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(result.awarded).toContainEqual({ userId, kind: 'barfly', value: 1 });
  });

  it('fails the "mastered twice" DoD item if the earliest-completion rule is replaced by a plain count', () => {
    // This test documents the behaviour the earliest-completion rule
    // exists to prevent: a plain COUNT of completed visits in the period
    // (rather than counting distinct bars by their earliest completion)
    // would count the second, already-mastered visit again.
    const userId = insertUser('alex');
    const barId = seedBar('Naive Count Bar');
    insertCompletedVisit(userId, barId, PERIOD_START_S + 3600);
    insertCompletedVisit(userId, barId, PERIOD_START_S + 7200);

    const naiveCountInPeriod = db
      .prepare<[number, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM visits WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`,
      )
      .get(PERIOD_START_S, PERIOD_END_S)?.n;

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);
    const awarded = result.awarded.find((a) => a.kind === 'barfly' && a.userId === userId);

    expect(naiveCountInPeriod).toBe(2);
    expect(awarded?.value).toBe(1);
  });
});

describe('evaluateBadges — awarding', () => {
  it('multiple users hold the same badge for the same period (badges are not exclusive)', () => {
    const alex = insertUser('alex');
    const sam = insertUser('sam');
    const thresholdCells = Math.ceil(
      (CONFIG.BADGE_THRESHOLDS.explorer.week / 100) * PLAYABLE_CELLS,
    );
    insertDailyProgress(alex, PERIOD_DAYS[0], thresholdCells);
    insertDailyProgress(sam, PERIOD_DAYS[0], thresholdCells);

    const result = evaluateBadges(db, PERIOD, PERIOD_KEY);

    const explorerAwards = result.awarded.filter((a) => a.kind === 'explorer');
    expect(explorerAwards.map((a) => a.userId).sort()).toEqual([alex, sam].sort());
  });

  it('running the evaluation twice awards nothing the second time and does not change value or awarded_at', () => {
    const userId = insertUser('alex');
    const barId = seedBar('Idempotent Bar');
    const thresholdCells = Math.ceil(
      (CONFIG.BADGE_THRESHOLDS.explorer.week / 100) * PLAYABLE_CELLS,
    );
    insertDailyProgress(userId, PERIOD_DAYS[0], thresholdCells);
    insertCompletedVisit(userId, barId, PERIOD_START_S + 3600);

    const first = evaluateBadges(db, PERIOD, PERIOD_KEY);
    const firstExplorer = badgeRow(userId, 'explorer');
    const firstBarfly = badgeRow(userId, 'barfly');
    const countAfterFirst = badgeCount();

    const second = evaluateBadges(db, PERIOD, PERIOD_KEY);

    expect(first.awarded).toHaveLength(2);
    expect(second.awarded).toHaveLength(0);
    expect(badgeCount()).toBe(countAfterFirst);
    expect(badgeRow(userId, 'explorer')).toEqual(firstExplorer);
    expect(badgeRow(userId, 'barfly')).toEqual(firstBarfly);
  });
});

describe('runBadgeCatchUp', () => {
  it('evaluates a period that closed while the process was down, and does not re-evaluate one already done', () => {
    const userId = insertUser('alex');
    const barId = seedBar('Catch-up Bar');
    // A week that closed in the past relative to `bootMs` below.
    const closedWeekKey = '2026-W10';
    const { startS: closedStart } = badgePeriodBoundaries('week', closedWeekKey);
    insertCompletedVisit(userId, barId, closedStart + 3600);
    // Boot happens partway through the *next* week, so 'week' most-recently-closed is closedWeekKey.
    const bootMs = (closedStart + 8 * 86400) * 1000;

    const first = runBadgeCatchUp(db, bootMs);
    const weekResult = first.find((r) => r.period === 'week');
    expect(weekResult?.periodKey).toBe(closedWeekKey);
    expect(weekResult?.awarded).toContainEqual({ userId, kind: 'barfly', value: 1 });
    const countAfterFirst = badgeCount();

    const second = runBadgeCatchUp(db, bootMs + 60_000);
    const secondWeekResult = second.find((r) => r.period === 'week');

    expect(secondWeekResult?.awarded).toHaveLength(0);
    expect(badgeCount()).toBe(countAfterFirst);
  });
});

describe('currentBadgeProgress', () => {
  it('computes live progress from the same values evaluateBadges would award', () => {
    const userId = insertUser('alex');
    const barId = seedBar('On Track Bar');
    const nowMs = (PERIOD_START_S + 3600) * 1000;
    const currentWeekKey = badgePeriodKey('week', nowMs);
    const currentDays = badgePeriodDays('week', currentWeekKey);
    insertDailyProgress(userId, currentDays[0], 10);
    insertCompletedVisit(userId, barId, PERIOD_START_S + 3600);

    const progress = currentBadgeProgress(db, userId, 'week', nowMs);
    const explorer = progress.find((p) => p.kind === 'explorer');
    const barfly = progress.find((p) => p.kind === 'barfly');

    expect(explorer?.value).toBeCloseTo((10 / PLAYABLE_CELLS) * 100);
    expect(explorer?.threshold).toBe(CONFIG.BADGE_THRESHOLDS.explorer.week);
    expect(barfly?.value).toBe(1);
    expect(barfly?.threshold).toBe(CONFIG.BADGE_THRESHOLDS.barfly.week);

    const evaluated = evaluateBadges(db, 'week', currentWeekKey);
    expect(evaluated.awarded.find((a) => a.userId === userId && a.kind === 'barfly')?.value).toBe(
      barfly?.value,
    );
  });
});
