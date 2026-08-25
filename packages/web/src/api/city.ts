// Section 11.4: `data/cities/<slug>.json` is the single seam for per-city
// configuration; Karlsruhe's slug lives at data/cities/karlsruhe.json.
// `GET /api/city` (Section 9.2, packages/api/src/routes/city.ts) exists and
// is fetched at runtime (map/useCityMaxBounds.ts and its callers) - its
// response even carries a `slug` (CityMeta, api/types.ts) - but that fetch
// is async and this constant is not: it is the URL segment for the static
// per-city GeoJSON paths below (`/static/<slug>/*.geojson`), needed
// synchronously by screens that render before any request resolves, and by
// `request()` calls that would otherwise have to thread a fetched slug
// through every caller for the sake of v1's one city. v1 seeds exactly one
// city (Section 5.1), so hard-coding it here is not a gap to close, only a
// second call to GET /api/city away from being one if that ever changes.
export const ACTIVE_CITY_SLUG = 'karlsruhe';
