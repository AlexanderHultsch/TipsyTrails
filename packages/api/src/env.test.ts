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

  it('parses successfully when ADMIN_USER and ADMIN_PASSWORD are both omitted', () => {
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

  // SPEC.md Sections 9.3/10.1: the admin teleport's kill switch. Absent is
  // the ordinary state and means the route is never registered (app.ts), so
  // "absent parses cleanly to undefined" is the case that matters most —
  // a throw here would stop every deployment that does not want the feature.
  it('leaves ADMIN_TELEPORT_ENABLED undefined when absent, without throwing', () => {
    const env = loadEnv(validEnv);

    expect(env.ADMIN_TELEPORT_ENABLED).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('treats an %s ADMIN_TELEPORT_ENABLED as absent', (_label, value) => {
    const env = loadEnv({ ...validEnv, ADMIN_TELEPORT_ENABLED: value });

    expect(env.ADMIN_TELEPORT_ENABLED).toBeUndefined();
  });

  it.each([
    ['true', 'true'],
    ['false', 'false'],
  ])('preserves the explicit value %s', (_label, value) => {
    expect(loadEnv({ ...validEnv, ADMIN_TELEPORT_ENABLED: value }).ADMIN_TELEPORT_ENABLED).toBe(
      value,
    );
  });

  // Every one of these is something an operator would plausibly type meaning
  // "on", and every one of them would silently leave the feature off if the
  // variable were merely `z.string().optional()` and tested for truthiness.
  // Failing at boot, naming the variable, is the same reasoning API_PORT's
  // range check and PUBLIC_ORIGIN's protocol check are built on.
  it.each([['1'], ['yes'], ['on'], ['TRUE'], ['True'], ['enabled']])(
    'rejects ADMIN_TELEPORT_ENABLED=%s, naming the variable',
    (value) => {
      expect(() => loadEnv({ ...validEnv, ADMIN_TELEPORT_ENABLED: value })).toThrow(
        /ADMIN_TELEPORT_ENABLED/,
      );
    },
  );

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

// Review block R2 (boundaries). Both variables were shape-validated but not
// meaning-validated: an API_PORT of 3000.5 and a PUBLIC_ORIGIN of ftp://…
// both parsed cleanly and failed later, somewhere else, without naming
// themselves. Each case below is one that used to get past loadEnv.
describe('loadEnv checks API_PORT and PUBLIC_ORIGIN for meaning, not only shape', () => {
  it.each([
    ['fractional', '3000.5'],
    ['above the TCP port range', '99999'],
    ['negative', '-1'],
    ['zero', '0'],
  ])('rejects an API_PORT that is %s, naming the variable', (_label, port) => {
    expect(() => loadEnv({ ...validEnv, API_PORT: port })).toThrow(/API_PORT/);
  });

  it('rejects a PORT alias that is not a usable port either', () => {
    expect(() => loadEnv({ ...validEnv, PORT: '70000' })).toThrow(/API_PORT/);
  });

  it.each([['ftp://tipsytrails.example'], ['javascript:alert(1)'], ['mailto:someone@example.com']])(
    'rejects PUBLIC_ORIGIN %s, which bare URL syntax accepts',
    (origin) => {
      expect(() => loadEnv({ ...validEnv, PUBLIC_ORIGIN: origin })).toThrow(/PUBLIC_ORIGIN/);
    },
  );

  // The complement: both tightenings must still accept everything a real
  // deployment uses, or this is a broken container rather than a check.
  it.each([
    ['the production https origin', 'https://tipsytrails.ahultsch.com'],
    ['a plain-http local origin', 'http://localhost:5173'],
  ])('still accepts %s', (_label, origin) => {
    expect(loadEnv({ ...validEnv, PUBLIC_ORIGIN: origin }).PUBLIC_ORIGIN).toBe(origin);
  });

  it.each([
    ['the lowest port', '1', 1],
    ['the highest port', '65535', 65535],
    ['the ordinary one', '3000', 3000],
  ])('still accepts %s', (_label, port, expected) => {
    expect(loadEnv({ ...validEnv, API_PORT: port }).API_PORT).toBe(expected);
  });
});
