// The "behind" rule of SPEC.md Section 8.6, in one place because two clients
// apply it and the connection icon must not end up meaning two things.
//
// Pure and side-effect free, in the same spirit as `grid.ts` and `visits.ts` —
// no network, no timers, no React — so the browser's flush
// (`packages/web/src/tracking/useSampleTracking.ts`, Section 7.2) and the
// iPhone tracker's (`packages/tracker`, `ios/SPEC.md` 7.4) can share one
// implementation instead of each applying the rule at two call sites of its
// own.
//
// WHY HERE AND NOT IN `packages/tracker`. This function was built on the
// `ios-app` branch, beside that package's queue, and `ios/SPEC.md` Section 12
// asks the web app to adopt it. It cannot adopt it from there: `packages/web`
// imports nothing from `packages/tracker` and must not start, because the
// tracker is the phone's package and the website depending on the phone
// inverts the direction the whole arrangement rests on (`ios/SPEC.md` 8.3
// mirrors the tracker's event union by hand in `packages/web/src/shell/` for
// exactly this reason). `packages/shared` is what both sides already depend
// on, and this is the kind of rule it exists to hold — the same argument
// `teleport.ts` makes for the two fields a synthesised sample asserts.
//
// There is no constant here and there must not be one. Section 8.6 argues the
// point at length: "it survived a flush attempt" is a fact the flush itself
// observes, so the rule needs no threshold, no count and no duration, and
// neither of CLAUDE.md's two constants modules has anything to hold for it.

/**
 * How many samples this device is *behind* on sending, once a flush attempt
 * is over (SPEC.md Section 8.6; `ios/SPEC.md` 7.4 and 8.3).
 *
 * The rule: of the samples that were queued when the attempt began, how many
 * are still queued now. A sample that arrived while the request was in the
 * air has not missed a send cycle yet, so it never counts here even though it
 * is sitting in the queue — which is why a caller has to read
 * `queuedAtAttemptStart` *before* it awaits anything.
 *
 * `sentCount` is everything the attempt actually removed, and there are
 * exactly two shapes of call:
 *
 * - **on success, the whole batch.** Whatever was queued at the start and did
 *   not fit into `CONFIG.SAMPLE_MAX_BATCH` was passed over by the cycle that
 *   should have carried it, and that remainder is the backlog. Nought
 *   whenever the queue fitted in one batch, which is the normal case and is
 *   what puts the icon back to `online`.
 * - **on failure, nothing.** A failed post leaves its batch at the front of
 *   the queue for a retry (SPEC.md 7.2, `ios/SPEC.md` 7.4), so everything
 *   that was queued when the attempt began has now failed at least one send.
 *
 * The result is the only input to `computeConnectionStatus`
 * (`packages/web/src/tracking/status.ts`) besides `navigator.onLine`, so the
 * arithmetic is not cosmetic: subtracting the wrong way round, or passing a
 * batch length on the failure path, paints a healthy phone as behind or a
 * backlogged one as fine, on every player's screen.
 *
 * The iPhone tracker still carries its own copy of this rule in
 * `packages/tracker/src/queue.ts`. Removing it is the `ios-app` branch's to
 * do — `packages/tracker/` is that branch's under `ios/SPEC.md` I7 — and
 * until it does, two implementations of one rule exist.
 */
export function computeBehindDepth(queuedAtAttemptStart: number, sentCount: number): number {
  return queuedAtAttemptStart - sentCount;
}
