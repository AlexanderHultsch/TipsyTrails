import type { LatLon } from '@tipsytrails/shared';

// SPEC.md Section 7.2's teleport guard (routes/fog.ts, which produces
// these) and Section 7.5 step 2's check-in proximity check
// (routes/visits.ts, which reads them) share this state, so it is declared
// in neither. fog.ts already imports visits.ts's own summary helper
// (`toVisitSummary`); having visits.ts import this type back from fog.ts
// would reopen the fog<->visits cycle the previous review block closed. A
// third module also needs it — app.ts, to type the one shared Map it
// creates and hands to both plugins — which is reason enough on its own
// not to pick one of the two route modules to own it.
//
// Section 10.2 is why there is a type here and no table: "the previous
// accepted position lives in memory only ... discarded on restart." The one
// `Map<number, AcceptedPosition>` holding them is created per `buildApp`
// call in app.ts and passed to both plugins — a restart is a fresh process
// and a fresh Map, and none of this is ever written to the database.
export interface AcceptedPosition extends LatLon {
  atMs: number;
}
