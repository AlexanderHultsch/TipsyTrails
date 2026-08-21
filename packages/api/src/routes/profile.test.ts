import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badgePeriodKey } from '@tipsytrails/shared';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';
import { ANONYMOUS_AVATAR_SEED, anonymousDisplayName, playerHandle } from './anonymity.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A directory private to this file rather than a literal shared path —
// DATABASE_PATH is also where resolveVapidConfig (SPEC.md Section 5.9)
// looks for/generates the persisted VAPID key file, and a path shared
// across test files would mean this suite's own app builds silently
// generate/read the same key file as every other route test file.
const vapidTestDir = join(tmpdir(), `tipsytrails-profile-test-vapid-${randomUUID()}`);

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

async function registerUser(username: string): Promise<{ cookie: string; userId: number }> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return { cookie: extractSessionCookie(response), userId: response.json().id as number };
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

function getProfile(cookie: string, handle: string): Promise<LightMyRequestResponse> {
  return injectWithOrigin({
    method: 'GET',
    url: `/api/profile/${encodeURIComponent(handle)}`,
    headers: { cookie },
  });
}

async function setAnonymous(cookie: string, isAnonymous: boolean): Promise<void> {
  const response = await injectWithOrigin({
    method: 'PATCH',
    url: '/api/settings',
    headers: { cookie },
    payload: { isAnonymous },
  });
  expect(response.statusCode).toBe(200);
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-profile-test-${randomUUID()}.db`);
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
  rmSync(vapidTestDir, { recursive: true, force: true });
});

describe('GET /api/profile/:handle', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/profile/anyone' });
    expect(response.statusCode).toBe(401);
  });

  it('resolves a non-anonymous user by username with hand-computed area% and bars mastered', async () => {
    const { cookie, userId } = await registerUser('walker');
    insertFogState(userId, 250, 1000);
    const barA = seedBar('Bar A');
    const barB = seedBar('Bar B');
    insertCompletedVisit(userId, barA, 1000);
    insertCompletedVisit(userId, barB, 2000);

    const response = await getProfile(cookie, 'walker');

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.displayName).toBe('walker');
    expect(body.isAnonymous).toBe(false);
    expect(body.userId).toBe(userId);
    expect(body.handle).toBe(playerHandle(userId));
    expect(body.areaPercent).toBeCloseTo((250 / PLAYABLE_CELLS) * 100);
    expect(body.barsMastered).toBe(2);
    expect(body.badgeProgress).toHaveProperty('week');
    expect(body.badgeProgress).toHaveProperty('month');
    expect(body.badgeProgress).toHaveProperty('year');
    expect(body.badgeProgress.week).toEqual([
      { kind: 'explorer', value: 0 },
      { kind: 'barfly', value: 0 },
    ]);
  });

  // Section 7.7: the threshold is a floor the server keeps to itself — no
  // endpoint returns it. Walks the whole badge-progress subtree rather than
  // naming the two entries it happens to hold today, so reintroducing the
  // field anywhere beneath it fails here.
  it('returns no threshold anywhere in the badge progress', async () => {
    const { cookie, userId } = await registerUser('walker');
    insertFogState(userId, 250, 1000);

    const response = await getProfile(cookie, 'walker');

    const keys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          collectKeys(item);
        }
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          collectKeys(child);
        }
      }
    };
    collectKeys(response.json().badgeProgress);

    expect(keys).toEqual(new Set(['week', 'month', 'year', 'kind', 'value']));
    expect(response.body).not.toContain('threshold');
  });

  it('a non-anonymous user also resolves by their player-{id} handle, unmasked', async () => {
    const { cookie, userId } = await registerUser('walker');

    const response = await getProfile(cookie, playerHandle(userId));

    expect(response.statusCode).toBe(200);
    expect(response.json().displayName).toBe('walker');
    expect(response.json().isAnonymous).toBe(false);
  });

  it('surfaces the badge shelf (all badges ever awarded)', async () => {
    const { cookie, userId } = await registerUser('walker');
    const weekKey = badgePeriodKey('week', Date.now());
    insertBadge(userId, 'explorer', 'week', weekKey);

    const response = await getProfile(cookie, 'walker');

    expect(response.json().badges).toEqual([
      expect.objectContaining({ kind: 'explorer', period: 'week', periodKey: weekKey }),
    ]);
  });

  it('a never-moved user reads as 0% / 0 bars rather than erroring or creating a fog_state row', async () => {
    const { cookie, userId } = await registerUser('dormant');

    const response = await getProfile(cookie, 'dormant');

    expect(response.statusCode).toBe(200);
    expect(response.json().areaPercent).toBe(0);
    expect(response.json().barsMastered).toBe(0);
    const fogRow = db.prepare('SELECT 1 FROM fog_state WHERE user_id = ?').get(userId);
    expect(fogRow).toBeUndefined();
  });

  it('an unknown username 404s', async () => {
    const { cookie } = await registerUser('viewer');

    const response = await getProfile(cookie, 'nobody-by-this-name');

    expect(response.statusCode).toBe(404);
  });

  describe('an anonymous user', () => {
    async function registerAnonymousUser(
      username: string,
    ): Promise<{ cookie: string; userId: number }> {
      const { cookie, userId } = await registerUser(username);
      await setAnonymous(cookie, true);
      return { cookie, userId };
    }

    it('404s by username', async () => {
      const { cookie: viewerCookie } = await registerUser('viewer');
      await registerAnonymousUser('shy_walker');

      const response = await getProfile(viewerCookie, 'shy_walker');

      expect(response.statusCode).toBe(404);
    });

    it('resolves by handle, masked, with badges shown against the masked handle', async () => {
      const { cookie: viewerCookie } = await registerUser('viewer');
      const { userId: anonId } = await registerAnonymousUser('shy_walker');
      insertFogState(anonId, 100, 1000);
      const weekKey = badgePeriodKey('week', Date.now());
      insertBadge(anonId, 'explorer', 'week', weekKey);

      const response = await getProfile(viewerCookie, playerHandle(anonId));

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.isAnonymous).toBe(true);
      expect(body.displayName).toBe(anonymousDisplayName(anonId));
      expect(body.avatarSeed).toBe(ANONYMOUS_AVATAR_SEED);
      expect(body.areaPercent).toBeCloseTo((100 / PLAYABLE_CELLS) * 100);
      expect(body.badges).toHaveLength(1);
    });

    it('gives byte-identical 404s for an unknown user, an anonymous user addressed by username, and a malformed handle', async () => {
      const { cookie: viewerCookie } = await registerUser('viewer');
      await registerAnonymousUser('shy_walker');

      const unknownUser = await getProfile(viewerCookie, 'no-such-user-at-all');
      const anonymousByUsername = await getProfile(viewerCookie, 'shy_walker');
      const malformedHandle1 = await getProfile(viewerCookie, 'player-');
      const malformedHandle2 = await getProfile(viewerCookie, 'player-not-a-number');
      const malformedHandle3 = await getProfile(viewerCookie, 'player-999999999999999999999999999');

      for (const response of [
        unknownUser,
        anonymousByUsername,
        malformedHandle1,
        malformedHandle2,
        malformedHandle3,
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.body).toBe(unknownUser.body);
        expect(response.json()).toEqual(unknownUser.json());
      }
    });
  });
});
