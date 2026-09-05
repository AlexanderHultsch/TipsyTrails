// @vitest-environment node

import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CONFIG } from '@tipsytrails/shared';
import { build } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';

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

describe('the built tracker bundle', () => {
  it('defines globalThis.__tipsyTrails given a host, and throws given none', () => {
    const withHost = evaluateWithHost({});
    expect(withHost.__tipsyTrails).toBeDefined();
    expect((withHost.__tipsyTrails as { config: typeof CONFIG }).config.FOG_REVEAL_RADIUS_M).toBe(
      CONFIG.FOG_REVEAL_RADIUS_M,
    );

    expect(() => evaluateWithHost(undefined)).toThrow();
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
