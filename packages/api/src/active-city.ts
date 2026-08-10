// v1 seeds exactly one row into `cities` (SPEC.md Section 5.1): Karlsruhe.
// `packages/shared/src/config.ts`'s `CONFIG.TILES_FILENAME` is already
// Karlsruhe-specific the same way — there is no multi-city selection
// mechanism yet, so this is the one place on the API side that names it.
export const ACTIVE_CITY_SLUG = 'karlsruhe';
