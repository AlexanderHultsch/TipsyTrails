// @vitest-environment node

// ios/SPEC.md Section 13.2, scenarios 6-8: the three that assert only on the
// tracker's own requests, state and events, so they need no database and run
// now, through the BUILT BUNDLE (`bundle.ts`) rather than `../tracker.js` -
// what makes this more than a repeat of `tracker.test.ts`. Scenarios 1-5
// assert against SQLite through the real Fastify app and are not built here
// (blocked on row 14 of "The list for `main`", Section 12).
import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import type { Sample, SessionLostEvent, TrackerEvent, TrackingEvent } from '../events.js';
import type { HostResponse } from '../host.js';
import type { Authorization, StartInput } from '../tracker.js';
import { buildRoute, loadSeedBars, pickRouteBars, WALKING_SPEED_MPS } from './route.js';
import { createFakeApi, jsonResponse } from './fake-api.js';
import type { FakeApiScript } from './fake-api.js';
import { settle, startReplay, walk } from './runner.js';
import type { ReplayRun } from './runner.js';

const START_MS = 1_700_000_000_000;

// 13.2's own route: the first pair of seed bars 900-1100 m apart, walked
// straight between them at `WALKING_SPEED_MPS`, one fix per second. Long
// enough (several hundred fixes) that every scenario below only ever needs
// a short prefix of it.
function buildTestRoute(): Sample[] {
  const bars = loadSeedBars();
  const [from, to] = pickRouteBars(bars);
  return buildRoute({ from, to, startMs: START_MS, speedMps: WALKING_SPEED_MPS, seed: 1 });
}

function fullyAuthorized(): Authorization {
  return { status: 'authorizedAlways', accuracy: 'fullAccuracy', servicesEnabled: true };
}

function startInput(overrides: Partial<StartInput> = {}): StartInput {
  return {
    appState: 'foreground',
    cause: 'user',
    hasCookie: true,
    authorization: fullyAuthorized(),
    lowPower: false,
    discoveryNotifications: true,
    ...overrides,
  };
}

function lastTracking(emitted: TrackerEvent[]): TrackingEvent {
  const events = emitted.filter((event): event is TrackingEvent => event.type === 'tracking');
  const last = events.at(-1);
  if (!last) {
    throw new Error('no tracking event was emitted');
  }
  return last;
}

describe('scenario 6 - reduced accuracy (ios/SPEC.md 13.2)', () => {
  it(
    'blocks while reducedAccuracy stands, makes no request meanwhile, and resumes tracking ' +
      'once it lifts',
    async () => {
      const route = buildTestRoute();
      const script: FakeApiScript = {};
      const api = createFakeApi(script);
      const run: ReplayRun = await startReplay({
        startMs: START_MS,
        fetch: api.fetch,
        start: startInput(),
      });

      // Walk past the first ordinary flush before blocking, so "the
      // request count does not rise" is a real assertion rather than one
      // that would have been true anyway because none had happened yet.
      const idxAt = (ms: number) => (ms - START_MS) / 1000;
      const blockAtMs = START_MS + CONFIG.SAMPLE_MIN_INTERVAL_MS + 3000;
      await walk(run, route.slice(0, idxAt(blockAtMs) + 1));

      const requestsBeforeBlock = run.host.requests.length;
      expect(requestsBeforeBlock).toBeGreaterThan(0);

      run.tracker.setAuthorization({
        status: 'authorizedAlways',
        accuracy: 'reducedAccuracy',
        servicesEnabled: true,
      });
      await settle();

      const blockedEvent = lastTracking(run.host.emitted);
      expect(blockedEvent.state).toBe('blocked');
      expect(blockedEvent.reason).toBe('reducedAccuracy');

      // A full flush interval and more, still blocked: the flush timer was
      // stopped by the transition into `blocked` (tracker.ts's
      // `transition`), so no fix arriving in this stretch can produce a
      // request.
      const resumeAtMs = blockAtMs + CONFIG.SAMPLE_MIN_INTERVAL_MS + 3000;
      await walk(run, route.slice(idxAt(blockAtMs) + 1, idxAt(resumeAtMs) + 1));
      expect(run.host.requests.length).toBe(requestsBeforeBlock);

      run.tracker.setAuthorization(fullyAuthorized());
      await settle();

      expect(lastTracking(run.host.emitted).state).toBe('tracking');
    },
  );
});

