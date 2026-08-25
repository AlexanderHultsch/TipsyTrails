import type Database from 'better-sqlite3';

// SPEC.md Sections 7.7 and 7.8: who takes part in the competition at all.
// `users.excluded_from_rankings` (migration 003) is one flag with three
// unrelated readers — the leaderboard listing (routes/leaderboard.ts), the
// badge job's candidate sets (badges.ts), and the admin teleport's
// precondition (routes/admin-teleport.ts) — so the column is named here and,
// apart from routes/admin.ts reading and writing it as a plain field of a
// user, nowhere else. Three copies of the literal string
// `excluded_from_rankings` in three modules is exactly the drift this file
// exists to prevent: a rename would have silently left one of them behind,
// and the one it left behind decides who wins.
//
// Not in routes/, for the same reason city-grid.ts is not: badges.ts is not
// a route module and reads this too, so a home under routes/ would invert
// the layering for it.
//
// The three readers want it in three shapes, and that is why this module
// exports three things rather than one. A listing that must also page
// correctly wants a SQL predicate, so the excluded rows are never counted in
// the first place; a candidate filter wants a set, because the values it
// filters have already been computed in memory by queries that are shared
// with surfaces the exclusion must NOT touch (the profile); and the teleport
// precondition wants one row. Forcing all three through one signature would
// only make two of them do more work than they need.

/**
 * The `WHERE`-clause fragment for "this user is ranked". Table-qualified,
 * because the one query that uses it names `users` explicitly and reads
 * better for saying so.
 */
export const RANKED_USERS_SQL = 'users.excluded_from_rankings = 0';

/**
 * Every user id currently excluded from the rankings. Read once per badge
 * evaluation rather than per candidate: the excluded set is tiny (it exists
 * for the owner's own test accounts) and the alternative is a per-user query
 * inside the award loop.
 */
export function excludedFromRankingsUserIds(db: Database.Database): Set<number> {
  const rows = db
    .prepare<[], { id: number }>('SELECT id FROM users WHERE excluded_from_rankings = 1')
    .all();
  return new Set(rows.map((row) => row.id));
}

/**
 * Whether one account is excluded from the rankings. A user id that does not
 * exist reads as `false` — "not excluded" — which is the safe answer for the
 * one caller: the teleport route refuses unless this returns `true`, so an
 * unknown id is refused rather than admitted. (It cannot happen there in any
 * case: `requireAdmin` has already resolved the id from a live session.)
 */
export function isExcludedFromRankings(db: Database.Database, userId: number): boolean {
  const row = db
    .prepare<[number], { excluded_from_rankings: number }>(
      'SELECT excluded_from_rankings FROM users WHERE id = ?',
    )
    .get(userId);
  return row ? Boolean(row.excluded_from_rankings) : false;
}
