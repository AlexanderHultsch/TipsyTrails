import type { LatLon } from '@tipsytrails/shared';

// SPEC.md Section 7.2's teleport guard (routes/fog.ts, which produces
// these) and Section 7.5 step 2's check-in proximity check
// (routes/visits.ts, which reads them) share this state, so it is declared
// in neither — those two already import each other's summary helpers, and
// the type belongs to whichever of them is not being read at the time.
//
// Section 10.2 is why there is a type here and no table: "the previous
// accepted position lives in memory only ... discarded on restart." The one
// `Map<number, AcceptedPosition>` holding them is created per `buildApp`
// call in app.ts and passed to both plugins — a restart is a fresh process
// and a fresh Map, and none of this is ever written to the database.
export interface AcceptedPosition extends LatLon {
  atMs: number;
}
