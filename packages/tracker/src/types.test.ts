import { describe, expect, it } from 'vitest';
import type {
  FlushEvent,
  NotificationEvent,
  PositionEvent,
  QueueEvent,
  SessionLostEvent,
  TrackerEvent,
  TrackingEvent,
  VisitEvent,
} from './events.js';
import type {
  Host,
  HostRequest,
  HostResponse,
  LocalNotification,
  LocationProfile,
} from './host.js';

// host.ts and events.ts declare types only and have no runtime behaviour of
// their own. What proves them is that `pnpm typecheck` accepts every value
// constructed below and would reject a wrong one - a missing member, a
// misspelt discriminant, a payload field of the wrong shape. This file is a
// compile-time test wearing a runtime test's clothes: a green `vitest run`
// here means the values below happened to type-check at the time this file
// was last edited, not that anything in the tracker works. Read it for what
// `pnpm typecheck` says of it, not for what `vitest` says.

describe('TrackerEvent (compile-time contract)', () => {
  it('constructs one well-formed value of every member', () => {
    const tracking: TrackingEvent = {
      type: 'tracking',
      state: 'tracking',
      profile: 'foreground',
      background: true,
      authorization: { status: 'authorizedAlways', accuracy: 'fullAccuracy' },
      lowPower: false,
    };

    const position: PositionEvent = {
      type: 'position',
      lat: 49.0069,
      lon: 8.4037,
      accuracy: 10,
      speed: null,
      timestamp: 1_700_000_000_000,
      receivedAt: 1_700_000_000_500,
    };

    const flush: FlushEvent = {
      type: 'flush',
      newCells: 3,
      newBars: [],
      visitUpdates: [],
      tooFastToReveal: false,
      rejected: { accuracy: 0, future: 0, stale: 0, outsideCity: 0, tooFast: 0 },
      sent: 5,
      behind: 0,
      queued: 0,
    };

    const queue: QueueEvent = { type: 'queue', queued: 2, behind: 0 };

    const visit: VisitEvent = {
      type: 'visit',
      id: 1,
      barId: 2,
      barName: 'Vogelbräu',
      startedAt: 1_700_000_000,
      lastSampleAt: 1_700_000_100,
      onsiteSamples: 2,
      confirmedS: 1200,
      remainingS: 0,
      status: 'completed',
    };

    const sessionLost: SessionLostEvent = { type: 'sessionLost', cause: 'cookie' };

    const notification: NotificationEvent = {
      type: 'notification',
      id: 'visit-1',
      atMs: 1_700_000_000_000,
      title: 'Bar mastered',
      body: 'Vogelbräu',
    };

    const events: TrackerEvent[] = [
      tracking,
      position,
      flush,
      queue,
      visit,
      sessionLost,
      notification,
    ];

    expect(events.map((event) => event.type)).toEqual([
      'tracking',
      'position',
      'flush',
      'queue',
      'visit',
      'sessionLost',
      'notification',
    ]);
  });
});

describe('Host (compile-time contract)', () => {
  it('is satisfied by one object with stub method bodies', () => {
    let nextTimeoutId = 1;
    const emitted: TrackerEvent[] = [];

    const host: Host = {
      now: () => 1_700_000_000_000,
      setTimeout: (fn, ms) => {
        void fn;
        void ms;
        return nextTimeoutId++;
      },
      clearTimeout: (id) => {
        void id;
      },
      fetch: async (input: HostRequest): Promise<HostResponse> => {
        void input;
        return { status: 200, headers: {}, body: '{}' };
      },
      configureLocation: (profile: LocationProfile) => {
        void profile;
      },
      requestSignificantChanges: (on) => {
        void on;
      },
      scheduleNotification: (n: LocalNotification) => {
        void n;
      },
      cancelNotification: (id) => {
        void id;
      },
      emit: (event) => {
        emitted.push(event);
      },
      log: (level, message) => {
        void level;
        void message;
      },
    };

    host.emit({ type: 'sessionLost', cause: 'unauthenticated' });

    expect(emitted).toHaveLength(1);
  });
});
