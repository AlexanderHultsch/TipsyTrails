// SPEC.md Section 7.8's anonymous-display rule ("appear as `Player #{id}`
// with a neutral avatar") and Section 9.5's `player-{id}` handle syntax,
// shared between routes/leaderboard.ts and routes/profile.ts so the two
// surfaces present the exact same masked identity for the same user.

// Every anonymous user renders with this fixed avatar seed instead of their
// own `avatar_seed` (packages/shared/src/avatar.ts: avatars are
// deterministic from a seed) — masking identity means no anonymous user's
// avatar can be told apart from another's.
export const ANONYMOUS_AVATAR_SEED = 'anonymous-player';

export function anonymousDisplayName(userId: number): string {
  return `Player #${userId}`;
}

export function playerHandle(userId: number): string {
  return `player-${userId}`;
}

const PLAYER_HANDLE_PATTERN = /^player-(\d+)$/;

// Parses a `player-{id}` handle (SPEC.md Section 9.5) into its numeric user
// id, or null if `handle` is not a well-formed handle — including ids too
// large to be a real `INTEGER PRIMARY KEY` row.
export function parsePlayerHandle(handle: string): number | null {
  const match = PLAYER_HANDLE_PATTERN.exec(handle);
  if (!match) {
    return null;
  }
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
