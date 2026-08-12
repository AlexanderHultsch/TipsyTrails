import { CONFIG } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';

export interface User {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
}

// Section 7.2: what each client-side position sample carries.
export interface Sample {
  lat: number;
  lon: number;
  accuracy: number;
  speed: number | null;
  timestamp: number;
}

// POST /api/samples response shape (packages/api/src/routes/fog.ts). Section
// 9.2 defines the full { newCells, newBars, visitUpdates } shape.
export interface SamplesResponse {
  newCells: number;
  newBars: Bar[];
  visitUpdates: VisitSummary[];
}

// GET /api/bars, GET /api/bars/:id, and the `newBars` field above all share
// this shape - packages/api/src/routes/bars.ts's `toBarSummary` (reused by
// routes/fog.ts for `newBars`) is the one place a `bars` row becomes
// client-facing JSON, so the three surfaces can never drift apart.
export interface Bar {
  id: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: string;
  discoveredAt: number;
}

export interface BarsResponse {
  bars: Bar[];
}

// GET /api/city response shape (packages/api/src/routes/city.ts). What the
// fog layer (map/fog/) uses for grid dimensions (Section 6.1/6.2) - the
// raw mask from GET /api/fog carries no dimensions of its own.
export interface CityMeta {
  slug: string;
  name: string;
  originLat: number;
  originLon: number;
  gridWidth: number;
  gridHeight: number;
  cellSizeM: number;
  playableCells: number;
  districts: { id: number; name: string; playableCells: number }[];
}

// The `X-Fog-Progress` header GET /api/fog sends alongside its raw mask
// body (packages/api/src/routes/fog.ts) - see Section 9.2's "raw fog mask
// (application/octet-stream) + per-district revealed counts".
export interface FogProgress {
  revealedCells: number;
  playableCells: number;
  districts: { id: number; revealedCells: number }[];
}

export interface FogMaskResponse {
  mask: Uint8Array;
  progress: FogProgress;
}

// Mirrors packages/api/src/routes/visits.ts's VisitSummary (SPEC.md Sections
// 5.7/7.5/9.2) - the client-facing shape of a visit, shared by POST
// /api/visits, GET /api/visits/pending, and POST /api/samples's
// visitUpdates above, exactly like Bar is shared across GET /api/bars(/:id)
// and newBars.
export interface VisitSummary {
  id: number;
  barId: number;
  barName: string;
  startedAt: number;
  lastSampleAt: number;
  onsiteSamples: number;
  confirmedS: number;
  remainingS: number;
  status: string;
}

export interface PendingVisitsResponse {
  visits: VisitSummary[];
}

// GET /api/push/vapid-public-key response shape (packages/api/src/routes/push.ts,
// Phase 5 step 5): null when the server has no VAPID_* configuration at all
// (push disabled), never an error - see that route's own comment for why
// this exists outside SPEC.md Section 9.2's original endpoint table.
export interface VapidPublicKeyResponse {
  publicKey: string | null;
}

// GET /api/progress response shape (packages/api/src/routes/fog.ts). Section
// 7.6's area-explored figures, city-wide and per district - the same
// revealed/playable pair the fog mask itself is scored against, already
// turned into a percent server-side so this is never recomputed here.
export interface CityProgress {
  revealedCells: number;
  playableCells: number;
  percent: number;
}

export interface DistrictProgress {
  id: number;
  name: string;
  revealedCells: number;
  playableCells: number;
  percent: number;
}

export interface ProgressResponse {
  city: CityProgress;
  districts: DistrictProgress[];
}

// SPEC.md Section 7.7: two badge kinds, derived from CONFIG.BADGE_THRESHOLDS
// the same way packages/api/src/badges.ts's own BadgeKind is - so a third
// kind added to config.ts is a type error here rather than a silent gap.
export type BadgeKind = keyof typeof CONFIG.BADGE_THRESHOLDS;

// A badge a user has actually been awarded (packages/api/src/badges.ts's
// BadgeSummary) - shared by GET /api/leaderboard's per-entry `badges` and
// GET /api/profile/:handle's `badges`.
export interface BadgeSummary {
  kind: BadgeKind;
  period: BadgePeriod;
  periodKey: string;
  value: number;
  awardedAt: number;
}

// Live "on track" progress toward one badge's threshold for the current
// period (packages/api/src/badges.ts's BadgeProgress, Section 7.7's last
// paragraph) - value and threshold both come from the server, never
// recomputed client-side.
export interface BadgeProgress {
  kind: BadgeKind;
  value: number;
  threshold: number;
}

// GET /api/leaderboard response shape (packages/api/src/routes/leaderboard.ts).
export interface LeaderboardEntry {
  rank: number;
  userId: number;
  displayName: string;
  isAnonymous: boolean;
  avatarSeed: string;
  value: number;
  badges: BadgeSummary[];
}

export interface LeaderboardResponse {
  metric: 'area' | 'bars';
  period: 'all' | 'week' | 'month';
  page: number;
  pageSize: number;
  totalUsers: number;
  totalPages: number;
  entries: LeaderboardEntry[];
}

// GET /api/profile/:handle response shape (packages/api/src/routes/profile.ts).
export interface ProfileResponse {
  userId: number;
  handle: string;
  displayName: string;
  isAnonymous: boolean;
  avatarSeed: string;
  areaPercent: number;
  barsMastered: number;
  badges: BadgeSummary[];
  badgeProgress: Record<BadgePeriod, BadgeProgress[]>;
}
