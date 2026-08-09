import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { Env } from './env.js';

const testEnv: Env = {
  NODE_ENV: 'test',
  API_HOST: '0.0.0.0',
  API_PORT: 3000,
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/tmp/test.db',
  SESSION_SECRET: '0123456789012345678901234567890123',
};

describe('GET /api/health', () => {
  it('returns 200 with status ok', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('carries the no-store cache header', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('unknown /api route', () => {
  it('returns 404 with the no-store cache header', async () => {
    const app = buildApp(testEnv);
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
