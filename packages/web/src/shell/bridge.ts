// The iPhone shell's bridge, page side (`ios/SPEC.md` 8.1 and 8.2).
//
// The shell injects a `WKUserScript` at document start, main frame only, that
// defines `window.__tipsyTrails`. **The web app detects the shell by the
// presence of that object and by nothing else** - not the user agent, which
// carries a `TipsyTrailsShell/<version>` suffix for the server's log lines and
// is explicitly not a contract (8.1).
//
// This directory is the only place in `packages/web` that may touch
// `window.__tipsyTrails`; every other module asks these functions. That rule
// is what keeps the shell's surface countable when it grows, and it is 8.1's,
// not a local preference.

import { isReplayableEventType } from './events.js';
import type { ReplayableEventType, TrackerEvent } from './events.js';

// What the shell injects. `platform`, `shellVersion` and `trackerVersion` are
// the shell's own (8.1) and are read by nothing here yet; they are typed as the
// shell guarantees them rather than validated, because nothing in this module
// branches on a value. A reader who starts branching on one should validate it
// first - this object arrives from outside the bundle, and the type is a
// declaration of the contract, not proof it was honoured.
//
// `requestSettingsUpdate` is the odd member: the shell *calls* it, and the page
// *attaches* it. 8.2 has the shell guard the call "exactly as `dispatch` is so
// that a page which has not yet implemented it is a no-op rather than a thrown
// exception", which only means anything if the property can be absent - so it
// is optional here, and `useShellSettingsUpdate` is what fills it in.
//
// `dispatch` and `addListener` are the Shell -> page event path of 8.2, left
// undeclared by the block that wrote the rest of this file "until they arrive
// rather than guessed at now". They arrive here, with the `TrackerEvent` union
// of 7.5 beside them in `events.ts`.
//
// **`dispatch` takes a JSON string, not an event object**, and that is not this
// file's reading of 8.2's `dispatch(json)`: it is what
// `ios/TipsyTrails/Web/WebViewController.swift` does. The shell serialises the
// event, wraps it in a JS *string literal*, and evaluates
// `window.__tipsyTrails.dispatch("{...}")`; the injected script parses it and
// ignores anything that does not parse. Nothing in this package calls it - it
// is the shell's own entry point, declared so that this type describes the
// object the shell actually injects, and so that a reader who reaches for it is
// stopped by the signature rather than by a comment.
//
// **Both are optional, and that is the honest declaration rather than a
// weakening.** The page is loaded over the network and the shell is installed
// from TestFlight, so a page can be newer than the shell it is running in - the
// shell's own message handler says so in as many words, and 8.2 has the shell
// guard `requestSettingsUpdate` for the mirror-image case. So the page guards
// its call: an injected object without `addListener` is an older shell, and the
// subscription below is then a no-op rather than a `TypeError` thrown into
// whatever mounted it.
export interface ShellBridge {
  readonly platform: 'ios';
  readonly shellVersion: string;
  readonly trackerVersion: string;
  requestSettingsUpdate?: (backgroundTracking: boolean) => void;
  dispatch?: (json: string) => void;
  addListener?: (listener: (event: TrackerEvent, isReplay: boolean) => void) => void;
}

declare global {
  interface Window {
    __tipsyTrails?: ShellBridge;
  }
}

// The one read of the injected global. `null` means "running in a browser",
// which is every case outside the app.
//
// The check is presence and nothing more, per 8.1. A stricter test - say
// `platform === 'ios'` - would be detection by something else, and it would
// make a future shell that names a second platform invisible to the web app
// rather than merely unusual.
export function getShellBridge(): ShellBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.__tipsyTrails ?? null;
}

// The predicate the rest of the web app asks. It exists beside
// `getShellBridge` so that a screen wanting only "am I in the app" does not
// take a reference to the bridge object it has no business holding.
export function isShell(): boolean {
  return getShellBridge() !== null;
}

// A subscriber to the tracker's events (8.2). **Two callbacks, both required,
// and the reason is the whole of 8.3's counter rule.**
//
// 8.2 gives the listener a second argument, `isReplay`, and 8.3 says what it is
// for: "a replayed payload seeds the members that are replaced on every post
// and must never advance a counter". `useBarStamps` and `useVisits` read
// `version === 0` as "nothing has happened yet in this mount", so a remount
// that replayed a flush and advanced the counters would re-stamp bars
// discovered before the map existed, every time the player returned to the map.
//
// That bug is invisible in a browser - there is no shell, so there is no
// replay - and it shows up on a phone as bars re-announcing themselves. A
// listener typed `(event: TrackerEvent, isReplay: boolean) => void` does not
// protect against it, because TypeScript accepts a one-parameter function
// wherever a two-parameter one is asked for: `subscribeToShellEvents((event) =>
// ...)` would compile, drop the flag on the floor, and be exactly the mutation
// this rule exists to stop. Two named callbacks cannot be written without
// deciding what a replay does, and they say the rule in their names: a replay
// seeds, a live event seeds *and* advances.
//
// The cost is that a subscriber wanting the same seeding under both points both
// at one function - which is the shape 8.3's own table describes anyway, since
// every one of its "replaced by every event" rows is common to the two and only
// the four counters are not.
export interface ShellEventSubscriber {
  // A live event: the tracker has just emitted it.
  onEvent: (event: TrackerEvent) => void;
  // A replayed event: the latest payload of its type, handed over at
  // registration so a listener that arrives late reads the current state at
  // once instead of waiting for the next one. Never a counter's business.
  onReplay: (event: TrackerEvent) => void;
}

