// The package's one client-safe entry point. `server-config.ts` is
// deliberately absent and must stay absent: anything re-exported here is
// reachable from `packages/web` and therefore bundled into the browser, which
// is exactly what put the badge floors in a production bundle up to and
// including v1.53 (Section 7.7). Server-only constants come in through
// `@tipsytrails/shared/server`, which `package.json`'s `exports` map keeps
// separate and `eslint.config.js` forbids inside `packages/web`.

export { CONFIG, DERIVED } from './config.js';
export { generateAvatarSvg } from './avatar.js';
export { parseCityConfig, citySeedDir } from './city.js';
export type { CityConfig, CityBoundingBox, CityOsmAdminFilter } from './city.js';
export {
  cellCenter,
  cellCenterXY,
  gridMapBounds,
  haversineDistanceM,
  NO_DISTRICT,
  toCell,
} from './grid.js';
export type { GridParams, LatLon } from './grid.js';
export {
  BADGE_PERIODS,
  badgePeriodBoundaries,
  badgePeriodDays,
  badgePeriodKey,
  berlinDateString,
  mostRecentlyClosedBadgePeriodKey,
} from './berlin-time.js';
export type { BadgePeriod, BadgePeriodBoundaries } from './berlin-time.js';
export {
  BADGE_CATALOGUE,
  BADGE_COMPETITION_NOTE,
  BADGE_PERIOD_NAME,
  badgeName,
  unearnedBadgeTypes,
} from './badges.js';
export type { BadgeType } from './badges.js';
export {
  isOnSite,
  isVisitComplete,
  isVisitExpired,
  onsiteCandidates,
  onsiteRadiusM,
} from './visits.js';
export type { OnsiteCandidate } from './visits.js';
export { computeBehindDepth } from './samples.js';
export { TELEPORT_FIX } from './teleport.js';
export { compareBarsByName } from './bars.js';
export type { BarListEntry } from './bars.js';
export { findConflictingBar, levenshteinRatio, normalizeBarName } from './suggest.js';
export type { DuplicateCandidateBar } from './suggest.js';
