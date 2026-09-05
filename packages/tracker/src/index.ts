// ios/SPEC.md Section 7.2 - the host interface - and Section 4.4's process
// model: the shell creates a JSContext on its one serial tracker queue,
// installs `globalThis.__tipsyTrailsHost` on it, and only then evaluates
// this bundle. This file is the IIFE entry Section 4.2 names, and this
// substep (Section 12, Step B) wires the tracker Steps B1-B7 built behind
// `globalThis.__tipsyTrails`.
//
// What it proves here is the two halves of the wiring this substep exists
// for: the shell must supply a host before anything in this package can
// run at all (a missing one is a wiring fault, not a silent no-op), and
// `@tipsytrails/shared` is genuinely bundled into the IIFE rather than left
// as an import JavaScriptCore has no module loader to resolve (Section 2.3,
// Section 3's "Exact dependencies").
import { CONFIG } from '@tipsytrails/shared';
import { createTracker } from './tracker.js';
import type { Tracker } from './tracker.js';
import type { Host } from './host.js';

// The host is Section 7.2's `Host` interface, defined in `host.ts` (Step B1).
declare global {
  var __tipsyTrailsHost: Host;
  var __tipsyTrails: (Tracker & { config: typeof CONFIG }) | undefined;
}

if (typeof globalThis.__tipsyTrailsHost === 'undefined') {
  throw new Error(
    'TipsyTrailsHostMissing: globalThis.__tipsyTrailsHost was not installed before the ' +
      'tracker bundle was evaluated (ios/SPEC.md Section 7.2) - the shell must install the ' +
      'host before running this script',
  );
}

// `config` is not part of the surface the shell calls - Section 7.3 names no
// call that reads it, and the shell has no reason to read it either. It is
// here so `index.test.ts` can assert, from outside, that
// `@tipsytrails/shared` was genuinely bundled into this IIFE rather than left
// as an import JavaScriptCore has no module loader to resolve: that failure
// would otherwise surface only at runtime, on a device.
globalThis.__tipsyTrails = { ...createTracker(globalThis.__tipsyTrailsHost), config: CONFIG };
