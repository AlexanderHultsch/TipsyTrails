import { CONFIG } from '@tipsytrails/shared';
import type { BadgePeriod } from '@tipsytrails/shared';

export interface User {
  id: number;
  username: string;
  avatarSeed: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
  // Section 9.6: epoch seconds, or null when this account has not consented
  // to the iPhone app's background tracking (Section 5.3). No web screen
  // reads it - it is on this shape because every route that answers with a
  // user answers with the same body, and the iPhone shell reads it from that
  // body (`ios/SPEC.md` 5.4). `isUser` does not exist and must not be added
  // for it: Section 9.6's rule is that a response is validated only where a
  // wrong shape renders as data.
  backgroundTrackingConsentedAt: number | null;
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
// 9.2 defines the full { newCells, newBars, visitUpdates, tooFastToReveal }
// shape.
export interface SamplesResponse {
  newCells: number;
  newBars: Bar[];
  // Sections 7.5, 9.6: the visits this batch changed. Three of VisitStatus's
  // four can appear here - 'pending', 'completed', and (since the expiry
  // sweep of Section 7.5 step 5) 'expired'. No field is new; what changed is
  // which entries the list can hold, so the type is unchanged and this note
  // is the mirror of that. 'cancelled' is not among them: only the cancel
  // endpoint writes it.
  visitUpdates: VisitSummary[];
  // Section 7.3: whether the last accepted sample of this batch was refused
  // a reveal because it was travelling at or above FOG_MAX_SPEED_KMH. The
  // server is the only honest source for it - it applies the rule, and it is
  // the only side that can derive a speed for a sample the Geolocation API
  // reported none for. Reading `position.speed` here instead would be a
  // second implementation of the same rule, free to disagree with the one
  // that actually decides.
  tooFastToReveal: boolean;
  // Section 9.6: one count per gate of Section 7.2, in that section's order
  // and naming, for the samples of this request only. Required and not
  // optional, because Section 9.6 states it unconditionally for both routes
  // that answer with this body and this interface is that table's mirror -
  // an optional field here would describe a server that may omit it, and
  // there is none.
  //
  // No web screen reads it, and that is deliberate rather than an omission:
  // the field exists for the iPhone app's tracker, which posts from a pocket
  // with no screen to show a failure on and has to be able to tell "the
  // phone sent nothing" from "the phone sent it and the server refused it"
  // (`ios/SPEC.md` 9.1). In the browser the same distinction is visible -
  // the map is on screen while the samples are posted. Hence also the
  // absence of a check for it in response-guards.ts, which says why there.
  rejected: {
    accuracy: number;
    future: number;
    stale: number;
    outsideCity: number;
    tooFast: number;
  };
}

// The closed vocabularies the bar and visit shapes below carry, mirroring
// packages/api/src/routes/bars.ts's `BarSource`/`BarStatus` and
// routes/visits.ts's `VisitStatus` - the same hand-kept mirror every other
// type in this file is, for the same reason (packages/web does not depend on
// packages/api, so the shapes are declared twice on purpose; see the note on
// BadgeKind below, which mirrors the server's own the same way).
//
// Written out rather than left as `string`: the server can only ever send
// one of these - each is a SQL literal or a zod enum on that side - and a
// `string` here would let a screen compare a bar's source against a value
// the API will never produce and get silent `false` forever instead of a
// compile error.
export type BarSource = 'osm' | 'community' | 'admin';
export type BarStatus = 'active' | 'hidden';
export type VisitStatus = 'pending' | 'completed' | 'expired' | 'cancelled';

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
  source: BarSource;
  discoveredAt: number;
  // Section 5.7: whether *the requesting user* has at least one completed
  // visit at this bar. Not a property of the bar - the same bar comes back
  // mastered for one player and not for another - so it is only ever read
  // from a response the caller's own session produced, and never cached
  // across users. Mastering is permanent (Section 5.7), so this only ever
  // goes from false to true.
  //
  // It is what decides which of the two cocktail glasses is drawn
  // (components/cocktail-glass.ts), which is the app's central mark for a
  // bar (Section 8.1/8.3).
  mastered: boolean;
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
  status: VisitStatus;
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
// 7.6's figures for the signed-in player: area explored, city-wide and per
// district - the same revealed/playable pair the fog mask itself is scored
// against, already turned into a percent server-side so this is never
// recomputed here - and, city-wide, the two bar counts.
// Named for readability, not exported: like CityMeta's and FogProgress's own
// `districts` above, these two are only ever reached through the response
// type below, and this module names a sub-shape only where something has to
// write the name down.
interface CityProgress {
  revealedCells: number;
  playableCells: number;
  percent: number;
  // Section 7.6's two bar figures, scoped server-side to the active city,
  // this caller's own discoveries and bars that are still `active` - the
  // same set GET /api/bars answers with, so `barsDiscovered` is that
  // response's length and `barsMastered` the number of its entries carrying
  // Section 5.7's `mastered` flag, without any of its rows. Screens read
  // these rather than counting a list: the start screen (Section 8.3) wants
  // exactly these two integers.
  barsDiscovered: number;
  barsMastered: number;
}

interface DistrictProgress {
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

// SPEC.md Section 7.7: two badge kinds, derived from CONFIG.BADGE_KINDS the
// same way packages/api/src/badges.ts's own BadgeKind is - so a third kind
// added to config.ts is a type error here rather than a silent gap. The kinds
// are the client-safe half of what config.ts used to say about badges; the
// floors behind them are in @tipsytrails/shared/server, which this package may
// not import - see Section 7.1 for the two constants modules and why.
export type BadgeKind = (typeof CONFIG.BADGE_KINDS)[number];

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

// The player's own value for one badge kind in the running period
// (packages/api/src/badges.ts's BadgeProgress, Section 7.7's last paragraph)
// - the value comes from the server, never recomputed client-side. There is
// no threshold and no standing here by design: Section 7.7 keeps the floor on
// the server and publishes neither it nor a rank.
export interface BadgeProgress {
  kind: BadgeKind;
  value: number;
}

// GET /api/leaderboard's two query vocabularies, mirroring that route's own
// `z.enum(['area', 'bars'])` and `z.enum(['all', 'week', 'month'])`. Named
// here rather than written out at each of the three places in this package
// that needed them (this file, api/client.ts's `getLeaderboard`,
// screens/Leaderboard.tsx's toggles), which is three chances for the toggle
// row and the request to disagree about what the server accepts.
//
// `LeaderboardPeriod` is deliberately NOT `BadgePeriod`: a badge period is
// week/month/year (Section 7.7) and a leaderboard period is all/week/month
// (Section 7.8). They overlap on two members and are not the same set, so
// they keep separate names.
export type LeaderboardMetric = 'area' | 'bars';
export type LeaderboardPeriod = 'all' | 'week' | 'month';

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
  metric: LeaderboardMetric;
  period: LeaderboardPeriod;
  page: number;
  pageSize: number;
  totalUsers: number;
  totalPages: number;
  entries: LeaderboardEntry[];
}

// GET /api/admin/bars, POST /api/admin/bars, PATCH /api/admin/bars/:id
// response shape (packages/api/src/routes/admin.ts's AdminBarSummary,
// Section 9.3) - includes hidden bars and the fields regular bar summaries
// (Bar, above) don't carry: cityId, source, submittedBy, status, createdAt.
export interface AdminBar {
  id: number;
  cityId: number;
  districtId: number | null;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  source: BarSource;
  submittedBy: number | null;
  status: BarStatus;
  createdAt: number;
}

export interface AdminBarsResponse {
  bars: AdminBar[];
}

// GET /api/admin/users response shape (packages/api/src/routes/admin.ts's
// AdminUserSummary, Section 9.3): "user list with stats" - the real
// username, never the anonymous handle (Section 7.8's anonymity is a
// display choice for other players, not a shield from the admin who
// already moderates their submissions).
export interface AdminUser {
  id: number;
  username: string;
  isAdmin: boolean;
  isAnonymous: boolean;
  mustChangePassword: boolean;
  // Section 7.8: this account is skipped by GET /api/leaderboard and by the
  // badge job's candidate sets. It still plays, and still sees its own
  // figures on its own profile - the flag decides who is ranked, not who may
  // play. Also the precondition POST /api/admin/teleport refuses without.
  excludedFromRankings: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  areaRevealedCells: number;
  areaPercent: number;
  barsMastered: number;
  badgeCount: number;
}

export interface AdminUsersResponse {
  users: AdminUser[];
}

// GET /api/admin/teleport response shape (packages/api/src/routes/
// admin-teleport.ts, Sections 9.3/9.6): where this admin is currently
// teleported to, or null for "not teleported".
//
// An object with a nullable field rather than a bare `null` body, so there
// is one shape to parse either way. While a position stands it IS the
// client's position: tracking/useSampleTracking.ts stops watching GPS and
// reports this point instead, which is what makes the map marker, the
// nearby-bars panel and the check-in offer agree with what the server
// believes.
export interface AdminTeleportState {
  position: { lat: number; lon: number } | null;
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
