// The "behind" rule (SPEC.md Section 8.6, ios/SPEC.md Sections 7.4 and 8.3).
//
// Pure and side-effect free, in the same spirit as `visits.ts` — no network,
// no timers, no React — so `packages/web/src/tracking/useSampleTracking.ts`'s
// `flush()` (both its success and its failure path) and the tracker's own
// flush (`ios/SPEC.md` 7.4, `packages/tracker/src/queue.ts`) share one
// implementation of what "behind" means instead of agreeing by coincidence.
//
// The rule: of the samples that were queued when a flush attempt began, how
// many are *still* queued once the attempt is over. A sample that arrived
// after the attempt began has not missed anything yet, so it never counts
// here even though it may still be sitting in the queue. `sentCount` is
// everything the attempt actually removed — the whole batch on a success,
// nothing on a failure, since a failed post leaves the batch at the front of
// the queue for a retry (ios/SPEC.md 7.4).
//
// Why two call sites must not drift: `ios/SPEC.md` 8.3 has the shell driver
// feed `useSampleTracking`'s internal `behindDepth` from the tracker's own
// `behind`, and then computes `connectionStatus` from it with the exact same
// `computeConnectionStatus` call the web driver uses — so the `syncing` icon
// means the same thing under both drivers only if `behind` is computed the
// same way under both. `packages/web/src/tracking/status.ts`'s own comment
// and `SPEC.md` 8.6's "Why the connection state is not the queue's depth"
// are why the number is not simply the queue's depth: a healthy phone posts
// something almost continuously, so a status derived from depth alone would
// read `syncing` nearly all the time. `behind` is deliberately narrower — not
// "how much is queued" but "how much already missed a send" — and a second,
// slightly different implementation of that at the other call site is the
// bug `ios/PARENT-CONTRACT.md` D2 exists to rule out: the icon would then tell
// the truth in Safari and lie in the app, or the reverse, on the same event.
export function computeBehindDepth(queuedAtAttemptStart: number, sentCount: number): number {
  return queuedAtAttemptStart - sentCount;
}
