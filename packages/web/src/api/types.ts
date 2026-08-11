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
