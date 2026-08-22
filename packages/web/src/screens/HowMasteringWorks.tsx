import { Link } from 'react-router-dom';
import { DERIVED } from '@tipsytrails/shared';
import { BottomNav } from '../components/BottomNav.js';
import { usePushSubscription } from '../tracking/usePushSubscription.js';

const REQUIRED_MINUTES = Math.round(DERIVED.VISIT_REQUIRED_S / 60);

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

        {permission !== 'unsupported' && (
          <section className="settings-section">
            <p>
              Tipsy Trails can notify you once a pending visit is nearly complete, so you don't have
              to remember to reopen the app yourself.
            </p>
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