describe('scenario 7 - session ends (ios/SPEC.md 13.2)', () => {
  it(
    'emits exactly one sessionLost, goes idle, and makes no further request whatever fixes ' +
      'arrive afterwards',
    async () => {
      const route = buildTestRoute();
      const script: FakeApiScript = {};
      const api = createFakeApi(script);
      const run: ReplayRun = await startReplay({
        startMs: START_MS,
        fetch: api.fetch,
        start: startInput(),
      });

      const idxAt = (ms: number) => (ms - START_MS) / 1000;
      const firstFlushMs = START_MS + CONFIG.SAMPLE_MIN_INTERVAL_MS;
      await walk(run, route.slice(0, idxAt(firstFlushMs) + 3));

      script.samples = jsonResponse(401, { code: 'unauthenticated' });

      const secondFlushMs = firstFlushMs + CONFIG.SAMPLE_MIN_INTERVAL_MS;
      await walk(run, route.slice(idxAt(firstFlushMs) + 3, idxAt(secondFlushMs) + 3));

      const sessionLostEvents = run.host.emitted.filter(
        (event): event is SessionLostEvent => event.type === 'sessionLost',
      );
      expect(sessionLostEvents).toEqual([{ type: 'sessionLost', cause: 'unauthenticated' }]);
      expect(lastTracking(run.host.emitted).state).toBe('idle');

      const requestsAfterLoss = run.host.requests.length;
      await walk(run, route.slice(idxAt(secondFlushMs) + 3, idxAt(secondFlushMs) + 3 + 90));
      expect(run.host.requests.length).toBe(requestsAfterLoss);
    },
  );
});

describe('scenario 8 - rate limited (ios/SPEC.md 13.2)', () => {
  it(
    'waits exactly Retry-After before the next flush, and the flush after that shows the ' +
      'backoff reset',
    async () => {
      const route = buildTestRoute();
      const script: FakeApiScript = {};
      const api = createFakeApi(script);
      const run: ReplayRun = await startReplay({
        startMs: START_MS,
        fetch: api.fetch,
        start: startInput(),
      });

      const idxAt = (ms: number) => (ms - START_MS) / 1000;
      const firstFlushMs = START_MS + CONFIG.SAMPLE_MIN_INTERVAL_MS;
      const secondFlushMs = firstFlushMs + CONFIG.SAMPLE_MIN_INTERVAL_MS;
      const retryAfterS = 30;
      const retryFlushMs = secondFlushMs + retryAfterS * 1000;
      const nextOrdinaryFlushMs = retryFlushMs + CONFIG.SAMPLE_MIN_INTERVAL_MS;

      // Past the first (ordinary, successful) flush.
      await walk(run, route.slice(0, idxAt(firstFlushMs) + 3));

      const rateLimited: HostResponse = {
        status: 429,
        headers: { 'Retry-After': String(retryAfterS) },
        body: '{}',
      };
      script.samples = rateLimited;

      // Past the second flush, which the harness scripts as the 429.
      await walk(run, route.slice(idxAt(firstFlushMs) + 3, idxAt(secondFlushMs) + 3));
      const requestsAfterRateLimit = run.host.requests.length;

      // Clear the script now, not because it changes when the next request
      // happens (only the fake clock's timers decide that), but so the
      // retried flush - whenever it comes - succeeds.
      script.samples = undefined;

      // Twenty-nine seconds after the 429: not yet.
      await walk(run, route.slice(idxAt(secondFlushMs) + 3, idxAt(retryFlushMs - 1000) + 1));
      expect(run.host.requests.length).toBe(requestsAfterRateLimit);

      // Thirty seconds after the 429: exactly then, and it succeeds.
      await walk(run, route.slice(idxAt(retryFlushMs - 1000) + 1, idxAt(retryFlushMs) + 3));
      expect(run.host.requests.length).toBe(requestsAfterRateLimit + 1);

      // The backoff is reset: the next flush after that success lands at
      // the ordinary SAMPLE_MIN_INTERVAL_MS cadence, not a compounded delay.
      const requestsAfterRetry = run.host.requests.length;
      await walk(run, route.slice(idxAt(retryFlushMs) + 3, idxAt(nextOrdinaryFlushMs - 1000) + 1));
      expect(run.host.requests.length).toBe(requestsAfterRetry);

      await walk(
        run,
        route.slice(idxAt(nextOrdinaryFlushMs - 1000) + 1, idxAt(nextOrdinaryFlushMs) + 3),
      );
      expect(run.host.requests.length).toBe(requestsAfterRetry + 1);
    },
  );
});
