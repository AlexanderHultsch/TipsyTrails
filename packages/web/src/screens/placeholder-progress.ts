// Section 12, Phase 2: "static progress values." Real area-explored
// percentages (Section 7.6) are computed from fog_state and
// fog_district_progress, neither of which exists before Phase 3, and
// GET /api/progress (Section 9.2) is not built yet either.
//
// PLACEHOLDER - Phase 3 replaces every use of this constant with a real,
// per-district and city-wide figure from the API. Do not read meaning into
// this number: it is not measuring anything. It happens to also be the
// truthful value today, since nobody's fog has been computed yet - that is
// a coincidence of sequencing, not a design choice, and it stops being true
// the moment Phase 3 lands.
export const PLACEHOLDER_PROGRESS_PERCENT = 0;
