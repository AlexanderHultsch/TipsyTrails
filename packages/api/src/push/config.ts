import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG } from '@tipsytrails/shared';
import webpush from 'web-push';
import type { Env } from '../env.js';

// SPEC.md Sections 5.9, 7.5, 7.9, 9.2, Phase 5 step 5: Web Push
// configuration. Resolves the three optional `VAPID_*` env.ts variables,
// and — since v1.10 — the on-disk key file Section 5.9 specifies, into one
// of three states. This is the one place that decision is made, so app.ts
// (startup logging + wiring the real sender) and any test never have to
// re-derive it.

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// Internal: `resolveVapidConfig` is what callers reach for, and app.ts
// switches on the `status` of what it returns without ever naming the union.
// `VapidConfig` above stays exported - push/sender.ts takes one as an
// argument and so has to be able to write the name down.
type VapidResolution =
  | { status: 'misconfigured'; missing: string[] }
  | { status: 'enabled'; config: VapidConfig }
  // The key file (Section 5.9) exists but could not be read/parsed, or a
  // fresh pair could not be generated and written. Distinct from
  // 'misconfigured': that is a typo in explicit env vars, this is optional
  // on-disk infrastructure behaving unexpectedly. `reason` is safe to log —
  // it never contains file contents, only the path and what went wrong.
  | { status: 'unavailable'; reason: string };

const VAPID_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

interface PersistedVapidKeys {
  publicKey: string;
  privateKey: string;
}

function isPersistedVapidKeys(value: unknown): value is PersistedVapidKeys {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).publicKey === 'string' &&
    typeof (value as Record<string, unknown>).privateKey === 'string'
  );
}

// Loads the persisted pair, or generates one and writes it, never leaving a
// half-written or world-readable file behind: the pair is written to a
// uniquely-named sibling file with mode 0600 (set on open and re-asserted
// with chmod, since a permissive umask can otherwise widen the mode
// `writeFileSync` requests) and only then renamed into place, so the
// well-known filename either doesn't exist yet or already holds a complete,
// owner-only-readable file.
function loadOrGenerateKeyFile(keyFilePath: string): PersistedVapidKeys | { error: string } {
  if (existsSync(keyFilePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(keyFilePath, 'utf8'));
    } catch {
      return { error: `${keyFilePath} is not valid JSON` };
    }
    if (!isPersistedVapidKeys(parsed)) {
      return { error: `${keyFilePath} does not contain a publicKey and privateKey` };
    }
    return parsed;
  }

  const generated = webpush.generateVAPIDKeys();
  try {
    const dir = dirname(keyFilePath);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tmpPath, JSON.stringify(generated), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, keyFilePath);
  } catch (err) {
    return { error: `could not write ${keyFilePath}: ${(err as Error).message}` };
  }
  return generated;
}

// Push is an enhancement (the task brief, echoing SPEC.md's "PUBLIC_ORIGIN
// and SESSION_SECRET are the only hard requirements"). All three VAPID_*
// set wins outright — most useful for local development or a fork with no
// persistent volume (Section 5.9). Some but not all three set is almost
// certainly a typo or an incomplete rollout rather than a deliberate
// choice — there is no reading of "push disabled" that involves setting
// exactly one VAPID variable — so it is reported as a distinct
// 'misconfigured' state. None set is the ordinary Pi deployment: the key
// pair lives on disk beside DATABASE_PATH instead (Section 5.9), loaded if
// present, generated and persisted if not; the subject is derived from
// PUBLIC_ORIGIN, which is already a mandatory `https:` URL, so it doubles
// as a valid Web Push subject with no reformatting.
export function resolveVapidConfig(env: Env): VapidResolution {
  const values: Record<(typeof VAPID_VARS)[number], string | undefined> = {
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: env.VAPID_SUBJECT,
  };
  const present = VAPID_VARS.filter((name) => values[name] != null);

  if (present.length === VAPID_VARS.length) {
    return {
      status: 'enabled',
      config: {
        publicKey: values.VAPID_PUBLIC_KEY as string,
        privateKey: values.VAPID_PRIVATE_KEY as string,
        subject: values.VAPID_SUBJECT as string,
      },
    };
  }
  if (present.length > 0) {
    const missing = VAPID_VARS.filter((name) => values[name] == null);
    return { status: 'misconfigured', missing };
  }

  const keyFilePath = join(dirname(env.DATABASE_PATH), CONFIG.VAPID_KEY_FILENAME);
  const result = loadOrGenerateKeyFile(keyFilePath);
  if ('error' in result) {
    return { status: 'unavailable', reason: result.error };
  }
  return {
    status: 'enabled',
    config: {
      publicKey: result.publicKey,
      privateKey: result.privateKey,
      subject: env.PUBLIC_ORIGIN,
    },
  };
}
