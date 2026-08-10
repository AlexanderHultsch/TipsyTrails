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
// 9.2 defines the full { newCells, newBars, visitUpdates } shape, but newBars
// (Phase 4) and visitUpdates (Phase 5) aren't built yet and the route omits
// them rather than sending fabricated zeros - so only newCells is here.
export interface SamplesResponse {
  newCells: number;
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
