import { describe, expect, it } from 'vitest';
import { CONFIG } from '@tipsytrails/shared';
import { createCounters } from './counters.js';
import type { Counters } from './counters.js';
import type { Sample } from './events.js';
import { createQueue, depth, dropStale, enqueue, peekBatch, removeFront } from './queue.js';

// A fixed instant rather than Date.now() everywhere - ios/SPEC.md Section
// 7.2's Host.now() is what feeds this module in production, and this suite
// drives it by hand exactly as a fake host would.
const BASE_NOW_MS = 1_700_000_000_000;

function sample(overrides: Partial<Sample> = {}): Sample {
  return {
    lat: 49.0135,
    lon: 8.4044,
    accuracy: 10,
    speed: null,
    timestamp: BASE_NOW_MS,
    ...overrides,
  };
}

// counters.test.ts's own habit: assert the whole shape moved as expected,
// not one field in isolation, so a counter this test forgot to name but the
// call under test happens to touch is caught rather than silently passing.
function countersWith(patch: (counters: Counters) => void): Counters {
  const counters = createCounters();
  patch(counters);
  return counters;
}

describe('enqueue', () => {
  it('drops a sample one past FOG_MAX_ACCURACY_M, counting only that drop', () => {
    const queue = createQueue();
    const counters = createCounters();

    const accepted = enqueue(
      queue,
      sample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M + 1 }),
      BASE_NOW_MS,
      counters,
    );

    expect(accepted).toBe(false);
    expect(queue.samples).toEqual([]);
    expect(counters).toEqual(
      countersWith((c) => {
        c.fixes.received = 1;
        c.fixes.droppedAccuracy = 1;
      }),
    );
  });

  // The boundary itself: exactly FOG_MAX_ACCURACY_M is accepted, matching
  // packages/api/src/routes/fog.ts's own `sample.accuracy > FOG_MAX_ACCURACY_M`
  // gate - a sample the tracker keeps and the server then refuses is the
  // honest direction, and the reverse (the tracker refusing what the server
  // would accept) is not.
  it('accepts a sample exactly at FOG_MAX_ACCURACY_M', () => {
    const queue = createQueue();
    const counters = createCounters();
    const s = sample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M });

    const accepted = enqueue(queue, s, BASE_NOW_MS, counters);

    expect(accepted).toBe(true);
    expect(queue.samples).toEqual([s]);
    expect(counters).toEqual(
      countersWith((c) => {
        c.fixes.received = 1;
        c.queue.currentDepth = 1;
        c.queue.maxDepthSeen = 1;
      }),
    );
  });

  it('drops a sample one millisecond past SAMPLE_MAX_AGE_MS, counting only that drop', () => {
    const queue = createQueue();
    const counters = createCounters();

    const accepted = enqueue(
      queue,
      sample({ timestamp: BASE_NOW_MS - CONFIG.SAMPLE_MAX_AGE_MS - 1 }),
      BASE_NOW_MS,
      counters,
    );

    expect(accepted).toBe(false);
    expect(queue.samples).toEqual([]);
    expect(counters).toEqual(
      countersWith((c) => {
        c.fixes.received = 1;
        c.fixes.droppedStaleAtEnqueue = 1;
      }),
    );
  });

  // The boundary itself: exactly SAMPLE_MAX_AGE_MS old is accepted, matching
  // fog.ts's own `nowMs - sample.timestamp > SAMPLE_MAX_AGE_MS` gate, for the
  // same reason as the accuracy boundary above.
  it('accepts a sample exactly SAMPLE_MAX_AGE_MS old', () => {
    const queue = createQueue();
    const counters = createCounters();
    const s = sample({ timestamp: BASE_NOW_MS - CONFIG.SAMPLE_MAX_AGE_MS });

    const accepted = enqueue(queue, s, BASE_NOW_MS, counters);

    expect(accepted).toBe(true);
    expect(queue.samples).toEqual([s]);
    expect(counters).toEqual(
      countersWith((c) => {
        c.fixes.received = 1;
        c.queue.currentDepth = 1;
        c.queue.maxDepthSeen = 1;
      }),
    );
  });

  it('drops the oldest sample once the queue exceeds TRACKER_QUEUE_CAP, never the newest', () => {
    const queue = createQueue();
    const counters = createCounters();
    const samples: Sample[] = [];

    for (let i = 0; i <= CONFIG.TRACKER_QUEUE_CAP; i += 1) {
      const s = sample({ timestamp: BASE_NOW_MS + i });
      samples.push(s);
      enqueue(queue, s, BASE_NOW_MS + i, counters);
    }

    expect(queue.samples.length).toBe(CONFIG.TRACKER_QUEUE_CAP);
    // Identity, not just equal values: the oldest sample handed in is gone,
    // every other one handed in is still present in the same order, and the
    // most recently accepted one is the very object the loop last enqueued.
    expect(queue.samples).not.toContain(samples[0]);
    expect(queue.samples[0]).toBe(samples[1]);
    expect(queue.samples[queue.samples.length - 1]).toBe(samples[samples.length - 1]);
    expect(counters.fixes.droppedByCap).toBe(1);
    expect(counters.queue.maxDepthSeen).toBe(CONFIG.TRACKER_QUEUE_CAP);
  });

  it('counts every sample handed in as received, whatever happens to it', () => {
    const queue = createQueue();
    const counters = createCounters();

    enqueue(queue, sample({ accuracy: CONFIG.FOG_MAX_ACCURACY_M + 1 }), BASE_NOW_MS, counters);
    enqueue(queue, sample(), BASE_NOW_MS, counters);

    expect(counters.fixes.received).toBe(2);
  });
});

