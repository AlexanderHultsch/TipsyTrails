// ios/SPEC.md Section 13.2 and Step E's Definition of Done (Section 12): the
// harness runs "the built tracker" against a `Host`, not `createTracker`
// from source - the contract Section 7.2 states is that the shell evaluates
// a bundle it was handed, and `index.ts`'s IIFE entry (this package's own
// wiring, Section 12 Step B7) is what decides whether `@tipsytrails/shared`
// truly ends up inside it. A scenario that imported `./tracker.js` directly
// would prove none of that - it would pass on a bundle JavaScriptCore could
// never evaluate, and fail on nothing a bundler might tree-shake away - so
// this module builds and evaluates the same bytes `index.test.ts` already
// does, and every scenario in `scenarios.test.ts` goes through it instead of
// through `../tracker.js`.
//
// Building here with Vite (`write: false`), rather than reading
// `packages/tracker/dist/tracker.js` off disk, is `index.test.ts`'s own
// reasoning, carried over unchanged: it needs no prior `pnpm build` to have
// been run by hand, and it measures exactly what a fresh build produces
// rather than whatever a stale `dist/` happens to hold.
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '@tipsytrails/shared';
import { build } from 'vite';
import type { Host } from '../host.js';
import type { Tracker } from '../tracker.js';

const trackerRoot = fileURLToPath(new URL('../..', import.meta.url));

interface OutputChunk {
  type: 'chunk';
  code: string;
}

// Cached across scenarios - `index.test.ts` builds once per file (in a
// `beforeAll`) for the same reason: the build itself is the slow part, and
// nothing about it depends on which scenario is driving the result.
let cachedCode: string | undefined;

export async function buildTrackerCode(): Promise<string> {
  if (cachedCode !== undefined) {
    return cachedCode;
  }
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
  cachedCode = chunk.code;
  return cachedCode;
}

// ios/SPEC.md Section 7.2: a bare `node:vm` context whose only global is
// `__tipsyTrailsHost`, evaluated exactly as the shell installs the host on
// its serial queue before running this script. `index.ts`'s own guard
// throws if the host is missing, and assigns `globalThis.__tipsyTrails`
// once it is present - this is what the harness reads back.
export async function loadTrackerBundle(host: Host): Promise<Tracker & { config: typeof CONFIG }> {
  const code = await buildTrackerCode();
  const sandbox: Record<string, unknown> = { __tipsyTrailsHost: host };
  const context = vm.createContext(sandbox);
  vm.runInContext(code, context);
  return context.__tipsyTrails as Tracker & { config: typeof CONFIG };
}
