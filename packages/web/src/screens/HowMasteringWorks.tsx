import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DERIVED } from '@tipsytrails/shared';
import { BottomNav } from '../components/BottomNav.js';
import { isShell } from '../shell/bridge.js';
import { postShellRequestNotifications } from '../shell/messages.js';
import { usePushSubscription } from '../tracking/usePushSubscription.js';

const REQUIRED_MINUTES = Math.round(DERIVED.VISIT_REQUIRED_S / 60);

// What the reminder is for, in one sentence. Both offers below open with it -
// the browser's Web Push opt-in and the shell's `requestNotifications`
// button - because it describes the reminder and not the mechanism that
// delivers it, and a second copy of it is a second thing to keep in step.
const REMINDER_OFFER =
  "Tipsy Trails can notify you once a pending visit is nearly complete, so you don't have to " +
  'remember to reopen the app yourself.';

// Section 7.5's transparency requirements: a short, honest explanation of
// the actual mechanic, reachable from the More sheet at any time and
// shown automatically once after the first check-in
// (tracking/masteringExplainer.ts, wired up from screens/Map.tsx). Phase 5
// step 5 adds the push opt-in here rather than on Settings (where SPEC.md
// Section 8.3's screen table lists "push permission"): this screen already
// explains why the 21-minute reminder exists, so the button that turns it
// on sits right next to the explanation, per the task brief for this step.
export function HowMasteringWorks() {
  const { permission, subscribed, working, error, enable, disable } = usePushSubscription();
  // `ios/SPEC.md` 8.4's first bullet: inside the iPhone shell this offer is
  // "replaced ... by a button that posts `requestNotifications`", and the
  // shell shows its Consent screen's notification step (11.2). Fixed at
  // mount for the same reason `useSampleTracking`'s `shellDriven` is: the
  // screen should not change its offer underneath a player.
  //
  // **The hook is still called, and still reports `unsupported` there** -
  // 8.4 says so in as many words, "which it already does when the Push API
  // is absent, so the change is the button's destination and not the hook".
  // `WKWebView` exposes no `PushManager`, so `pushSupported()` is false and
  // nothing below it - the permission read, the registration, the
  // subscription - can run. It is left unconditional because hooks are, and
  // because a branch here would be this screen deciding what the hook
  // reports rather than reading it.
  const [inShell] = useState(isShell);

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content how-it-works">
        <h1>How mastering works</h1>
        <p>
          A bar is mastered by checking in and staying nearby for at least {REQUIRED_MINUTES}{' '}
          minutes.
        </p>
        <p>
          Tipsy Trails can't track your position while it's in the background or the screen is off -
          phones don't allow that. So instead of watching you the whole time, it only needs two
          samples of your position at the bar, at least {REQUIRED_MINUTES} minutes apart: open the
          app when you arrive, and open it again before you leave.
        </p>
        <p>
          Check in from the map when you're near a discovered bar, then open the app again once
          you've been there a while to complete the visit. Mastering is permanent once it happens -
          it can't be lost.
        </p>

        {/* The shell's offer (ios/SPEC.md 8.4). Same place on the screen and
            the same button as the browser's, and a different destination:
            there is no permission to read, no error to show and no
            subscription to turn off again, because the shell owns all three
            on its Consent screen (11.2). It answers the message by showing
            that screen's notification step; there is no reply, so this
            posts and stops - the same shape as every other Page -> shell
            message (8.2). */}
        {inShell && (
          <section className="settings-section">
            <p>{REMINDER_OFFER}</p>
            <button
              type="button"
              className="button button--secondary"
              onClick={postShellRequestNotifications}
            >
              Enable notifications
            </button>
          </section>
        )}

        {/* The browser's offer, unchanged. `!inShell` is belt and braces
            rather than the load-bearing condition - `usePushSubscription`
            already reports `unsupported` inside a `WKWebView`, which has no
            `PushManager`, so this section is hidden there either way - but
            8.4 says the offer is *replaced*, and a replacement that depended
            on a WebKit fact this page cannot check would be one deployment
            of iOS away from showing both offers at once. */}
        {!inShell && permission !== 'unsupported' && (
          <section className="settings-section">
            <p>{REMINDER_OFFER}</p>
            {error && (
              <p className="error-message" role="alert">
                {error}
              </p>
            )}
            {permission === 'denied' ? (
              <p>
                Notifications are blocked for this site. Allow them in your browser's site settings
                to turn this on.
              </p>
            ) : subscribed ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void disable()}
                disabled={working}
              >
                Turn off notifications
              </button>
            ) : (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => void enable()}
                disabled={working}
              >
                Enable notifications
              </button>
            )}
          </section>
        )}
      </div>
      <div className="screen__actions">
        <Link className="button button--secondary" to="/map">
          Back to the map
        </Link>
      </div>
    </main>
  );
}
