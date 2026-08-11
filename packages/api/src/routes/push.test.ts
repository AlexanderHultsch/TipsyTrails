import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../env.js';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

// A real keypair generated at test runtime, never committed (CLAUDE.md
// forbids key material anywhere in the repository, including tests).
const vapidKeys = webpush.generateVAPIDKeys();

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

const validSubscription = {
  endpoint: 'https://push.example.com/subscriptions/abc',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

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

async function registerUser(username: string): Promise<{ cookie: string; userId: number }> {
  const response = await injectWithOrigin({
    method: 'POST',
    url: '/api/auth/register',
    payload: { ...validRegisterBody, username },
  });
  return { cookie: extractSessionCookie(response), userId: response.json().id as number };
}

function subscriptionRow(
  endpoint: string,
): { id: number; user_id: number; p256dh: string; auth: string } | undefined {
  return db
    .prepare<[string], { id: number; user_id: number; p256dh: string; auth: string }>(
      'SELECT id, user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?',
    )
    .get(endpoint);
}

function subscriptionCount(): number {
  return (
    db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM push_subscriptions').get()
      ?.count ?? 0
  );
}

beforeEach(() => {
  dbPath = join(tmpdir(), `tipsytrails-push-test-${randomUUID()}.db`);
  db = openDatabase(dbPath);
  runMigrations(db, migrationsDir);
  const env = loadEnv(baseEnv);
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
});

describe('GET /api/push/vapid-public-key', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({ method: 'GET', url: '/api/push/vapid-public-key' });
    expect(response.statusCode).toBe(401);
  });

  it('returns null when push is not configured', async () => {
    const { cookie } = await registerUser('walker');

    const response = await injectWithOrigin({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publicKey: null });
  });

  it('returns the configured public key when VAPID_* is fully set', async () => {
    const env = loadEnv({
      ...baseEnv,
      VAPID_PUBLIC_KEY: vapidKeys.publicKey,
      VAPID_PRIVATE_KEY: vapidKeys.privateKey,
      VAPID_SUBJECT: 'mailto:admin@example.com',
    });
    const configuredApp = buildApp(env, db);
    const registerResponse = await configuredApp.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: baseEnv.PUBLIC_ORIGIN },
      payload: { ...validRegisterBody, username: 'walker2' },
    });
    const cookie = extractSessionCookie(registerResponse);

    const response = await configuredApp.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
      headers: { origin: baseEnv.PUBLIC_ORIGIN, cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ publicKey: vapidKeys.publicKey });
  });
});

describe('POST /api/push/subscribe', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: validSubscription,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed body', async () => {
    const { cookie } = await registerUser('walker');

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint: 'not-a-url' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('stores a new subscription for the caller', async () => {
    const { cookie, userId } = await registerUser('walker');

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: validSubscription,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const row = subscriptionRow(validSubscription.endpoint);
    expect(row).toMatchObject({
      user_id: userId,
      p256dh: validSubscription.keys.p256dh,
      auth: validSubscription.keys.auth,
    });
  });

  it('re-subscribing with the same endpoint updates the row instead of erroring', async () => {
    const { cookie, userId } = await registerUser('walker');
    await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: validSubscription,
    });

    const updated = {
      endpoint: validSubscription.endpoint,
      keys: { p256dh: 'a-different-p256dh-value', auth: 'a-different-auth-value' },
    };
    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: updated,
    });

    expect(response.statusCode).toBe(200);
    expect(subscriptionCount()).toBe(1);
    const row = subscriptionRow(validSubscription.endpoint);
    expect(row).toMatchObject({ user_id: userId, p256dh: updated.keys.p256dh });
  });

  it('re-subscribing the same endpoint under a different account transfers ownership', async () => {
    const first = await registerUser('walker-one');
    await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: first.cookie },
      payload: validSubscription,
    });
    const second = await registerUser('walker-two');

    const response = await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie: second.cookie },
      payload: validSubscription,
    });

    expect(response.statusCode).toBe(200);
    expect(subscriptionCount()).toBe(1);
    expect(subscriptionRow(validSubscription.endpoint)?.user_id).toBe(second.userId);
  });
});

describe('DELETE /api/push/subscribe', () => {
  it('requires a session', async () => {
    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/push/subscribe',
      payload: { endpoint: validSubscription.endpoint },
    });
    expect(response.statusCode).toBe(401);
  });

  it("deletes the caller's own subscription", async () => {
    const { cookie } = await registerUser('walker');
    await injectWithOrigin({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: validSubscription,
    });

    const response = await injectWithOrigin({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers: { cookie },
      payload: { endpoint: validSubscription.endpoint },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(subscriptionRow(validSubscription.endpoint)).toBeUndefined();
  });

  it(
    'returns byte-identical responses for deleting a nonexistent endpoint and ' +
      "someone else's endpoint, and leaves the other user's row untouched",
    async () => {
      const owner = await registerUser('walker-owner');
      await injectWithOrigin({
        method: 'POST',
        url: '/api/push/subscribe',
        headers: { cookie: owner.cookie },
        payload: validSubscription,
      });
      const attacker = await registerUser('walker-attacker');

      const otherUsersEndpoint = await injectWithOrigin({
        method: 'DELETE',
        url: '/api/push/subscribe',
        headers: { cookie: attacker.cookie },
        payload: { endpoint: validSubscription.endpoint },
      });
      const nonexistentEndpoint = await injectWithOrigin({
        method: 'DELETE',
        url: '/api/push/subscribe',
        headers: { cookie: attacker.cookie },
        payload: { endpoint: 'https://push.example.com/subscriptions/does-not-exist' },
      });

      expect(otherUsersEndpoint.statusCode).toBe(200);
      expect(nonexistentEndpoint.statusCode).toBe(200);
      expect(otherUsersEndpoint.body).toBe(nonexistentEndpoint.body);
      // The row belongs to `owner`, not `attacker` — it must survive both
      // calls above untouched.
      expect(subscriptionRow(validSubscription.endpoint)?.user_id).toBe(owner.userId);
    },
  );
});
