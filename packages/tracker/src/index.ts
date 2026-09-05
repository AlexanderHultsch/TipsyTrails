// ios/SPEC.md Section 7.2 - the host interface - and Section 4.4's process
// model: the shell creates a JSContext on its one serial tracker queue,
// installs `globalThis.__tipsyTrailsHost` on it, and only then evaluates
// this bundle. This file is the IIFE entry Section 4.2 names, and at this
// substep (Section 12, Step A) it is deliberately almost empty - Steps
// B1-B7 build the tracker itself behind `globalThis.__tipsyTrails`.
//
// What it proves here is the two halves of the wiring this substep exists
// for: the shell must supply a host before anything in this package can
// run at all (a missing one is a wiring fault, not a silent no-op), and
// `@tipsytrails/shared` is genuinely bundled into the IIFE rather than left
// as an import JavaScriptCore has no module loader to resolve (Section 2.3,
// Section 3's "Exact dependencies").
import { CONFIG } from '@tipsytrails/shared';

// The host is Section 7.2's `Host` interface, which `host.ts` (Step B1)
// defines; declared as `unknown` here rather than against an interface this
// substep does not create. `__tipsyTrails` is likewise only as wide as this
// substep's contents - Steps B1-B7 add the rest of its surface.
declare global {
  var __tipsyTrailsHost: unknown;
  var __tipsyTrails: { config: typeof CONFIG } | undefined;
}

if (typeof globalThis.__tipsyTrailsHost === 'undefined') {
  throw new Error(
    'TipsyTrailsHostMissing: globalThis.__tipsyTrailsHost was not installed before the ' +
      'tracker bundle was evaluated (ios/SPEC.md Section 7.2) - the shell must install the ' +
      'host before running this script',
  );
}

globalThis.__tipsyTrails = { config: CONFIG };
