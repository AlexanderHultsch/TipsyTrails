import type { VisitSummary } from '../api/types.js';
import { isShell } from './bridge.js';

// The Page -> shell messages of `ios/SPEC.md` 8.2.
//
// The web app posts to
// `window.webkit.messageHandlers.tipsyTrails.postMessage({ type, ... })`, and
// the shell reads the message name and, for two of them, a payload. This module
// is the only place in `packages/web` that touches `window.webkit`, for the
// reason `bridge.ts` states about `window.__tipsyTrails`: a surface that is
// spoken to from one place stays countable when it grows.
//
// **There are nine. Eight of them are 8.2's table, which has seven rows** -
// `visitStarted` and `visitEnded` share one there, and the shell's own
// `WKScriptMessageHandler` shares one `case` for them and dispatches on `type`
// inside it. So "the seven message types" (12's row 3 for `main`) counts rows
// and not types. Step D's Definition of Done names five, which leaves
// `openExternal`, `requestNotifications` and `openConsent` with no item to fail;
// all eight are built here, and the ones without a moment on `main` today are
// listed at the foot of this file with the trigger each is waiting on.
//
// **The ninth is `settingsUpdated`**, row 12 of 12's list for `main` (the
// `for-ios` issue that carries it is #2). It is the reply to
// `requestSettingsUpdate`, which until that row had none: the shell asked the
// page to write consent and then learned whether it took only from the tracker's
// next `start`, one whole `GET /api/auth/me` later, with nothing to show a
// player standing in front of a checkbox in the meantime.

// The messages, with the payloads 8.2 fixes. Five carry `{ type }` and nothing
// else - "the shell reads only the message name for these five".
export type ShellMessage =
  | { type: 'ready' }
  | { type: 'signedIn' }
  | { type: 'signedOut' }
  // The full `VisitSummary` flattened to JSON: the dwelling profile needs every
  // field to seed the tracker's pending set (7.6), and a check-in is the one
  // moment the web app has all of them to hand.
  | { type: 'visitStarted'; visit: VisitSummary }
  // An id and nothing else. 7.5 gives the reason in its own note on this same
  // message: an id is all the tracker is given, and any `VisitSummary` echoed
  // back would carry a stale `status` - the pending one, since that is all
  // either side still has - rather than the true reason the visit ended.
  | { type: 'visitEnded'; id: number }
  | { type: 'openExternal'; url: string }
  | { type: 'requestNotifications' }
  | { type: 'openConsent' }
  // The reply of row 12, posted once per `requestSettingsUpdate` when the
  // `PATCH /api/settings` it triggered has settled. `backgroundTracking` echoes
  // the request, because the shell can have asked twice - ticked, withdrawn -
  // before either answer arrives, and a reply that did not say which request it
  // belonged to would leave it guessing.
  //
  // **Written as two members rather than one with an optional `reason`**, which
  // is the same shape on the wire and a stronger one here: 8.2 has `reason`
  // present only when `ok` is false, and a single member with `ok: boolean` and
  // `reason?:` lets this page post an `ok: true` carrying a reason, or an
  // `ok: false` carrying none, without anything failing. The Swift side reads
  // `{ type, backgroundTracking, ok, reason? }` either way.
  | { type: 'settingsUpdated'; backgroundTracking: boolean; ok: true }
  | {
      type: 'settingsUpdated';
      backgroundTracking: boolean;
      ok: false;
      reason: SettingsUpdateFailure;
    };

// Why the write failed, and the three cases are a distinction the shell acts on
// rather than a log line (8.2, 11.2):
//
//  - `offline` is a transport failure that never got an HTTP status - the phone
//    has no network, or the request never left it. Nothing is wrong with the
//    consent the player gave, and asking again later is the whole remedy.
//  - `unauthenticated` is a 401. The session is gone, which is 5.2's case, and
//    the way out is the web app's login screen and not a retry.
//  - `server` is every other status, the schema's own 400 included. The page got
//    an answer and the answer was no.
export type SettingsUpdateFailure = 'offline' | 'unauthenticated' | 'server';

// Exhaustiveness, checked by the compiler rather than by counting: a message
// added to the union above and not listed here is an error, and so is a name
// listed here that the union does not carry. Exported because the nine are a
// contract with a Swift `switch` that nothing in this repository can compile,
// so the count and the names are worth asserting from a test.
//
// `ShellMessage['type']` collapses the two `settingsUpdated` members to the one
// name they share, so the check still counts message types and not union
// members.
const MESSAGE_TYPES = {
  ready: true,
  signedIn: true,
  signedOut: true,
  visitStarted: true,
  visitEnded: true,
  openExternal: true,
  requestNotifications: true,
  openConsent: true,
  settingsUpdated: true,
} satisfies Record<ShellMessage['type'], true>;

export const SHELL_MESSAGE_TYPES = Object.keys(MESSAGE_TYPES) as ShellMessage['type'][];

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        tipsyTrails?: { postMessage: (message: unknown) => void };
      };
    };
  }
}

