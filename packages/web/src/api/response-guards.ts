// Runtime narrowing for the handful of API responses whose *shape* the client
// cannot afford to take on trust (SPEC.md Sections 9.6, Open Item O18).
//
// WHY THIS EXISTS AT ALL. `request<T>` in client.ts ends by returning
// `body as T`. A cast is a promise to the compiler and not a check at runtime,
// so whatever the server actually sent reaches React under a type that may be
// a lie. The realistic way that happens here is not a hostile server, it is
// our own: this is a PWA with a service worker (Section 4.1), so a client
// cached at one version talks to an API deployed at another for as long as it
// takes the shell to update. A field that moved, was renamed, or changed type
// arrives as `undefined`, `undefined` through arithmetic is `NaN`, `NaN` in a
// template renders "NaN", and a percentage rendered with `.toFixed(1)` becomes
// "NaN%" beside three figures that look like data. Nobody sees an error; the
// screen is simply wrong.
//
// WHY THIS LIVES IN packages/web AND NOT IN packages/shared. `packages/shared`
// holds what the two sides *both compute from* - the grid projection, the
// on-site radius, the badge period boundaries - facts about the game that must
// have exactly one implementation because both sides act on them. These
// predicates are not that. They describe the web client's view of the wire,
// and that view is already written down in this directory, by hand, in
// `types.ts`, whose own comment records that the shapes are declared twice on
// purpose because `packages/web` does not depend on `packages/api`. A
// validator belongs beside the type it validates: split across packages, a
// renamed field in `types.ts` would be a change in a second package that
// nothing about the rename suggests you need to make. `packages/api` would
// never import these either - it *produces* these shapes rather than consuming
// them - so a module in `shared` would have exactly one consumer, which is not
// what shared means here. Nor would it be cheaper: `shared` is bundled into
// the web build, so the bytes ship either way.
//
// WHAT IS CHECKED, AND THE RULE THAT DECIDES. Only the fields a screen renders
// or computes with, on the responses where a wrong shape produces a silently
// WRONG ANSWER rather than a visible failure. These are narrowing checks on
// the fields that matter, deliberately not a second hand-written copy of the
// server's zod schemas across the package boundary - so a field the client
// never reads is not checked here even when `types.ts` declares it, and the
// predicates say so field by field below. Where a bad shape already crashes or
// renders nothing, a check would only change which error appears, and there is
// none: bar lists, boundaries, the leaderboard and the admin screens are all
// still cast. Section 9.6 records the division; O18 records the rule.
//
// `Number.isFinite`, never `typeof x === 'number'`. `NaN` and `Infinity` are
// both typed `number` and both survive that test, and `NaN` is precisely the
// value this file exists to keep off the screen: it is what arithmetic on a
// missing field produces, and it renders. `fog-cache.ts` already made the same
// call for the same reason on the localStorage boundary.
//
// `null` versus `undefined` versus missing: for every field below, all three
// are rejected identically. None of these fields is nullable in Section 9.6,
// `Number.isFinite(null)` is false and `Number.isFinite(undefined)` is false,
// and `typeof null` is `'object'` rather than `'string'` - so a field that is
// absent, present-and-null, or present-and-undefined fails the same check, and
// none of them can reach a screen.
import type {
  PendingVisitsResponse,
  ProgressResponse,
  SamplesResponse,
  VisitStatus,
  VisitSummary,
} from './types.js';

// Every JSON object arrives as `unknown`; this is the one narrowing every
// predicate below starts from. Arrays are excluded deliberately - none of the
// shapes here is an array at its top level, and `typeof [] === 'object'`.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

// Section 9.6's VisitStatus. Checked as a closed set rather than as `string`
// because tracking/useVisits.ts branches on it: a status it does not recognise
// takes the `else` and *removes* the visit from Section 7.5's persistent
// banner. A renamed status would therefore make a live pending visit vanish
// from the one surface that reports it, which is the silent wrong answer this
// file is about.
const VISIT_STATUSES: readonly VisitStatus[] = ['pending', 'completed', 'expired', 'cancelled'];

