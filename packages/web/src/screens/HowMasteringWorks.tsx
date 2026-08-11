import { Link } from 'react-router-dom';
import { DERIVED } from '@tipsytrails/shared';
import { BurgerMenu } from '../components/BurgerMenu.js';

const REQUIRED_MINUTES = Math.round(DERIVED.VISIT_REQUIRED_S / 60);

// Section 7.5's transparency requirements: a short, honest explanation of
// the actual mechanic, reachable from the burger menu at any time and
// shown automatically once after the first check-in
// (tracking/masteringExplainer.ts, wired up from screens/Map.tsx).
export function HowMasteringWorks() {
  return (
    <main className="screen">
      <BurgerMenu />
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
      </div>
      <div className="screen__actions">
        <Link className="button button--secondary" to="/map">
          Back to the map
        </Link>
      </div>
    </main>
  );
}