// **Why this module keeps its own subscriber list and its own cache of the
// latest payloads, rather than calling `addListener` once per subscriber.**
//
// `addListener` takes a listener and returns nothing: the injected script has
// no way to remove one, and the page cannot change that - the script is the
// shell's, shipped in the app binary. A React hook that registered on mount
// would therefore leave a dead listener behind on every unmount, and the map
// screen is built to mount and unmount freely while the tracker runs on (8.2),
// so the shell's array would grow for as long as the app is open.
//
// So exactly one listener is registered with the shell, for the life of the
// document, and the page fans out from it to subscribers that come and go. The
// consequence is that the *replay* has to be this module's job too: the shell
// replays its cache only to a listener registering with it, and a subscriber
// that arrives later would get nothing. This module therefore keeps the same
// cache the injected script keeps, of the same four types (`events.ts`), and
// replays it - synchronously, as 8.2 requires - to every subscriber that
// registers after the first.
const subscribers = new Set<ShellEventSubscriber>();
const latestByType = new Map<ReplayableEventType, TrackerEvent>();
// The object this module's one listener is registered with. Held so that a
// second, different injected object - a reload brings a fresh one, and so does
// a test - is noticed and registered with, instead of leaving the page
// subscribed to an object nothing dispatches to any more. The cache goes with
// it: it describes the tracker behind that object and not this document.
let listeningTo: ShellBridge | null = null;

function receive(event: TrackerEvent, isReplay: boolean): void {
  if (isReplayableEventType(event.type)) {
    latestByType.set(event.type, event);
  }
  // A copy, because a subscriber is allowed to unsubscribe from inside its own
  // callback - a hook tearing down on the state change it was just handed - and
  // iterating the live set while it is edited is how that becomes a bug that
  // only happens sometimes.
  for (const subscriber of [...subscribers]) {
    deliver(subscriber, event, isReplay);
  }
}

// One subscriber's failure is not the others' (and not the shell's). This is
// called from `evaluateJavaScript` (8.2), where an exception is the shell's
// problem and the page has no way to learn it caused one - the same reasoning
// `useShellSettingsUpdate` states for the same reason - and it is called in a
// loop, where an exception would silently deprive every later subscriber of an
// event it has no other way to hear about.
function deliver(subscriber: ShellEventSubscriber, event: TrackerEvent, isReplay: boolean): void {
  try {
    if (isReplay) {
      subscriber.onReplay(event);
    } else {
      subscriber.onEvent(event);
    }
  } catch (err: unknown) {
    console.error(
      `[shell] a subscriber threw on a ${isReplay ? 'replayed' : 'live'} ${event.type} event; ` +
        'the remaining subscribers still received it.',
      err,
    );
  }
}

/**
 * Subscribes to the tracker's events (`ios/SPEC.md` 8.2), and answers with the
 * function that unsubscribes again.
 *
 * Outside the shell — every browser — there is nothing to subscribe to, so this
 * registers nothing, creates nothing, and answers with a no-op. The page never
 * brings `window.__tipsyTrails` into existence; only the shell does (8.1).
 *
 * Inside the shell the subscriber is called once per cached event type before
 * this function returns, through `onReplay`, exactly as 8.2 requires: "one per
 * cached type at registration time, synchronously, with `isReplay` true". Live
 * events reach `onEvent` from then until the returned function is called.
 */
export function subscribeToShellEvents(subscriber: ShellEventSubscriber): () => void {
  const bridge = getShellBridge();
  if (!bridge?.addListener) {
    return () => {};
  }

  subscribers.add(subscriber);

  if (listeningTo !== bridge) {
    listeningTo = bridge;
    latestByType.clear();
    // The shell replays its own cache into `receive` before this call returns,
    // and `receive` fans it out - which reaches this subscriber, since it is
    // already in the set. So the first subscriber's replay comes from the
    // shell and every later one's comes from the cache that call filled, and
    // each gets it exactly once.
    bridge.addListener(receive);
  } else {
    for (const event of latestByType.values()) {
      deliver(subscriber, event, true);
    }
  }

  return () => {
    subscribers.delete(subscriber);
  };
}
