// ios/SPEC.md Section 7.4: the queue itself, and the two moments the spec
// calls "enqueue" and "flush" apply their own local judgement to it. This
// file is substep B2 - the queue and the local drops it owns - and holds no
// timer, no `fetch`, no backoff and no status handling; substep B6 builds
// the flush and imports what is here.
//
// The queue is an in-memory array of samples in arrival order, exactly as
// `useSampleTracking`'s `queueRef` is (Section 7.4's opening line), and it
// is never persisted (Section 1, I2): there is nothing here that touches
// disk.
//
// Every threshold below comes from `@tipsytrails/shared`'s `CONFIG`
// (CLAUDE.md forbids inlining a rate limit, radius, threshold or timeout at
// a call site), and every duration this module takes is milliseconds,
// matching `config.ts`'s own unit - this module never touches the database's
// seconds.
import { CONFIG } from '@tipsytrails/shared';
import type { Counters } from './counters.js';
import type { Sample } from './events.js';

export interface SampleQueue {
  samples: Sample[];
}

export function createQueue(): SampleQueue {
  return { samples: [] };
}

// Section 7.4's enqueue: a sample from the host is dropped and counted if
// its accuracy exceeds `FOG_MAX_ACCURACY_M`, or if `nowMs - sample.timestamp`
// exceeds `SAMPLE_MAX_AGE_MS` (Section 7.1 argues both are safe to re-test
// locally because the server is *certain* to reject the same sample on the
// same field). Otherwise the sample is appended, and then the cap applies:
// while the queue exceeds `TRACKER_QUEUE_CAP`, the oldest sample is dropped
// and counted - the newest sample is the one that says where the player is
// now, and it is the one a stale queue must not push out.
//
// `counters.fixes.received` counts every sample handed here, whatever
// happens to it next - accepted, locally dropped, or later evicted by the
// cap. This is deliberately not the same counter as `droppedInvalid`
// (negative accuracy): `ios/SPEC.md` 6.6 puts that drop in the Swift shell,
// before a fix ever reaches this function, so `droppedInvalid` exists for
// the shell to report into and this module never writes it.
//
// Returns whether the sample passed the two local gates above - the cap
// dropping some other, older sample afterwards does not change what this
// call returns about the sample it was handed.
export function enqueue(
  queue: SampleQueue,
  sample: Sample,
  nowMs: number,
  counters: Counters,
): boolean {
  counters.fixes.received += 1;

  if (sample.accuracy > CONFIG.FOG_MAX_ACCURACY_M) {
    counters.fixes.droppedAccuracy += 1;
    return false;
  }
  if (nowMs - sample.timestamp > CONFIG.SAMPLE_MAX_AGE_MS) {
    counters.fixes.droppedStaleAtEnqueue += 1;
    return false;
  }

  queue.samples.push(sample);

  while (queue.samples.length > CONFIG.TRACKER_QUEUE_CAP) {
    queue.samples.shift();
    counters.fixes.droppedByCap += 1;
  }

  counters.queue.currentDepth = queue.samples.length;
  counters.queue.maxDepthSeen = Math.max(counters.queue.maxDepthSeen, queue.samples.length);

  return true;
}

// Section 7.4's "before posting, samples that have become certainly stale
// while waiting are dropped and counted" - a queue that sat through a long
// dead spot does not spend its first batch on samples the server will
// refuse. Counted to `droppedStaleAtFlush`, deliberately a different counter
// from `droppedStaleAtEnqueue` above: the two answer different questions -
// how often a fix arrives already too old to keep, against how often one
// goes stale only by waiting for a flush - and folding them together would
// lose that distinction.
export function dropStale(queue: SampleQueue, nowMs: number, counters: Counters): number {
  const kept = queue.samples.filter(
    (sample) => nowMs - sample.timestamp <= CONFIG.SAMPLE_MAX_AGE_MS,
  );
  const droppedCount = queue.samples.length - kept.length;
  queue.samples = kept;

  counters.fixes.droppedStaleAtFlush += droppedCount;
  counters.queue.currentDepth = queue.samples.length;

  return droppedCount;
}

// Up to `SAMPLE_MAX_BATCH` samples from the front of the queue, oldest
// first. This is a PEEK, not a take: it does not remove anything.
// Section 7.4 keeps a failed batch at the front of the queue for a retry, so
// removal has to be the caller's own separate decision, taken only after a
// successful flush (`removeFront` below) - a `peek` a reader mistakes for a
// `take` would drop a whole batch of a walk on the first failed post.
export function peekBatch(queue: SampleQueue): Sample[] {
  return queue.samples.slice(0, CONFIG.SAMPLE_MAX_BATCH);
}

// Removes `count` samples from the front of the queue - the caller's
// separate decision after `peekBatch` returned a batch that was
// successfully sent (Section 7.4). Takes `counters` for the same reason
// `enqueue` and `dropStale` do: a successful flush is the single largest
// change the queue's depth ever undergoes - up to `SAMPLE_MAX_BATCH`
// samples leave at once - and `currentDepth` left stale from that moment
// until the next fix happens to correct it is a wrong number sitting in
// Section 7.8's report for as long as tens of seconds under the walking
// profile. `maxDepthSeen` is untouched here on purpose: removal can only
// lower the depth, and a high-water mark that fell would not be one.
export function removeFront(queue: SampleQueue, count: number, counters: Counters): void {
  queue.samples.splice(0, count);
  counters.queue.currentDepth = queue.samples.length;
}

export function depth(queue: SampleQueue): number {
  return queue.samples.length;
}

// The "behind" rule (SPEC.md Section 8.6, ios/SPEC.md Sections 7.4 and 8.3).
//
// Pure and side-effect free, in the same spirit as the rest of this module -
// no network, no timers, no React.
//
// The rule: of the samples that were queued when a flush attempt began, how
// many are *still* queued once the attempt is over. A sample that arrived
// after the attempt began has not missed anything yet, so it never counts
// here even though it may still be sitting in the queue. `sentCount` is
// everything the attempt actually removed - the whole batch on a success,
// nothing on a failure, since a failed post leaves the batch at the front of
// the queue for a retry (ios/SPEC.md 7.4).
//
// This used to be shared with `packages/web/src/tracking/useSampleTracking.ts`'s
// `flush()`, which called one common implementation for both its success and
// its failure path. It no longer does: `useSampleTracking.flush()` now applies
// this same rule inline as `queuedAtAttempt - batch.length` / `queuedAtAttempt`,
// and the two are kept in step by `ios/SPEC.md` 8.3's requirement rather than
// by a shared function. `ios/SPEC.md`'s list of changes for `main` names
// adopting this function as one of them.
export function computeBehindDepth(queuedAtAttemptStart: number, sentCount: number): number {
  return queuedAtAttemptStart - sentCount;
}
