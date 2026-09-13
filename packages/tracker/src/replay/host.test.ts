// ios/SPEC.md Section 13.2, Step E's substep E1 (Section 12). No filesystem
// access here, so this file runs under Vitest's default environment.
import { describe, expect, it, vi } from 'vitest';
import type { HostRequest, HostResponse } from '../host.js';
import { createReplayHost } from './host.js';

const START_MS = 1_700_000_000_000;

function okResponse(): HostResponse {
  return { status: 200, headers: {}, body: '{}' };
}

describe('createReplayHost - the fake clock', () => {
  it('advanceTo fires due timers in due-time order', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => order.push('b'), 2000);
    host.setTimeout(() => order.push('a'), 1000);
    host.advanceTo(START_MS + 3000);
    expect(order).toEqual(['a', 'b']);
  });

  it('fires a timer scheduled during firing when its due time is not later than the target', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => {
      order.push('first');
      host.setTimeout(() => order.push('chained'), 500);
    }, 1000);
    host.advanceTo(START_MS + 1500);
    expect(order).toEqual(['first', 'chained']);
  });

  it('does not fire a timer chained beyond the target in the same call', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => {
      order.push('first');
      host.setTimeout(() => order.push('too-late'), 1000);
    }, 1000);
    host.advanceTo(START_MS + 1500);
    expect(order).toEqual(['first']);
    expect(host.pendingTimers()).toEqual([{ id: 2, dueMs: START_MS + 2000 }]);
  });

  it('never fires a cleared timer', () => {
    const fn = vi.fn();
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    const id = host.setTimeout(fn, 1000);
    host.clearTimeout(id);
    host.advanceTo(START_MS + 5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('advanceBy moves the clock forward by the given delta', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.advanceBy(1234);
    expect(host.now()).toBe(START_MS + 1234);
  });

  it('refuses to move the clock backwards', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.advanceTo(START_MS + 1000);
    expect(() => host.advanceTo(START_MS)).toThrow();
  });

  it('exposes pending timers with their due time', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => {}, 1000);
    host.setTimeout(() => {}, 2000);
    expect(host.pendingTimers()).toEqual([
      { id: 1, dueMs: START_MS + 1000 },
      { id: 2, dueMs: START_MS + 2000 },
    ]);
  });
});

describe('createReplayHost - fireNextDueTimer', () => {
  it('fires the single earliest due timer and moves the clock to its due time', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => order.push('a'), 1000);
    host.setTimeout(() => order.push('b'), 2000);
    const fired = host.fireNextDueTimer(START_MS + 5000);
    expect(fired).toBe(true);
    expect(order).toEqual(['a']);
    expect(host.now()).toBe(START_MS + 1000);
    expect(host.pendingTimers()).toEqual([{ id: 2, dueMs: START_MS + 2000 }]);
  });

  it('breaks a tie between two timers due at the same time by the lower id', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => order.push('second'), 1000);
    host.setTimeout(() => order.push('first'), 1000);
    host.fireNextDueTimer(START_MS + 1000);
    expect(order).toEqual(['second']);
  });

  it('returns false and does not move the clock when nothing is due', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => {}, 5000);
    const fired = host.fireNextDueTimer(START_MS + 1000);
    expect(fired).toBe(false);
    expect(host.now()).toBe(START_MS);
    expect(host.pendingTimers()).toEqual([{ id: 1, dueMs: START_MS + 5000 }]);
  });

  it('fires one timer per call rather than sweeping every due timer at once', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => order.push('a'), 1000);
    host.setTimeout(() => order.push('b'), 2000);
    host.setTimeout(() => order.push('c'), 3000);

    expect(host.fireNextDueTimer(START_MS + 3000)).toBe(true);
    expect(order).toEqual(['a']);
    expect(host.fireNextDueTimer(START_MS + 3000)).toBe(true);
    expect(order).toEqual(['a', 'b']);
    expect(host.fireNextDueTimer(START_MS + 3000)).toBe(true);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(host.fireNextDueTimer(START_MS + 3000)).toBe(false);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('fires a timer chained during firing when its due time is not later than uptoMs', () => {
    const order: string[] = [];
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    host.setTimeout(() => {
      order.push('first');
      host.setTimeout(() => order.push('chained'), 500);
    }, 1000);
    expect(host.fireNextDueTimer(START_MS + 1500)).toBe(true);
    expect(order).toEqual(['first']);
    expect(host.fireNextDueTimer(START_MS + 1500)).toBe(true);
    expect(order).toEqual(['first', 'chained']);
  });

  it('never fires a cleared timer', () => {
    const fn = vi.fn();
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    const id = host.setTimeout(fn, 1000);
    host.clearTimeout(id);
    expect(host.fireNextDueTimer(START_MS + 5000)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createReplayHost - fetch', () => {
  it('records the request and the response of a successful call', async () => {
    const response = okResponse();
    const host = createReplayHost({ startMs: START_MS, fetch: async () => response });
    const request: HostRequest = { method: 'GET', path: '/api/auth/me' };
    const result = await host.fetch(request);
    expect(result).toBe(response);
    expect(host.requests).toEqual([request]);
    expect(host.exchanges).toEqual([{ request, response }]);
  });

  it('records a thrown error rather than swallowing it', async () => {
    const error = new Error('transport failure');
    const host = createReplayHost({
      startMs: START_MS,
      fetch: async () => {
        throw error;
      },
    });
    const request: HostRequest = { method: 'GET', path: '/api/auth/me' };
    await expect(host.fetch(request)).rejects.toThrow(error);
    expect(host.exchanges).toEqual([{ request, error }]);
  });

  it('setFetch swaps the delegate for later calls', async () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    const replacement: HostResponse = { status: 429, headers: {}, body: '{}' };
    host.setFetch(async () => replacement);
    const result = await host.fetch({ method: 'POST', path: '/api/samples' });
    expect(result).toBe(replacement);
  });
});

describe('createReplayHost - recording every other call', () => {
  it('populates every recording member with one call each', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });

    const profile = { desiredAccuracyM: 10, distanceFilterM: 25, background: true };
    host.configureLocation(profile);
    host.requestSignificantChanges(true);
    const notification = { id: 'n1', atMs: START_MS + 1000, title: 't', body: 'b' };
    host.scheduleNotification(notification);
    host.cancelNotification('n1');
    host.emit({
      type: 'tracking',
      state: 'idle',
      background: false,
      authorization: { status: 'notDetermined', accuracy: 'fullAccuracy' },
      lowPower: false,
    });
    host.log('info', 'hello');

    expect(host.configureLocationCalls).toEqual([profile]);
    expect(host.currentProfile()).toEqual(profile);
    expect(host.significantChangesCalls).toEqual([true]);
    expect(host.scheduledNotifications).toEqual([notification]);
    expect(host.cancelledNotificationIds).toEqual(['n1']);
    expect(host.emitted).toHaveLength(1);
    expect(host.logs).toEqual(['info: hello']);
  });

  it('currentProfile is null before any configureLocation call', () => {
    const host = createReplayHost({ startMs: START_MS, fetch: async () => okResponse() });
    expect(host.currentProfile()).toBeNull();
  });
});
