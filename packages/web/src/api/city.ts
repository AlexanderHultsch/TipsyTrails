// Section 11.4: `data/cities/<slug>.json` is the single seam for per-city
// configuration; Karlsruhe's slug lives at data/cities/karlsruhe.json.
// `GET /api/city` (Section 9.2) does not exist yet - it and the client
// wiring around it are a later phase - so until then the active city is
// this hard-coded constant rather than something fetched at startup. v1
// seeds exactly one city (Section 5.1), so this is a sequencing gap, not a
// product decision: replace with a value read from GET /api/city once that
// endpoint exists.
export const ACTIVE_CITY_SLUG = 'karlsruhe';