function isVisitStatus(value: unknown): value is VisitStatus {
  return typeof value === 'string' && (VISIT_STATUSES as readonly string[]).includes(value);
}

// The fields checked here are exactly the ones the client reads:
// `id` (React key and the identity the banner's merge, cancel and out-of-range
// lookups are all keyed on), `barId` (looked up against the discovered bars),
// `barName` (rendered, three times per item), `confirmedS`/`remainingS` (both
// go through PendingVisitBanner's formatDuration, where a missing number comes
// out as "NaN:NaN"), and `status`.
//
// `startedAt`, `lastSampleAt` and `onsiteSamples` are deliberately NOT checked:
// the client has read none of them since the banner stopped keeping its own
// clock, so a wrong shape in those three produces no answer at all, right or
// wrong. If a screen starts rendering one, it belongs in this list.
export function isVisitSummary(value: unknown): value is VisitSummary {
  return (
    isObject(value) &&
    isFiniteNumber(value.id) &&
    isFiniteNumber(value.barId) &&
    typeof value.barName === 'string' &&
    isFiniteNumber(value.confirmedS) &&
    isFiniteNumber(value.remainingS) &&
    isVisitStatus(value.status)
  );
}

function isVisitSummaryArray(value: unknown): value is VisitSummary[] {
  return Array.isArray(value) && value.every(isVisitSummary);
}

// GET /api/visits/pending (Section 9.2): straight into the banner's state in
// tracking/useVisits.ts, so every VisitSummary in it is rendered.
export function isPendingVisitsResponse(value: unknown): value is PendingVisitsResponse {
  return isObject(value) && isVisitSummaryArray(value.visits);
}

// POST /api/samples (Section 9.2). `visitUpdates` is what Section 7.5 steps
// 3-5 travel on, and since v1.51 its `status` decides whether a visit stays in
// the banner or leaves it. `newCells` and `tooFastToReveal` are the other two
// answers the map acts on - the latter is the *only* honest source for
// Section 7.3's speed refusal, so a client that quietly reads it as `false`
// leaves a player watching fog that will not clear with nothing on screen
// saying why.
//
// `newBars` is checked for being an array and its entries are not: they are a
// bar list, and a malformed bar fails visibly where it is drawn rather than
// silently. The array-ness itself is checked because `.length` and `.some()`
// are read off it directly.
export function isSamplesResponse(value: unknown): value is SamplesResponse {
  return (
    isObject(value) &&
    isFiniteNumber(value.newCells) &&
    Array.isArray(value.newBars) &&
    isVisitSummaryArray(value.visitUpdates) &&
    typeof value.tooFastToReveal === 'boolean'
  );
}

// GET /api/progress (Sections 9.2/7.6) - the clearest case in the whole
// client. `city.percent` is rendered with `.toFixed(1)` on two screens
// (AppHome, CityOverview) and the two bar counts sit beside it on the start
// screen; each district's `percent` is rendered the same way on the district
// overview, keyed by `name`.
//
// `revealedCells` and `playableCells` are not checked, city-wide or per
// district, and neither is a district's `id`: the web client reads none of the
// five. `name` is checked because it is the key the district percentages are
// looked up by - a district whose name is missing does not fail, it silently
// falls through DistrictOverview's `?? 0` and reports 0.0% explored for a
// district the player may have walked half of, which is a wrong answer that
// looks exactly like a right one.
export function isProgressResponse(value: unknown): value is ProgressResponse {
  if (!isObject(value)) {
    return false;
  }
  const city = value.city;
  if (
    !isObject(city) ||
    !isFiniteNumber(city.percent) ||
    !isFiniteNumber(city.barsDiscovered) ||
    !isFiniteNumber(city.barsMastered)
  ) {
    return false;
  }
  return (
    Array.isArray(value.districts) &&
    value.districts.every(
      (district: unknown) =>
        isObject(district) && typeof district.name === 'string' && isFiniteNumber(district.percent),
    )
  );
}
