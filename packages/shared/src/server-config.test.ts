import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { SERVER_CONFIG } from './server-config.js';

// These three assertions moved here from config.test.ts in v1.54, unchanged,
// when the floors they pin moved out of CONFIG (SPEC.md Sections 7.1, 7.7).
describe('SERVER_CONFIG.BADGE_THRESHOLDS', () => {
  it('matches the spec values for explorer', () => {
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.explorer.week).toBe(0.1);
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.explorer.month).toBe(0.3);
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.explorer.year).toBe(2.0);
  });

  it('matches the spec values for barfly', () => {
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.barfly.week).toBe(1);
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.barfly.month).toBe(2);
    expect(SERVER_CONFIG.BADGE_THRESHOLDS.barfly.year).toBe(3);
  });

  it('never demands more of a shorter period than a longer one', () => {
    for (const badge of [
      SERVER_CONFIG.BADGE_THRESHOLDS.explorer,
      SERVER_CONFIG.BADGE_THRESHOLDS.barfly,
    ]) {
      expect(badge.week).toBeLessThanOrEqual(badge.month);
      expect(badge.month).toBeLessThanOrEqual(badge.year);
    }
  });

  // The `satisfies` clause in server-config.ts is what actually stops the two
  // files drifting, and it does so at compile time - `pnpm typecheck` fails,
  // and no test can observe that. What a test *can* observe is the same
  // agreement at runtime, which is worth having because it is the property a
  // reader cares about: every kind the browser draws a shelf for has floors
  // here, and there are floors for nothing else.
  it('holds floors for exactly the kinds CONFIG names', () => {
    expect(Object.keys(SERVER_CONFIG.BADGE_THRESHOLDS).sort()).toEqual(
      [...CONFIG.BADGE_KINDS].sort(),
    );
  });
});

// SPEC.md Section 7.1: two constants modules and no third. The unreachability
// of this one from packages/web is proved by the bundle, in
// packages/web/src/bundle.test.ts; what is checked here is the other half of
// the arrangement, which that test cannot see - that the module stays out of
// the package's client-safe entry point in the first place.
describe('the server-only module is not on the public entry point', () => {
  const indexSource = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf-8');

  it('is not re-exported by index.ts', () => {
    expect(
      indexSource.split('\n').filter((line) => /^\s*export\b.*server-config/.test(line)),
      'index.ts is what packages/web imports; re-exporting server-config.js here puts the badge ' +
        'floors back in the browser bundle, which is the leak SPEC.md Section 7.7 forbids',
    ).toEqual([]);
  });

  it('has its own subpath in package.json, so nothing reaches it by accident', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
    ) as { exports: Record<string, { default: string }> };

    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './server']);
    expect(manifest.exports['./server'].default).toBe('./dist/server-config.js');
    expect(manifest.exports['.'].default).toBe('./dist/index.js');
  });
});
