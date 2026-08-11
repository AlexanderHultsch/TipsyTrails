import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const validEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/data/tipsytrails.db',
  SESSION_SECRET: '01234567890123456789012345678901',
};

describe('loadEnv', () => {
  it('parses a complete valid environment', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      API_HOST: '127.0.0.1',
      API_PORT: '4000',
      ...validEnv,
    });

    expect(env.NODE_ENV).toBe('production');
    expect(env.API_HOST).toBe('127.0.0.1');
    expect(env.API_PORT).toBe(4000);
    expect(env.PUBLIC_ORIGIN).toBe(validEnv.PUBLIC_ORIGIN);
    expect(env.DATABASE_PATH).toBe(validEnv.DATABASE_PATH);
    expect(env.SESSION_SECRET).toBe(validEnv.SESSION_SECRET);
  });

  it('applies defaults for NODE_ENV, API_HOST and API_PORT when absent', () => {
    const env = loadEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.API_PORT).toBe(3000);
  });

  it('coerces API_PORT given as a string into a number', () => {
    const env = loadEnv({ ...validEnv, API_PORT: '8080' });

    expect(env.API_PORT).toBe(8080);
    expect(typeof env.API_PORT).toBe('number');
  });

  it('throws when SESSION_SECRET is missing', () => {
    expect(() =>
      loadEnv({ PUBLIC_ORIGIN: validEnv.PUBLIC_ORIGIN, DATABASE_PATH: validEnv.DATABASE_PATH }),
    ).toThrow();
  });

  it('throws when SESSION_SECRET is 31 characters', () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: '1'.repeat(31) })).toThrow();
  });

  it('passes when SESSION_SECRET is 32 characters', () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: '1'.repeat(32) })).not.toThrow();
  });

  it('throws when PUBLIC_ORIGIN is not a URL', () => {
    expect(() => loadEnv({ ...validEnv, PUBLIC_ORIGIN: 'not-a-url' })).toThrow();
  });

  it('parses successfully when ADMIN_USERNAME and ADMIN_PASSWORD are both omitted', () => {
    expect(() => loadEnv(validEnv)).not.toThrow();
  });

  it('reports the offending variable name without leaking the secret value', () => {
    const sentinel = 'TOTALLY-SECRET-SENTINEL-VALUE';
    let message = '';
    try {
      loadEnv({ ...validEnv, SESSION_SECRET: sentinel });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('SESSION_SECRET');
    expect(message).not.toContain(sentinel);
  });

  it('falls back to PORT when API_PORT is absent', () => {
    const env = loadEnv({ ...validEnv, PORT: '8080' });

    expect(env.API_PORT).toBe(8080);
  });

  it('falls back to DB_PATH when DATABASE_PATH is absent', () => {
    const env = loadEnv({
      PUBLIC_ORIGIN: validEnv.PUBLIC_ORIGIN,
      SESSION_SECRET: validEnv.SESSION_SECRET,
      DB_PATH: '/data/x.db',
    });

    expect(env.DATABASE_PATH).toBe('/data/x.db');
  });

  it('prefers API_PORT over PORT when both are set', () => {
    const env = loadEnv({ ...validEnv, API_PORT: '4000', PORT: '9000' });

    expect(env.API_PORT).toBe(4000);
  });

  it('still throws when neither DATABASE_PATH nor DB_PATH is given', () => {
    expect(() =>
      loadEnv({
        PUBLIC_ORIGIN: validEnv.PUBLIC_ORIGIN,
        SESSION_SECRET: validEnv.SESSION_SECRET,
      }),
    ).toThrow();
  });

  it('treats an empty WEB_ROOT as absent', () => {
    const env = loadEnv({ ...validEnv, WEB_ROOT: '' });

    expect(env.WEB_ROOT).toBeUndefined();
  });

  it('treats a whitespace-only WEB_ROOT as absent', () => {
    const env = loadEnv({ ...validEnv, WEB_ROOT: '   ' });

    expect(env.WEB_ROOT).toBeUndefined();
  });

  it('preserves a real WEB_ROOT value unchanged', () => {
    const env = loadEnv({ ...validEnv, WEB_ROOT: '/srv/app' });

    expect(env.WEB_ROOT).toBe('/srv/app');
  });

  it('treats an empty SEED_DIR as absent', () => {
    const env = loadEnv({ ...validEnv, SEED_DIR: '' });

    expect(env.SEED_DIR).toBeUndefined();
  });

  it('treats a whitespace-only SEED_DIR as absent', () => {
    const env = loadEnv({ ...validEnv, SEED_DIR: '   ' });

    expect(env.SEED_DIR).toBeUndefined();
  });

  it('preserves a real SEED_DIR value unchanged', () => {
    const env = loadEnv({ ...validEnv, SEED_DIR: '/srv/data/seed' });

    expect(env.SEED_DIR).toBe('/srv/data/seed');
  });

  it('applies the default TILES_DIR when absent', () => {
    const env = loadEnv(validEnv);

    expect(env.TILES_DIR).toBe('/data/tiles');
  });

  it('treats an empty TILES_DIR as absent, falling back to the default', () => {
    const env = loadEnv({ ...validEnv, TILES_DIR: '' });

    expect(env.TILES_DIR).toBe('/data/tiles');
  });

  it('preserves a real TILES_DIR value unchanged', () => {
    const env = loadEnv({ ...validEnv, TILES_DIR: '/srv/tiles' });

    expect(env.TILES_DIR).toBe('/srv/tiles');
  });

  it('falls back to the default port when PORT is empty and API_PORT is absent', () => {
    const env = loadEnv({ ...validEnv, PORT: '' });

    expect(env.API_PORT).toBe(3000);
  });

  it('leaves the three VAPID_* variables undefined when absent, without throwing', () => {
    const env = loadEnv(validEnv);

    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(env.VAPID_PRIVATE_KEY).toBeUndefined();
    expect(env.VAPID_SUBJECT).toBeUndefined();
  });

  it('preserves real VAPID_* values unchanged', () => {
    const env = loadEnv({
      ...validEnv,
      VAPID_PUBLIC_KEY: 'public-key',
      VAPID_PRIVATE_KEY: 'private-key',
      VAPID_SUBJECT: 'mailto:admin@example.com',
    });

    expect(env.VAPID_PUBLIC_KEY).toBe('public-key');
    expect(env.VAPID_PRIVATE_KEY).toBe('private-key');
    expect(env.VAPID_SUBJECT).toBe('mailto:admin@example.com');
  });

  it('treats an empty or whitespace-only VAPID_* variable as absent', () => {
    const env = loadEnv({ ...validEnv, VAPID_PUBLIC_KEY: '', VAPID_SUBJECT: '   ' });

    expect(env.VAPID_PUBLIC_KEY).toBeUndefined();
    expect(env.VAPID_SUBJECT).toBeUndefined();
  });

  it('falls back to DATABASE_PATH when DB_PATH is empty and DATABASE_PATH is set', () => {
    const env = loadEnv({ ...validEnv, DB_PATH: '' });

    expect(env.DATABASE_PATH).toBe(validEnv.DATABASE_PATH);
  });

  it('still throws naming DATABASE_PATH when DB_PATH is empty and DATABASE_PATH is absent', () => {
    let message = '';
    try {
      loadEnv({
        PUBLIC_ORIGIN: validEnv.PUBLIC_ORIGIN,
        SESSION_SECRET: validEnv.SESSION_SECRET,
        DB_PATH: '',
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain('DATABASE_PATH');
  });
});
