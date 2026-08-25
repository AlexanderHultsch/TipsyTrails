// SPEC.md Section 12, Phase 8 task brief, part B: "the last fog state must
// survive going offline." GET /api/city and GET /api/fog together are what
// map/fog/useFogLayer.ts needs to rebuild the fog layer; this module mirrors
// the last successful response of each into localStorage so a mount that
// happens while offline can still render something, rather than the blank
// map Section 7.3's own comment already accepts for "no fog fetched yet".
//
// Section 10.2 data-minimisation posture: the mask is bit-packed revealed
// cells, the same derived state the server already stores per user
// ("Stored per user: ... fog bitmask ...") - nothing new leaves that
// posture, it is only mirrored client-side. Never raw positions - there are
// none here to mirror.
//
// Keyed per user id, unlike tracking/masteringExplainer.ts's single unkeyed
// flag - that precedent does not carry here. A "tooltip seen" boolean is
// the same for whoever reads it; a revealed-cells mask is one person's
// walking history rendered as a map. Reviewer finding: on a shared device,
// an unkeyed cache lets the next account to sign in - before its own first
// GET /api/fog succeeds - see the previous account's mask. Keying prevents
// that read; useLogout.ts additionally clears the signed-out user's own
// entry so it does not linger on the device after they are done, the same
// "do not keep it around once nobody needs it" instinct Section 10.6 uses
// for the server-side hard delete. Failures throughout stay fail-open, the
// same posture masteringExplainer.ts still sets: storage errors (private
// browsing, full quota, corrupt JSON from an older version) degrade to "no
// cached fog", never a thrown error.
import type { CityMeta, FogMaskResponse } from '../../api/types.js';

const FOG_CACHE_PREFIX = 'tipsytrails:fog-cache:';

function keyFor(userId: number): string {
  return `${FOG_CACHE_PREFIX}${userId}`;
}

// Internal: what `loadFogState` returns, read inline by the one caller
// (map/fog/useFogLayer.ts). `StoredFogState` below is its on-disk twin - the
// mask base64-encoded, since localStorage holds strings.
interface CachedFogState {
  gridWidth: number;
  gridHeight: number;
  cellSizeM: number;
  originLat: number;
  originLon: number;
  mask: Uint8Array;
}

interface StoredFogState {
  gridWidth: number;
  gridHeight: number;
  cellSizeM: number;
  originLat: number;
  originLon: number;
  mask: string;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function saveFogState(userId: number, city: CityMeta, fog: FogMaskResponse): void {
  try {
    const stored: StoredFogState = {
      gridWidth: city.gridWidth,
      gridHeight: city.gridHeight,
      cellSizeM: city.cellSizeM,
      originLat: city.originLat,
      originLon: city.originLon,
      mask: uint8ToBase64(fog.mask),
    };
    window.localStorage.setItem(keyFor(userId), JSON.stringify(stored));
  } catch {
    // Best effort - see file comment. A failed save just means the next
    // offline mount falls back to Section 7.3's no-fog-yet state.
  }
}

export function loadFogState(userId: number): CachedFogState | null {
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredFogState;
    return {
      gridWidth: parsed.gridWidth,
      gridHeight: parsed.gridHeight,
      cellSizeM: parsed.cellSizeM,
      originLat: parsed.originLat,
      originLon: parsed.originLon,
      mask: base64ToUint8(parsed.mask),
    };
  } catch {
    return null;
  }
}

// Called from auth/useLogout.ts on every sign-out (task Section B/reviewer
// finding): removes only the signed-out user's own entry, never the whole
// cache - another account's cached mask on the same device, if there ever
// is one, is untouched.
export function clearFogState(userId: number): void {
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Best effort - see file comment. Nothing more specific to do if
    // storage itself is unusable; there is then nothing to leak either.
  }
}
