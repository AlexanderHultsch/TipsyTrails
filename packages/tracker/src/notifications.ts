// ios/SPEC.md Section 7.7: the four notifications, and the id scheme that
// makes cancellation possible. This is substep B7 - pure functions only, no
// `Host` in this module (`tracker.ts` calls `host.scheduleNotification` with
// what these return, and `host.cancelNotification` with what the id builders
// return), following `visits.ts`'s and `queue.ts`'s own idiom of holding no
// state of its own.
//
// The four, in Section 7.7's table order: the 21-minute reminder, bar
// mastered, bars discovered, signed out. Every word of copy below is
// Section 7.7's own, and `SPEC.md` 7.5's for the reminder's body - fixed
// here in English (CLAUDE.md, constraint C9) and not the executor's to
// refine.
import { CONFIG } from '@tipsytrails/shared';
import type { Bar, VisitSummary } from './events.js';
import type { LocalNotification } from './host.js';

// Ids are stable and predictable because `cancelNotification(id)` needs the
// reminder's id later, without the tracker having kept one on the side.
// Exported so `notifications.test.ts` and `tracker.ts` use one spelling.
export function reminderId(visitId: number): string {
  return `reminder:${visitId}`;
}

export function masteredId(visitId: number): string {
  return `mastered:${visitId}`;
}

export function discoveredId(nowMs: number): string {
  return `discovered:${nowMs}`;
}

export function signedOutId(): string {
  return 'signedOut';
}

// The one conversion boundary this file owns, and the only place
// `packages/tracker` converts a wire value between seconds and
// milliseconds. `VisitSummary.startedAt` arrives from the server in epoch
// SECONDS (`SPEC.md` 9.6, Section 0 rule 6 - the database stores every
// timestamp in seconds); every duration and instant the tracker otherwise
// holds is milliseconds. `config.ts`'s `DERIVED` block is the named
// boundary for that rule applied to *constants*; this is the same rule
// applied to a *wire value* instead; a wire value has no constant to sit
// beside in `config.ts`, so the boundary is this named function rather than
// the `* 1000` CLAUDE.md forbids writing ad hoc at a call site. Nothing else
// in this package converts between the two units.
function startedAtMs(visit: VisitSummary): number {
  return visit.startedAt * 1000;
}

// The 21-minute reminder (`SPEC.md` 7.5's push, made local): scheduled when
// a visit enters the tracker's pending set, at `startedAt + VISIT_PUSH_AFTER_MS`,
// one per visit id - cancelled by `tracker.ts` when that visit leaves the
// set for any reason. Title is the bar's name; body is `SPEC.md` 7.5's own
// on-site sentence, verbatim.
export function buildReminderNotification(visit: VisitSummary): LocalNotification {
  return {
    id: reminderId(visit.id),
    atMs: startedAtMs(visit) + CONFIG.VISIT_PUSH_AFTER_MS,
    title: visit.barName,
    body: "Open Tipsy Trails again while you're still here to complete this visit.",
  };
}

// Bar mastered: immediate, on a `completed` entry in a flush's `visitUpdates`.
export function buildMasteredNotification(visit: VisitSummary, nowMs: number): LocalNotification {
  return {
    id: masteredId(visit.id),
    atMs: nowMs,
    title: `${visit.barName} mastered`,
    body: 'Your visit is complete.',
  };
}

// Bars discovered: immediate, one per flush, on a non-empty `newBars`. Names
// in the order the response gave them - up to three joined with commas, and
// " and <N> more" when there are more than three.
export function buildDiscoveredNotification(bars: Bar[], nowMs: number): LocalNotification {
  const names = bars.map((bar) => bar.name);
  const title = names.length === 1 ? 'New bar discovered' : `${names.length} new bars discovered`;
  const shown = names.slice(0, 3);
  const remaining = names.length - shown.length;
  const body = remaining > 0 ? `${shown.join(', ')} and ${remaining} more` : shown.join(', ');
  return {
    id: discoveredId(nowMs),
    atMs: nowMs,
    title,
    body,
  };
}

// Signed out: immediate, once per `sessionLost` (`tracker.ts` decides which
// occurrences - not `start`'s own 401, `SPEC.md` 5.2's "once").
export function buildSignedOutNotification(nowMs: number): LocalNotification {
  return {
    id: signedOutId(),
    atMs: nowMs,
    title: 'Signed out',
    body: 'Open Tipsy Trails to sign in again.',
  };
}
