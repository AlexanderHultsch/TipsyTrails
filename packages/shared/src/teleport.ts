// SPEC.md Sections 9.3/7.2: the two fields a teleported position asserts
// about itself, in one place because two packages now synthesise the same
// sample and they must not drift.
//
// `packages/api/src/routes/admin-teleport.ts` builds the synthetic sample
// `POST /api/admin/teleport` runs through the pipeline; while that teleport
// stands, `packages/web/src/tracking/useSampleTracking.ts` posts the very
// same point to `POST /api/samples` on the ordinary cadence, with the
// ordinary guards on. That second path only works because the two agree:
// the server's `lastAccepted` is already at this point, so a sample from it
// implies zero speed, and a check-in the client offers is one the server
// will accept. Two copies of these numbers would let a change on one side
// silently make the other side's samples refusable — the same reason
// `onsiteRadiusM` and `compareBarsByName` live here rather than twice.
//
// NEITHER VALUE IS IN `config.ts`, DELIBERATELY. CLAUDE.md's rule is about
// rate limits, radii, thresholds, tolerances and timeouts — numbers the
// specification tunes. These are not tuned:
//
// - `accuracy: 0` says a synthesised position has no measurement error to
//   declare. It is also the strictest choice available, since
//   `onsiteRadiusM` widens the check-in radius with reported accuracy: a
//   teleport buys the tightest radius, never a generous one.
// - `speed: null` says nothing here was measured moving. On the admin route
//   the speed guards are off and it changes nothing; on the client's
//   ordinary samples it is what makes the server derive zero from the
//   previous accepted position, which is this point.
export const TELEPORT_FIX = { accuracy: 0, speed: null } as const;
