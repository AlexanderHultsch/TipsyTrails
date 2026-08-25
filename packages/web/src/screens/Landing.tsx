import { Link } from 'react-router-dom';
import { Wordmark } from '../components/Wordmark.js';

// Section 8.3's landing screen, at `/`: the signed-out entry, and the actual
// first impression for someone who has never played. It carries the wordmark
// at the same prominence the start screen does, and deliberately not a smaller
// one - the owner's rule is that the wordmark is one thing in one style, and
// the two screens that are *about* the application rather than about the game
// are exactly where it is the subject rather than the signature.
//
// It does not carry the start screen's fogged Karlsruhe backdrop, and that is
// a decision rather than an oversight. The backdrop is a player's own city and
// sits under a player's own numbers; repeated here it would make the
// signed-out and signed-in entries near-identical screens distinguished only
// by which buttons they hold, which is precisely the blur this block was asked
// to remove. This screen is also the coldest start in the application - it
// paints before any session is resolved - and its job is to be there
// instantly and offer the two ways in.
export function Landing() {
  return (
    <main className="screen">
      <div className="screen__content screen__content--middle">
        {/* Inert, and on this screen that is a rule rather than a default.
            Everywhere the wordmark is chrome it now leads to `/app`
            (components/Wordmark.tsx), and `/app` is behind RequireAuth: a
            signed-out reader tapping it here would be sent to /login, which
            is the "logged out" outcome the owner ruled out in the same
            sentence that asked for the link. The hero form takes no
            `linksToStart` at all, so this is enforced by the type rather
            than remembered. */}
        <Wordmark as="h1" prominence="hero" />
        <p>A location-based exploration game for Karlsruhe.</p>
      </div>
      <div className="screen__actions">
        <Link className="button button--primary" to="/login">
          Sign in
        </Link>
        <Link className="button button--secondary" to="/register">
          Register
        </Link>
      </div>
    </main>
  );
}
