import { describe, expect, it } from 'vitest';
import { loadEnv } from '../env.js';
import { resolveVapidConfig } from './config.js';

const baseEnv = {
  PUBLIC_ORIGIN: 'https://tipsytrails.ahultsch.com',
  DATABASE_PATH: '/data/tipsytrails.db',
  SESSION_SECRET: '01234567890123456789012345678901',
};

describe('resolveVapidConfig', () => {
  it('reports disabled when none of the three VAPID_* variables are set', () => {
    const env = loadEnv(baseEnv);

    expect(resolveVapidConfig(env)).toEqual({ status: 'disabled' });
  });

  it('reports enabled with the three values when all are set', () => {
    const env = loadEnv({
      ...baseEnv,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
      VAPID_SUBJECT: 'mailto:admin@example.com',
    });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'enabled',
      config: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:admin@example.com' },
    });
  });

  it('reports misconfigured, naming what is missing, when only some are set', () => {
    const env = loadEnv({ ...baseEnv, VAPID_PUBLIC_KEY: 'pub' });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'misconfigured',
      missing: ['VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
    });
  });

  it('reports misconfigured when exactly two of the three are set', () => {
    const env = loadEnv({
      ...baseEnv,
      VAPID_PUBLIC_KEY: 'pub',
      VAPID_PRIVATE_KEY: 'priv',
    });

    expect(resolveVapidConfig(env)).toEqual({
      status: 'misconfigured',
      missing: ['VAPID_SUBJECT'],
    });
  });
});