describe('dropStale', () => {
  it('drops only the samples that have gone stale while queued, counting to droppedStaleAtFlush', () => {
    const queue = createQueue();
    const counters = createCounters();
    const nowMs = BASE_NOW_MS + 5 * CONFIG.SAMPLE_MAX_AGE_MS;
    const stale = sample({ timestamp: nowMs - CONFIG.SAMPLE_MAX_AGE_MS - 1 });
    const fresh = sample({ timestamp: nowMs });
    queue.samples.push(stale, fresh);

    const droppedCount = dropStale(queue, nowMs, counters);

    expect(droppedCount).toBe(1);
    expect(queue.samples).toEqual([fresh]);
    // A different counter from the enqueue-time drop, on purpose (queue.ts's
    // own comment): this must not touch droppedStaleAtEnqueue.
    expect(counters).toEqual(
      countersWith((c) => {
        c.fixes.droppedStaleAtFlush = 1;
        c.queue.currentDepth = 1;
      }),
    );
  });
});

describe('peekBatch', () => {
  it('caps at SAMPLE_MAX_BATCH and leaves the queue untouched', () => {
    const queue = createQueue();
    for (let i = 0; i < CONFIG.SAMPLE_MAX_BATCH + 5; i += 1) {
      queue.samples.push(sample({ timestamp: BASE_NOW_MS + i }));
    }

    const batch = peekBatch(queue);

    expect(batch.length).toBe(CONFIG.SAMPLE_MAX_BATCH);
    expect(batch).toEqual(queue.samples.slice(0, CONFIG.SAMPLE_MAX_BATCH));
    expect(queue.samples.length).toBe(CONFIG.SAMPLE_MAX_BATCH + 5);
  });
});

describe('removeFront', () => {
  it('removes the given count from the front, in arrival order, and updates currentDepth', () => {
    const queue = createQueue();
    const counters = createCounters();
    const a = sample({ timestamp: BASE_NOW_MS });
    const b = sample({ timestamp: BASE_NOW_MS + 1 });
    const c = sample({ timestamp: BASE_NOW_MS + 2 });
    queue.samples.push(a, b, c);

    removeFront(queue, 2, counters);

    expect(queue.samples).toEqual([c]);
    expect(counters.queue.currentDepth).toBe(1);
  });
});

describe('maxDepthSeen', () => {
  it('holds the high-water mark after the queue drains', () => {
    const queue = createQueue();
    const counters = createCounters();

    for (let i = 0; i < 5; i += 1) {
      enqueue(queue, sample({ timestamp: BASE_NOW_MS + i }), BASE_NOW_MS + i, counters);
    }
    expect(counters.queue.maxDepthSeen).toBe(5);

    removeFront(queue, 5, counters);

    expect(depth(queue)).toBe(0);
    // Removal can only lower the depth, so the high-water mark it passed
    // through must survive the drain untouched.
    expect(counters.queue.maxDepthSeen).toBe(5);
  });
});

describe('counters.queue.currentDepth', () => {
  // enqueue (queue.ts:72), dropStale (:94) and removeFront (:121) each set
  // currentDepth themselves, and a per-function test asserting it once each
  // is exactly what let removeFront ship without it: nobody had written an
  // assertion for the one mutator that lacked the line. This test instead
  // drives one realistic sequence - several
  // enqueues, a no-op dropStale, a peekBatch, a removeFront, more enqueues, a
  // dropStale that actually drops some, a final removeFront - and checks the
  // invariant after EVERY mutating call in a loop, so a mutator added later
  // is covered by construction rather than by someone remembering to name it
  // here. The same habit counters.test.ts follows by walking the counter
  // object generically instead of naming each field.
  it('matches depth(queue) after every mutating operation in a realistic sequence', () => {
    const queue = createQueue();
    const counters = createCounters();

    const operations: Array<() => void> = [
      ...[0, 1, 2, 3, 4, 5].map(
        (i) => () =>
          enqueue(queue, sample({ timestamp: BASE_NOW_MS + i }), BASE_NOW_MS + i, counters),
      ),
      // Nothing is old enough yet - a no-op mutation must hold the invariant
      // too, not only a call that actually changes the depth.
      () => dropStale(queue, BASE_NOW_MS + 5, counters),
      // Does not mutate at all; included because the sequence names it.
      () => peekBatch(queue),
      () => removeFront(queue, 2, counters),
      ...[10, 11, 12].map(
        (i) => () =>
          enqueue(
            queue,
            sample({ timestamp: BASE_NOW_MS + CONFIG.SAMPLE_MAX_AGE_MS + i }),
            BASE_NOW_MS + CONFIG.SAMPLE_MAX_AGE_MS + i,
            counters,
          ),
      ),
      // Now old enough to drop the four samples still left over from the
      // first batch, and only those.
      () => dropStale(queue, BASE_NOW_MS + CONFIG.SAMPLE_MAX_AGE_MS + 12, counters),
      () => removeFront(queue, 1, counters),
    ];

    for (const operation of operations) {
      operation();
      expect(counters.queue.currentDepth).toBe(depth(queue));
    }
  });
});
