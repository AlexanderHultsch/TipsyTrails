// @vitest-environment node

import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CONFIG } from '@tipsytrails/shared';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Host } from './host.js';
import type { Tracker } from './tracker.js';

// ios/SPEC.md Section 12, Step A's Definition of Done, and Section 7.2: the
// two properties this substep must prove about the BUILT bundle, not the
// source. `packages/web/src/bundle.test.ts` is the precedent and the reason
// - a source-level check can pass on a bundle the shell would refuse to
// evaluate, and can fail on source a bundler tree-shook away. Building here,
// with `write: false`, is that file's technique: it needs no prior
// `pnpm build` to have been run by hand, and it measures what
// `packages/tracker/dist/tracker.js` actually contains.

const trackerRoot = fileURLToPath(new URL('..', import.meta.url));

interface OutputChunk {
  type: 'chunk';
  code: string;
}

let code = '';

beforeAll(async () => {
  const result = await build({
    root: trackerRoot,
    logLevel: 'silent',
    build: { write: false },
  });

  const outputs = (Array.isArray(result) ? result : [result]) as {
    output: readonly { type: string; code?: string }[];
  }[];
  const chunk = outputs
    .flatMap((out) => out.output)
    .find((item): item is OutputChunk => item.type === 'chunk');

  if (!chunk) {
    throw new Error('tracker build produced no JS chunk');
  }
  code = chunk.code;
}, 60_000);

// A bare `node:vm` context, contextified from the object passed in - nothing
// on it but what the test puts there, exactly as ios/SPEC.md Section 7.2
// describes the shell installing the host before evaluating the bundle.
function evaluateWithHost(host: object | undefined): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {};
  if (host !== undefined) {
    sandbox.__tipsyTrailsHost = host;
  }
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  return context;
}

// Hand-kept against `Tracker` (tracker.ts) - not derived, because deriving it
// from the interface's own source would mean parsing TypeScript here, and
// that needs the `typescript` package, which `packages/tracker/package.json`
// does not declare (only the root does; this file resolving it today is
// pnpm's hoisting, not a declared dependency of this package). If this list
// drifts from `Tracker`, `pnpm typecheck` catches half of it for free:
// `index.ts` assigns `{ ...createTracker(host), config: CONFIG }` to a global
// declared as `Tracker & { config: typeof CONFIG }`, so a member missing from
// the spread is a compile error before this test ever runs. What typecheck
// cannot see, and what this list is actually for, is whether a member that
// does exist in the source survives into the BUILT IIFE below - the bundler
// is the one step between the two that nothing else here looks at, and a
// member the shell calls that the bundle does not expose is a runtime
// failure on a device, which is the one place nothing in this repository can
// look.
const TRACKER_MEMBER_NAMES: (keyof Tracker)[] = [
  'start',
  'submitFix',
  'setAppState',
  'setAuthorization',
  'setLowPower',
  'visitStarted',
  'visitEnded',
  'signedOut',
  'requestState',
  'snapshotCounters',
  'setDiscoveryNotifications',
];

describe('the built tracker bundle', () => {
  it('defines globalThis.__tipsyTrails given a host, exposing every Tracker member as a function, and throws given none', () => {
    const withHost = evaluateWithHost({});
    expect(withHost.__tipsyTrails).toBeDefined();
    const exposed = withHost.__tipsyTrails as Tracker & { config: typeof CONFIG } & Record<
        string,
        unknown
      >;

    expect(exposed.config.FOG_REVEAL_RADIUS_M).toBe(CONFIG.FOG_REVEAL_RADIUS_M);

    for (const name of TRACKER_MEMBER_NAMES) {
      expect(typeof exposed[name], `__tipsyTrails.${name} is not a function`).toBe('function');
    }

    expect(() => evaluateWithHost(undefined)).toThrow();
  });

  it('does not call any host method merely by being evaluated', () => {
    // ios/SPEC.md 4.4: the shell evaluates the bundle on its serial queue and
    // only later calls `start` once it is ready - construction must be inert.
    // Every method on this host throws, so any call at all during evaluation
    // fails the test.
    const throwingHost: Host = {
      now: () => {
        throw new Error('Host.now called during evaluation');
      },
      setTimeout: () => {
        throw new Error('Host.setTimeout called during evaluation');
      },
      clearTimeout: () => {
        throw new Error('Host.clearTimeout called during evaluation');
      },
      fetch: () => {
        throw new Error('Host.fetch called during evaluation');
      },
      configureLocation: () => {
        throw new Error('Host.configureLocation called during evaluation');
      },
      requestSignificantChanges: () => {
        throw new Error('Host.requestSignificantChanges called during evaluation');
      },
      scheduleNotification: () => {
        throw new Error('Host.scheduleNotification called during evaluation');
      },
      cancelNotification: () => {
        throw new Error('Host.cancelNotification called during evaluation');
      },
      emit: () => {
        throw new Error('Host.emit called during evaluation');
      },
      log: () => {
        throw new Error('Host.log called during evaluation');
      },
    };

    expect(() => evaluateWithHost(throwingHost)).not.toThrow();
  });

  it('contains no reference to window, document, navigator or localStorage', () => {
    // Word-bounded: CONFIG's RATE_LIMITS carries a `windowMs` field on every
    // entry (packages/shared/src/config.ts), an unmangled object-literal key
    // that a plain substring match would misreport as the browser global.
    for (const name of ['window', 'document', 'navigator', 'localStorage']) {
      const reference = new RegExp(`\\b${name}\\b`);
      expect(reference.test(code), `built tracker bundle references "${name}"`).toBe(false);
    }
  });
});
