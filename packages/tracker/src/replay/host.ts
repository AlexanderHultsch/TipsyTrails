// ios/SPEC.md Section 13.2: the replay harness's `Host`. `fakeHost` in
// `packages/tracker/src/tracker.test.ts` is the precedent for what a fake
// host records and how; this module rebuilds the same shape as a reusable,
// Vitest-free export so a scenario runner (a later step) can drive it, and
// so a scenario can hand it `app.inject` - or, today, a stub - as its
// `fetch`.
//
// Unlike `fakeHost`, whose tests move time by setting it directly and
// firing one timer at a time by hand, this host owns the clock itself:
// `advanceTo`/`advanceBy` fire every timer due by the target time, in
// due-time order, including a timer a firing timer schedules for a time at
// or before that same target - which is what lets a scenario say "run the
// walk for twenty-five minutes" once rather than stepping tick by tick.
import type { TrackerEvent } from '../events.js';
import type {
  Host,
  HostRequest,
  HostResponse,
  LocalNotification,
  LocationProfile,
} from '../host.js';

interface FakeTimer {
  id: number;
  dueMs: number;
  fn: () => void;
}

interface FakeClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  advanceTo(targetMs: number): void;
  advanceBy(deltaMs: number): void;
  pendingTimers(): { id: number; dueMs: number }[];
  fireNextDueTimer(uptoMs: number): boolean;
}

// The selection `advanceTo`'s sweep and `fireNextDueTimer` both need: the
// timer due soonest at or before `uptoMs`, ties broken by the lower id (a
// lower id was scheduled first).
function findNextDueTimer(timers: Map<number, FakeTimer>, uptoMs: number): FakeTimer | undefined {
  let next: FakeTimer | undefined;
  for (const timer of timers.values()) {
    if (timer.dueMs > uptoMs) {
      continue;
    }
    if (!next || timer.dueMs < next.dueMs || (timer.dueMs === next.dueMs && timer.id < next.id)) {
      next = timer;
    }
  }
  return next;
}

function createFakeClock(startMs: number): FakeClock {
  let nowMs = startMs;
  let nextTimerId = 1;
  const timers = new Map<number, FakeTimer>();

  function fireDueTimers(targetMs: number): void {
    for (;;) {
      const next = findNextDueTimer(timers, targetMs);
      if (!next) {
        break;
      }
      timers.delete(next.id);
      nowMs = next.dueMs;
      next.fn();
    }
    nowMs = targetMs;
  }

  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { id, dueMs: nowMs + ms, fn });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advanceTo: (targetMs) => {
      if (targetMs < nowMs) {
        throw new Error(
          `the replay clock cannot move backwards (now=${nowMs}, target=${targetMs})`,
        );
      }
      fireDueTimers(targetMs);
    },
    advanceBy: (deltaMs) => {
      if (nowMs + deltaMs < nowMs) {
        throw new Error(`the replay clock cannot move backwards (delta=${deltaMs})`);
      }
      fireDueTimers(nowMs + deltaMs);
    },
    pendingTimers: () => [...timers.values()].map(({ id, dueMs }) => ({ id, dueMs })),
    // The tracker's flush is asynchronous (its timer callback kicks off a
    // `fetch` this clock cannot await) while this clock is synchronous, so a
    // scenario that wants promises to settle between one timer and the next
    // cannot use `advanceTo`, which fires every due timer in one synchronous
    // sweep. This fires only the single earliest timer due at or before
    // `uptoMs` (the same tie-break as `advanceTo`), moves the clock to that
    // timer's own due time, and reports whether one fired - the clock is
    // left exactly where it was when nothing is due.
    fireNextDueTimer: (uptoMs) => {
      const next = findNextDueTimer(timers, uptoMs);
      if (!next) {
        return false;
      }
      timers.delete(next.id);
      nowMs = next.dueMs;
      next.fn();
      return true;
    },
  };
}

export interface ReplayHostExchange {
  request: HostRequest;
  response?: HostResponse;
  error?: unknown;
}

export interface ReplayHost extends Host {
  advanceTo(targetMs: number): void;
  advanceBy(deltaMs: number): void;
  pendingTimers(): { id: number; dueMs: number }[];
  fireNextDueTimer(uptoMs: number): boolean;
  setFetch(fn: (input: HostRequest) => Promise<HostResponse>): void;
  currentProfile(): LocationProfile | null;
  requests: HostRequest[];
  exchanges: ReplayHostExchange[];
  configureLocationCalls: LocationProfile[];
  significantChangesCalls: boolean[];
  scheduledNotifications: LocalNotification[];
  cancelledNotificationIds: string[];
  emitted: TrackerEvent[];
  logs: string[];
}

export interface CreateReplayHostOptions {
  startMs: number;
  fetch: (input: HostRequest) => Promise<HostResponse>;
}

export function createReplayHost(options: CreateReplayHostOptions): ReplayHost {
  const clock = createFakeClock(options.startMs);
  let fetchImpl = options.fetch;
  let lastProfile: LocationProfile | null = null;

  const requests: HostRequest[] = [];
  const exchanges: ReplayHostExchange[] = [];
  const configureLocationCalls: LocationProfile[] = [];
  const significantChangesCalls: boolean[] = [];
  const scheduledNotifications: LocalNotification[] = [];
  const cancelledNotificationIds: string[] = [];
  const emitted: TrackerEvent[] = [];
  const logs: string[] = [];

  return {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: async (input) => {
      requests.push(input);
      try {
        const response = await fetchImpl(input);
        exchanges.push({ request: input, response });
        return response;
      } catch (error) {
        exchanges.push({ request: input, error });
        throw error;
      }
    },
    configureLocation: (profile) => {
      configureLocationCalls.push(profile);
      lastProfile = profile;
    },
    requestSignificantChanges: (on) => significantChangesCalls.push(on),
    scheduleNotification: (n) => scheduledNotifications.push(n),
    cancelNotification: (id) => cancelledNotificationIds.push(id),
    emit: (event) => emitted.push(event),
    log: (level, message) => logs.push(`${level}: ${message}`),
    advanceTo: clock.advanceTo,
    advanceBy: clock.advanceBy,
    pendingTimers: clock.pendingTimers,
    fireNextDueTimer: clock.fireNextDueTimer,
    setFetch: (fn) => {
      fetchImpl = fn;
    },
    currentProfile: () => lastProfile,
    requests,
    exchanges,
    configureLocationCalls,
    significantChangesCalls,
    scheduledNotifications,
    cancelledNotificationIds,
    emitted,
    logs,
  };
}
