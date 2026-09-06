import { useEffect } from 'react';
import { errorMessage, updateSettings } from '../api/client.js';
import { getShellBridge } from './bridge.js';

// `requestSettingsUpdate`, page side (`ios/SPEC.md` 8.2, and `ios/SPEC.md` 12's
// row 3 of "The list for `main`").
//
// The shell's native Consent screen calls
// `window.__tipsyTrails.requestSettingsUpdate(backgroundTracking)` from its two
// places consent changes - `recordConsent` with `true`, once the box is ticked
// and *before* iOS's Always prompt, and `withdrawConsent` with `false` behind
// the withdrawal confirmation. The page answers it with `PATCH /api/settings`
// and `{ backgroundTracking }` (`SPEC.md` 9.2).
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
export function applyShellSettingsUpdate(backgroundTracking: boolean): void {
  // Two guards, and they are not equal partners - HANDOVER.md's third habit
  // asks that a branch nothing can reach be written down as one. The `.catch`
  // is where every real failure arrives: a 400, a 401, a 5xx, a dead network,
  // all of them rejections of the promise `updateSettings` returns, and it is
  // the guard the tests exercise. The surrounding `try` covers a synchronous
  // throw from `updateSettings` itself, which nothing today can produce -
  // `api/client.ts` does its work inside an async function, so even a
  // `JSON.stringify` failure would reach us as a rejection. It is kept as
  // defence in depth because of where this function is called from: the shell's
  // `evaluateJavaScript`, where an exception is the shell's problem and not the
  // page's (8.2), and where the page has no way to learn it caused one.
  try {
    void updateSettings({ backgroundTracking }).catch((err: unknown) => {
      reportFailure(backgroundTracking, err);
    });
  } catch (err: unknown) {
    reportFailure(backgroundTracking, err);
  }
}

// **The failure path is not specified, and this is the honest minimum rather
// than an invention.** 8.2: "The shell does not read a reply to this call -
// there is none", and the shell learns whether consent took through the
// tracker's next `start`, which re-reads `GET /api/auth/me`. So a failed PATCH
// is silent to the shell today, and it stays silent: a return value, a callback
// or a new message would each be a change to the bridge protocol, which belongs
// to `ios-app` and not here. What the page owes is that the failure is not
// invisible to a developer - the web view's console is attached to Safari's Web
// Inspector, and this is the same channel `map/fog/fog-controller.ts` uses for
// its own unattributable failures.
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

  const handler = (backgroundTracking: boolean): void => {
    applyShellSettingsUpdate(backgroundTracking);
  };
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
