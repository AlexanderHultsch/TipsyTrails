// Community bar submission — the duplicate guard (SPEC.md Section 11.3).
//
// Pure and side-effect free, in the same spirit as `grid.ts` and `visits.ts`
// — no network, no database, no Fastify — so `routes/bars.ts`'s
// `POST /api/bars/suggest` handler can share one implementation of "is this
// name too close to an existing bar" instead of growing its own copy.
//
// Both thresholds come from `CONFIG` (CLAUDE.md forbids inlining a radius or
// a threshold at a call site); distance uses `haversineDistanceM` from
// `grid.ts`, the same distance function every other proximity check in this
// codebase uses.

import { CONFIG } from './config.js';
import { haversineDistanceM, type LatLon } from './grid.js';

// ---------------------------------------------------------------------------
// Name normalisation (SPEC.md Section 11.3): "lowercase, strip diacritics,
// strip punctuation, collapse whitespace, and drop leading articles and the
// common suffixes (bar, pub, kneipe, cafe)".
//
// That sentence already fixes the order for the first four steps — it is
// the literal sequence the spec lists, not a free choice — and this
// function follows it verbatim. Only two things below are genuinely
// undetermined by the spec text, so they are decided and recorded here
// rather than left implicit:
//
// 1. Which leading articles. The spec names the suffixes explicitly but not
//    the articles. Tipsy Trails is a German-city app with English UI copy
//    (SPEC.md Section 2, Section 8.1), so both languages' definite/indefinite
//    articles are covered: English "the/a/an", German "der/die/das" and
//    "ein/eine" (the forms that actually precede a business name in
//    nominative case — inflected forms like "einem"/"einer" are possessive/
//    dative and do not occur as a leading article of a name). Deliberately
//    small: adding more would risk stripping a real first word of a name.
//
// 2. Article-then-suffix order. The spec's own sentence lists "leading
//    articles" before "common suffixes", so the leading article is dropped
//    first, then the trailing suffix is checked against whatever token is
//    now last. This also settles the empty-string case below.
// ---------------------------------------------------------------------------

const LEADING_ARTICLES = new Set(['the', 'a', 'an', 'der', 'die', 'das', 'ein', 'eine']);

const TRAILING_SUFFIXES = new Set(['bar', 'pub', 'kneipe', 'cafe']);

/**
 * Normalises a bar name for duplicate comparison, per SPEC.md Section 11.3.
 *
 * Normalising to the empty string is possible and intentional — the spec's
 * own example, "The Bar", loses its leading article ("the") and then its
 * entire remaining content is the trailing suffix ("bar"), leaving nothing.
 * This function does not special-case that away; `findConflictingBar` below
 * is what decides an empty normalised name can never match anything (an
 * empty string trivially equals another empty string, which would otherwise
 * make every name-less remainder collide with every other one).
 */
export function normalizeBarName(name: string): string {
  const lowered = name.toLowerCase();
  const withoutDiacritics = lowered.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const withoutPunctuation = withoutDiacritics.replace(/[^\p{L}\p{N}\s]/gu, '');
  const collapsed = withoutPunctuation.replace(/\s+/g, ' ').trim();

  if (collapsed === '') {
    return '';
  }

  const tokens = collapsed.split(' ');
  if (tokens.length > 0 && LEADING_ARTICLES.has(tokens[0])) {
    tokens.shift();
  }
  if (tokens.length > 0 && TRAILING_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------
// Similarity (SPEC.md Section 11.3: "a normalized Levenshtein ratio").
//
// Definition used here — the standard one for this name: one minus the edit
// distance divided by the length of the longer of the two strings.
//   ratio(a, b) = 1 - levenshtein(a, b) / max(len(a), len(b))
// A ratio of 1 means identical; 0 means as different as two strings of that
// length can be. `a === b` (which also covers both-empty) short-circuits to
// 1 before any division, so the empty/empty case never divides by zero; the
// one-empty-one-not case falls out of the general formula already (the
// longer string's own length is both the edit distance and the divisor,
// giving 0), so it needs no separate guard.
// ---------------------------------------------------------------------------

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let previousRow = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    const currentRow = new Array<number>(b.length + 1);
    currentRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j] + 1, // deletion
        currentRow[j - 1] + 1, // insertion
        previousRow[j - 1] + substitutionCost, // substitution
      );
    }
    previousRow = currentRow;
  }

  return previousRow[b.length];
}

/** The normalized Levenshtein ratio between two strings, in `[0, 1]`. */
export function levenshteinRatio(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLength = Math.max(a.length, b.length);
  return 1 - levenshteinDistance(a, b) / maxLength;
}

// ---------------------------------------------------------------------------
// The duplicate rule itself (SPEC.md Section 11.3): reject if an active bar
// exists within SUGGEST_DUPLICATE_RADIUS_M whose normalized name similarity
// is >= SUGGEST_NAME_SIMILARITY.
// ---------------------------------------------------------------------------

export interface DuplicateCandidateBar extends LatLon {
  id: number;
  name: string;
}

/**
 * The first bar in `activeBars` that conflicts with `candidateName` at
 * `position` — within `SUGGEST_DUPLICATE_RADIUS_M` and with a normalized
 * name similarity >= `SUGGEST_NAME_SIMILARITY` — or `undefined` if none
 * conflicts.
 *
 * A candidate name (or an existing bar's name) that normalizes to the empty
 * string is never considered a match, for either side of the comparison:
 * without this guard, two unrelated names that both normalize away to
 * nothing (e.g. "The Bar" and "Ye Olde Pub") would report a 1.0 ratio and
 * block a legitimate, unrelated submission — the empty string cannot be
 * allowed to match everything.
 */
export function findConflictingBar(
  candidateName: string,
  position: LatLon,
  activeBars: readonly DuplicateCandidateBar[],
  // The radius is a parameter with the community-submission value as its
  // default, because the two callers are asking different questions and one
  // number cannot answer both. Section 11.3 compares two points a person
  // placed and only warns them; Section 11.1's import compares two OSM
  // records and *deletes* one of them, unattended, so its radius is measured
  // against the city's actual data and is currently the tighter of the two
  // (IMPORT_DUPLICATE_RADIUS_M, 15 m, against this default's 25 m). It was
  // once the looser one, on the belief that Karlsruhe's two "Traube" records
  // 25.34 m apart were one venue mapped as a node and as the building way
  // around it; they are two venues, and the radius that merged them would
  // have taken a real bar off the map. See IMPORT_DUPLICATE_RADIUS_M's own
  // note before assuming either direction is the natural one.
  //
  // Everything else about the guard - the normalisation, the empty-name
  // rule, SUGGEST_NAME_SIMILARITY - is shared deliberately, and it is the
  // similarity gate that does the discriminating.
  radiusM: number = CONFIG.SUGGEST_DUPLICATE_RADIUS_M,
): DuplicateCandidateBar | undefined {
  const normalizedCandidate = normalizeBarName(candidateName);
  if (normalizedCandidate === '') {
    return undefined;
  }

  for (const bar of activeBars) {
    if (haversineDistanceM(position, bar) > radiusM) {
      continue;
    }
    const normalizedExisting = normalizeBarName(bar.name);
    if (normalizedExisting === '') {
      continue;
    }
    if (
      levenshteinRatio(normalizedCandidate, normalizedExisting) >= CONFIG.SUGGEST_NAME_SIMILARITY
    ) {
      return bar;
    }
  }

  return undefined;
}
