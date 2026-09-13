import { useEffect } from 'react';
import { ApiError, errorMessage, updateSettings } from '../api/client.js';
import { getShellBridge } from './bridge.js';
import { postShellSettingsUpdated } from './messages.js';
import type { SettingsUpdateFailure } from './messages.js';

// `requestSettingsUpdate`, page side (`ios/SPEC.md` 8.2 and 11.2, and
// `ios/SPEC.md` 12's rows 3 and 12 of "The list for `main`").
//
// The shell's native Consent screen calls
// `window.__tipsyTrails.requestSettingsUpdate(backgroundTracking)` from its two
// places consent changes - `recordConsent` with `true`, once the box is ticked
// and *before* iOS's Always prompt, and `withdrawConsent` with `false` behind
// the withdrawal confirmation. The page answers it with `PATCH /api/settings`
// and `{ backgroundTracking }` (`SPEC.md` 9.2).
//
// **And, since row 12, it answers the shell twice: `true` at once, and one
// `settingsUpdated` message when that PATCH settles.** The first says a reply is
// coming and the second is the reply. Before it, the Consent screen ticked a box
// and went straight on to iOS's Always prompt with no way to know whether the
// account had recorded anything; what it had instead was the tracker's next
// `start` re-reading `GET /api/auth/me`, which is a different question answered
// much later.
//
// **Why the page makes the request and not the shell.** `ios/SPEC.md` 5.4: one
// client writes settings and it is the web app. A shell that called
// `PATCH /api/settings` itself would be a second writer of the same row, and two
// writers can disagree about anonymity with nobody watching which is right.
//
// Without this handler the box is ticked, the shell goes on to iOS's Always
// prompt, and background tracking runs on a GDPR Article 7 consent that exists
// only in the player's memory of a checkbox. The column
// `users.background_tracking_consented_at` (`SPEC.md` 5.3) is the record that
// consent happened; this is the only thing that writes it from the app.

// The body carries `backgroundTracking` and nothing else, and that is the whole
// point rather than an economy. `PATCH /api/settings` is partial since v1.61: an
// omitted key means unchanged, so a body of one key asserts one setting. Sending
// `isAnonymous` here would have a native consent screen assert a value for a
// setting it never asked about - exactly what the partial body exists to
// prevent - and the value it would assert is whatever the page last happened to
// read.
//
// The argument is not coerced. A non-boolean is a 400 from the schema, logged
// below like any other failure, which is louder and more honest than a
// `Boolean()` that would turn a protocol mistake into a recorded consent.
// **Answers `true`, and that is a promise rather than a status** (row 12): a
// `settingsUpdated` message will be posted when this request settles, exactly
// once, whichever way it settles. The shell reads the value through
// `evaluateJavaScript`'s completion handler and waits for the message; a page
// without this handler returns nothing, which is how it says no reply is coming
// (`bridge.ts`).
export function applyShellSettingsUpdate(backgroundTracking: boolean): true {
  // Two guards, and they are not equal partners - HANDOVER.md's third habit
  // asks that a branch nothing can reach be written down as one. The rejection
  // handler is where every real failure arrives: a 400, a 401, a 5xx, a dead
  // network, all of them rejections of the promise `updateSettings` returns, and
  // it is the guard the tests exercise. The surrounding `try` covers a
  // synchronous throw from `updateSettings` itself, which nothing today can
  // produce - `api/client.ts` does its work inside an async function, so even a
  // `JSON.stringify` failure would reach us as a rejection. It is kept as
  // defence in depth because of where this function is called from: the shell's
  // `evaluateJavaScript`, where an exception is the shell's problem and not the
  // page's (8.2), and where the page has no way to learn it caused one.
  //
  // **Exactly one reply per request, and the two-argument `then` is what makes
  // it exact.** Written as `.then(report).catch(report)` the success path's own
  // failure would reach the rejection handler and post a second, contradicting
  // message; written as two handlers on one `then`, at most one of them can run,
  // and the synchronous `catch` below can only run when no promise was created
  // at all.
  try {
    void updateSettings({ backgroundTracking }).then(
      () => {
        postShellSettingsUpdated(backgroundTracking, null);
      },
      (err: unknown) => {
        reportFailure(backgroundTracking, err);
        postShellSettingsUpdated(backgroundTracking, failureReason(err));
      },
    );
  } catch (err: unknown) {
    reportFailure(backgroundTracking, err);
    postShellSettingsUpdated(backgroundTracking, failureReason(err));
  }
  return true;
}

