import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from '@tipsytrails/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { resolveVapidConfig } from './config.js';

// Each test gets its own directory rather than sharing '/tmp' the way most
// route test files' DATABASE_PATH does — resolveVapidConfig reads and
// writes a real file beside DATABASE_PATH, and this suite exercises that
// file directly, so it needs a directory nothing else can collide with.
let testDir: string;

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return loadEnv({
    PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
    DATABASE_PATH: join(testDir, 'tipsytrails.db'),
    SESSION_SECRET: '01234567890123456789012345678901',
    ...overrides,
  });
}

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('resolveVapidConfig', () => {
  it('reports enabled with the three values when all are set, without touching disk', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv({
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:admin@example.com',
    });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'enabled',
      config: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:admin@example.com' },
    });
    expect(existsSync(join(testDir, CONFIG.VAPID_KEY_FILENAME))).toBe(false);
  });

  it('reports misconfigured, naming what is missing, when only some are set', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv({ VAPID_PUBLIC_KEY: 'pub' });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'misconfigured',
      missing: ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    });
  });

  it('reports misconfigured when exactly two of the three are set', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'misconfigured',
      missing: ['VAPID_SUBJECT'],
    });
  });

  it('generates and persists a key pair beside DATABASE_PATH on first boot, subject from PUBLIC_ORIGIN', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv();

    const result = resolveVapidConfig(env);

    expect(result.status).toBe('enabled');
    if (result.status !== 'enabled') throw new Error('expected enabled');
    expect(result.config.subject).toBe(env.PUBLIC_ORIGIN);
    expect(result.config.publicKey.length).toBeGreaterThan(0);
    expect(result.config.privateKey.length).toBeGreaterThan(0);

    const keyFilePath = join(testDir, CONFIG.VAPID_KEY_FILENAME);
    expect(existsSync(keyFilePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(keyFilePath, 'utf8')) as {
      publicKey: string;
      privateKey: string;
    };
    expect(persisted).toEqual({
      publicKey: result.config.publicKey,
      privateKey: result.config.privateKey,
    });
  });

  it('writes the key file owner-read-write only, never world- or group-readable', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv();

    resolveVapidConfig(env);

    const mode = statSync(join(testDir, CONFIG.VAPID_KEY_FILENAME)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('loads the same pair on a second boot instead of generating a new one', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv();

    const first = resolveVapidConfig(env);
    const second = resolveVapidConfig(env);

    expect(first).toEqual(second);
  });

  it('lets a full environment override win over an existing persisted file', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    const env = makeEnv();
    const generated = resolveVapidConfig(env);
    expect(generated.status).toBe('enabled');

    const overridden = resolveVapidConfig(
      makeEnv({
        VAPID_PUBLIC_KEY: 'override-pub',
        VAPID_PRIVATE_KEY: 'override-priv',
        VAPID_SUBJECT: 'mailto:admin@example.com',
      }),
    );

    expect(overridden).toEqual({
      status: 'enabled',
      config: {
        publicKey: 'override-pub',
        privateKey: 'override-priv',
        subject: 'mailto:admin@example.com',
      },
    });
  });

  it('reports unavailable, not throwing, when the key file is not valid JSON', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, CONFIG.VAPID_KEY_FILENAME), 'not json', { mode: 0o600 });
    const env = makeEnv();

    const result = resolveVapidConfig(env);

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).not.toContain('not json');
  });

  it('reports unavailable when the key file is well-formed JSON missing the expected fields', () => {
    testDir = join(tmpdir(), `tipsytrails-vapid-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, CONFIG.VAPID_KEY_FILENAME), JSON.stringify({ foo: 'bar' }), {
      mode: 0o600,
    });
    const env = makeEnv();

    expect(resolveVapidConfig(env).status).toBe('unavailable');
  });
});
