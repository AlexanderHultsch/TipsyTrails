import type { Env } from '../env.js';

// SPEC.md Sections 5.9, 7.5, 7.9, 9.2, Phase 5 step 5: Web Push
// configuration. Resolves the three optional `VAPID_*` env.ts variables
// into one of three states — this is the one place that decision is made,
// so app.ts (startup logging + wiring the real sender) and any test never
// have to re-derive it.

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type VapidResolution =
  | { status: 'disabled' }
  | { status: 'misconfigured'; missing: string[] }
  | { status: 'enabled'; config: VapidConfig };

const VAPID_VARS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

// Push is an enhancement (the task brief, echoing SPEC.md's "PUBLIC_ORIGIN
// and SESSION_SECRET are the only hard requirements"): none of the three
// set is the ordinary, deliberate "push is off" deployment and must not
// warn. Some but not all three set is almost certainly a typo or an
// incomplete rollout rather than a deliberate choice — there is no reading
// of "push disabled" that involves setting exactly one VAPID variable — so
// it is reported as a distinct 'misconfigured' state. Both states leave
// push equally disabled; only the log severity app.ts chooses for them
// differs.
export function resolveVapidConfig(env: Env): VapidResolution {
  const values: Record<(typeof VAPID_VARS)[number], string | undefined> = {
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: env.VAPID_SUBJECT,
  };
  const present = VAPID_VARS.filter((name) => values[name] != null);

  if (present.length === 0) {
    return { status: 'disabled' };
  }
  if (present.length < VAPID_VARS.length) {
    const missing = VAPID_VARS.filter((name) => values[name] == null);
    return { status: 'misconfigured', missing };
  }
  return {
    status: 'enabled',
    config: {
      publicKey: values.VAPID_PUBLIC_KEY as string,
      privateKey: values.VAPID_PRIVATE_KEY as string,
      subject: values.VAPID_SUBJECT as string,
    },
  };
}
