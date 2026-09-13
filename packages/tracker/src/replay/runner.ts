// ios/SPEC.md Section 13.2: the driving half of the harness. `bundle.ts`
// builds and evaluates the tracker, `host.ts` gives it a clock and a
// `fetch`, and `route.ts` builds the walk it is driven with - this module
// is what starts a run and steps it forward, one scenario at a time.
// Nothing here asserts anything; assertions belong to `scenarios.test.ts`.
import type { Sample } from '../events.js';
import type { StartInput, Tracker } from '../tracker.js';
import { createReplayHost } from './host.js';
import type { ReplayHost } from './host.js';
import { loadTrackerBundle } from './bundle.js';
import type { HostRequest, HostResponse } from '../host.js';

export interface ReplayRun {
  host: ReplayHost;
  tracker: Tracker;
}

export interface StartReplayOptions {
  startMs: number;
  fetch: (input: HostRequest) => Promise<HostResponse>;
  start: StartInput;
}

export async function startReplay(options: StartReplayOptions): Promise<ReplayRun> {
  const host = createReplayHost({ startMs: options.startMs, fetch: options.fetch });
  const tracker = await loadTrackerBundle(host);
  await tracker.start(options.start);
  await settle();
  return { host, tracker };
}

// One macrotask turn. Node drains the entire microtask queue before running
// a `setImmediate` callback, so this is enough to let every `await` the
// tracker's own code is sitting in (`start`'s sequential calls, a flush's
// `postSamples`) resolve, however many of them are chained - the fake
// clock that ticks a flush timer is synchronous and returns before any of
// that settles, so a scenario that wants to observe the result needs this
// in between.
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// Fires every timer due at or before `targetMs` one at a time, letting the
// tracker's promises settle between each - `host.advanceTo` cannot be used
// for this, because it fires every due timer in one synchronous sweep with
// no chance for an asynchronous flush to resolve in between. Once nothing
// more is due, `advanceTo` moves the clock the rest of the way to
// `targetMs` (a no-op if a timer's own due time already reached it) and a
// final `settle()` lets whatever that last timer started resolve too.
export async function advanceSettled(host: ReplayHost, targetMs: number): Promise<void> {
  while (host.fireNextDueTimer(targetMs)) {
    await settle();
  }
  host.advanceTo(targetMs);
  await settle();
}

// Walks `route` in order: advances the clock to each fix's own timestamp
// (settling every timer that becomes due along the way), hands the fix to
// the tracker, and settles once more so its reaction - enqueue, a flush it
// triggers, a profile change - is visible before the next fix is submitted.
export async function walk(run: ReplayRun, route: Sample[]): Promise<void> {
  for (const fix of route) {
    await advanceSettled(run.host, fix.timestamp);
    run.tracker.submitFix(fix);
    await settle();
  }
}
