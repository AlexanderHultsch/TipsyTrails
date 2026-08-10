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