// Which of 8.2's three reasons a failure is. `ApiError` carries the status the
// page actually saw (`api/client.ts`), so this reads that rather than the
// message: a 401 and a 503 are one sentence apart in prose and two different
// screens apart on the phone.
//
// `status === 0` is that module's one sentinel for "fetch itself rejected, so
// there was never an HTTP status" - the `network_error` code is set in the same
// place - and it is the only thing 8.2's `offline` can honestly mean.
//
// Two cases reach `server` by falling through rather than by matching, and both
// are deliberate. A body the page cannot read (`invalid_response`, O18) carries
// the 2xx it arrived with and is not offline and not a 401; and anything that is
// not an `ApiError` at all is the synchronous throw above, which nothing today
// can produce. Calling either of them `offline` would have the shell tell a
// player with a working connection to try again later, which is the one wrong
// answer of the three.
function failureReason(err: unknown): SettingsUpdateFailure {
  if (err instanceof ApiError) {
    if (err.status === 0) {
      return 'offline';
    }
    if (err.status === 401) {
      return 'unauthenticated';
    }
  }
  return 'server';
}

// **The console line stays, now that the failure is also reported to the
// shell.** When this was written the failure path was unspecified, and the note
// here said so: 8.2 read "the shell does not read a reply to this call - there is
// none", so a failed PATCH was silent to the shell, and a return value or a new
// message would each have been a change to a bridge protocol that belongs to
// `ios-app`. Row 12 is that change, decided there and carried out here, and it
// does not retire this line - it is a different reader. `settingsUpdated` tells
// the shell which of three things went wrong, in a vocabulary a player can be
// shown; this says which value was asked for and what the server's own message
// was, to the web view's console, which is attached to Safari's Web Inspector.
// The same channel `map/fog/fog-controller.ts` uses for its own unattributable
// failures.
function reportFailure(backgroundTracking: boolean, err: unknown): void {
  console.error(
    `[shell] requestSettingsUpdate(${String(backgroundTracking)}): PATCH /api/settings failed, ` +
      'so the account still holds the consent state it held before. ' +
      errorMessage(err),
  );
}

// Attaches the handler to the injected object, and answers with the function
// that removes it again.
//
// **Lifetime.** 8.2 settles that the page attaches this - the shell's guard is
// there so "a page which has not yet implemented it is a no-op", which is only
// possible if the property can be missing - but it does not say when. The
// reading taken here: the handler is attached for as long as the web app is
// mounted, which under the shell is the lifetime of the document. The injected
// script runs at document start on every document load, so a reload (5.2's
// session loss reloads the web view) brings a fresh, bare object that this
// re-attaches to; a single-page navigation is not a document load, so neither
// the object nor the handler is disturbed by one, and no route needs to know
// this exists.
//
// **Re-entrancy.** A second attach can happen - React's StrictMode
// double-invokes effects in development, and the app is mounted twice in some
// tests - so the rule is last-attach-wins, and a detach removes only the
// handler it installed. Without that identity check the first mount's cleanup
// would tear off the second mount's live handler and the app would silently
// stop answering the shell, which is precisely the failure with no symptom this
// whole path exists to avoid.
export function attachSettingsUpdateHandler(): () => void {
  const bridge = getShellBridge();
  if (!bridge) {
    // No shell, so nothing to attach to - and nothing is created either. The
    // web app never brings `window.__tipsyTrails` into existence; only the
    // shell does (8.1), and detection would be worthless if the page could
    // manufacture the thing it detects.
    return () => {};
  }

  // The `true` travels out through the completion handler of the shell's
  // `evaluateJavaScript` (row 12), so it is returned and not dropped here. A
  // fresh function per attach, rather than `applyShellSettingsUpdate` itself,
  // is what makes the identity check in the detach below mean anything.
  const handler = (backgroundTracking: boolean): true =>
    applyShellSettingsUpdate(backgroundTracking);
  bridge.requestSettingsUpdate = handler;

  return () => {
    if (bridge.requestSettingsUpdate === handler) {
      delete bridge.requestSettingsUpdate;
    }
  };
}

// Mounted once, in `App`, above the router: the shell can call at any moment
// and the Consent screen is reachable from three places in the app, so there is
// no route this could sensibly hang off. It is deliberately not conditional on
// there being a session either - a call that arrives signed out answers 401 and
// is logged, which is the truth, whereas a handler that was absent would be
// indistinguishable from a page too old to have one.
export function useShellSettingsUpdate(): void {
  useEffect(() => attachSettingsUpdateHandler(), []);
}