// **Two conditions, and they are not the same condition twice.**
//
// `isShell()` is 8.1's one detector, and Section 8's opening rule is that every
// change in it "is behind one detection and is a no-op outside it". Asking here
// is what makes that literally true of these nine messages: in a browser
// nothing is posted, whatever else the page happens to be running inside. A
// `WKWebView` that is not this shell defines `window.webkit` too.
//
// The second condition is the channel itself. It is separate because it can be
// absent while the first holds: the page is served over the network and the
// shell is installed from TestFlight, so a page can be newer than the shell it
// runs in, and a message type that shell has never heard of is one it logs and
// ignores (its own `default:` case) rather than one it crashes on. A missing
// handler is the same case one step further out, and it is a no-op for the same
// reason.
function postShellMessage(message: ShellMessage): void {
  if (typeof window === 'undefined' || !isShell()) {
    return;
  }
  const handler = window.webkit?.messageHandlers?.tipsyTrails;
  if (!handler) {
    return;
  }
  try {
    handler.postMessage(message);
  } catch (err: unknown) {
    // `postMessage` structured-clones its argument, and every message above is
    // a plain object of numbers and strings, so nothing here can fail that
    // way. The guard is for the case the page cannot see: the shell's message
    // handler removed while the document is still alive (it is removed in the
    // web view controller's `deinit`), which throws from `postMessage` itself.
    // A message the shell will not read is not worth an exception on a screen.
    console.error(`[shell] postMessage(${message.type}) failed.`, err);
  }
}

// 8.2: "the web app has mounted". The shell replies with the current state
// through `dispatch`, so this is also what makes a listener registered at mount
// see a state the tracker reached before the document existed.
export function postShellReady(): void {
  postShellMessage({ type: 'ready' });
}

// 8.2: "after login or registration succeeds". The shell re-reads the cookie
// and starts the tracker if it was idle.
export function postShellSignedIn(): void {
  postShellMessage({ type: 'signedIn' });
}

// 8.2: **before** the web app's own logout request. The shell tells the tracker
// `sessionLost('cookie')` first, "so no sample is posted against a cookie about
// to be deleted"; the cookie-store observer of 5.2 is the safety net if the
// message is missed, and a safety net is not a schedule.
export function postShellSignedOut(): void {
  postShellMessage({ type: 'signedOut' });
}

// 8.2: `POST /api/visits` succeeded. Every field is copied out explicitly
// rather than the object being passed through, and that is the guard rather
// than ceremony: the literal is typed as `VisitSummary`, so a field added to
// the shape on `main` fails to compile here until it is carried, which is the
// only way this page can notice that the tracker's `bridgeDictionary` decoder
// (Swift, compiled nowhere in this repository) is being handed less than it
// asks for.
export function postShellVisitStarted(visit: VisitSummary): void {
  postShellMessage({
    type: 'visitStarted',
    visit: {
      id: visit.id,
      barId: visit.barId,
      barName: visit.barName,
      startedAt: visit.startedAt,
      lastSampleAt: visit.lastSampleAt,
      onsiteSamples: visit.onsiteSamples,
      confirmedS: visit.confirmedS,
      remainingS: visit.remainingS,
      status: visit.status,
    },
  });
}

// 8.2: the cancel succeeded. The id and nothing else - see the union above.
export function postShellVisitEnded(id: number): void {
  postShellMessage({ type: 'visitEnded', id });
}

// 8.2/8.5: a link leaves the app, and the shell opens it in Safari.
//
// **Nothing calls this yet, and that is not an omission.** 8.5 has the shell's
// `WKNavigationDelegate` cancel any navigation whose host is not app-bound and
// open it in Safari, and its `WKUIDelegate` do the same for `target="_blank"`,
// so the three outbound links this app has - the GitHub bug report, the two on
// `/privacy`, the OSM attribution - already leave the app without the page
// knowing. 8.5's own words: "The web app does not need to know; `openExternal`
// exists for a screen that wants to be explicit." Inventing a screen that wants
// to be explicit, in order to have somewhere to call this from, would be
// building a UI to fit a message.
export function postShellOpenExternal(url: string): void {
  postShellMessage({ type: 'openExternal', url });
}

// 8.2/8.4: the player asks for notifications from the web app, and the shell
// shows the Consent screen's notification step.
//
// **Nothing calls this yet.** Its moment is 8.4's first bullet - the push offer
// in `screens/HowMasteringWorks.tsx` becomes a button that posts this under the
// shell - which is `ios/SPEC.md` 12's Step D4 and row 6 of the list for `main`,
// a block that has not been built.
export function postShellRequestNotifications(): void {
  postShellMessage({ type: 'requestNotifications' });
}

// 8.2/8.6: the player opens background-tracking settings from the web app, and
// the shell shows the Consent screen.
//
// **Nothing calls this yet.** Its moment is 8.6's shell-only "Background
// tracking" row on the Settings screen, which is Step D4 and row 7 of the list
// for `main`, a block that has not been built.
export function postShellOpenConsent(): void {
  postShellMessage({ type: 'openConsent' });
}

// Row 12: the reply to `requestSettingsUpdate`, posted by
// `useShellSettingsUpdate.ts` when the PATCH it made has settled, and posted
// exactly once per call the shell made.
//
// **`reason === null` is the success case, and that is why there is one function
// and not two.** The two outcomes are one moment - a request settled - and the
// Swift side switches on `ok`; splitting them here would put the choice of which
// to call at the two call sites, which is the one place the failure path and the
// success path must not be able to disagree. A `null` reason cannot produce an
// `ok: false` and a reason cannot produce an `ok: true`, because this is the only
// thing that builds either message.
export function postShellSettingsUpdated(
  backgroundTracking: boolean,
  reason: SettingsUpdateFailure | null,
): void {
  postShellMessage(
    reason === null
      ? { type: 'settingsUpdated', backgroundTracking, ok: true }
      : { type: 'settingsUpdated', backgroundTracking, ok: false, reason },
  );
}
