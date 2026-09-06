import { Link } from 'react-router-dom';
import { CONFIG } from '@tipsytrails/shared';
import { useCurrentUser } from '../auth/CurrentUserContext.js';
import { BottomNav } from '../components/BottomNav.js';

const MAIN_SITE_PRIVACY_URL = 'https://ahultsch.com/privacy';
const MAIN_SITE_LEGAL_URL = 'https://ahultsch.com/legal';

// SPEC.md Section 10.3, Phase 8 task brief part A: a short, project-specific
// privacy page, reachable without being signed in (App.tsx only wraps this
// in RedirectIfMustChangePassword, never RequireAuth - the same guard
// Landing and Reset use, so a signed-in user mid forced-password-change
// still finishes that first, but no one is turned away for being signed
// out). Every claim below is written against what Section 10.2 and the
// schema (Section 5) actually store - nothing here is generic policy
// boilerplate, and nothing claims a protection the code does not implement.
//
// This is the one screen in the app that renders for a signed-out reader and
// for a signed-in one, and the two leave it by different doors. A signed-in
// reader has the bottom tab bar (components/BottomNav.tsx). A signed-out one
// does not - the bar is signed-in chrome, because two of its five tabs need
// a session to mean anything - so this screen gives them a plain link back
// instead. Without one the page is a dead end in the installed PWA, which
// has no browser chrome to go back with, and it is reached from exactly one
// place while signed out: the "See what Tipsy Trails stores about you" link
// on Register (screens/Register.tsx), where consent is given. The link
// therefore points back there, at a fixed target rather than at a guess
// about history - a reader who arrived from a bookmark or a shared link
// lands on the screen that would have sent them here, which is also where
// the app begins.
export function Privacy() {
  const { user } = useCurrentUser();

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content privacy">
        <h1>Privacy</h1>
        <p>
          Tipsy Trails is a single-person, self-hosted project, not a company collecting data to
          sell or analyse. This page explains, in plain terms, what this app actually stores about
          you and why. For anything else - the site operator's details, the general privacy policy,
          and the legal notice - see the links at the bottom; there is no separate legal notice
          here.
        </p>

        <h2>What this app stores</h2>
        <ul>
          <li>Your username and a hashed password - never the password itself</li>
          <li>Your security question, and a hashed version of its answer</li>
          <li>A random seed used to draw your avatar</li>
          <li>The time you confirmed you are 18 or older</li>
          <li>A session cookie that keeps you signed in</li>
          <li>The fog map you have revealed: which grid cells, not which paths you walked</li>
          <li>Per-day counts of newly revealed cells - see below</li>
          <li>The bars you have discovered and visited, with visit timestamps</li>
          <li>Badges you have earned</li>
          <li>If you turn on notifications, your browser's push subscription</li>
        </ul>

        <h2>Your position is processed, but never stored as a trail</h2>
        <p>
          While Tipsy Trails is open, your device sends its current position so the app can work out
          which grid cells to reveal, whether you have discovered a bar, and whether a pending visit
          can be confirmed. That position is processed in memory only and is never written to the
          database. The most recent position is held in memory for as long as the app process keeps
          running and is discarded on restart. Tipsy Trails does not keep a history of where you
          have been - only what you have revealed and which bars you have visited.
        </p>

        <h2>The per-day reveal counters</h2>
        <p>
          Alongside the fog map, the app keeps a small count, per day, of how many new grid cells
          you revealed that day. This never records where you were - only how much new area you
          uncovered - but it does record when you were active, so it belongs here, plainly, rather
          than left unmentioned. It is what the weekly and monthly exploration badges and
          leaderboards are computed from - nothing else in the app reads it.
        </p>

        <h2>Retention</h2>
        <p>
          Your data stays for as long as your account exists. A session cookie expires automatically
          after {CONFIG.SESSION_TTL_DAYS} days without a visit. There is no other retention timer:
          deleting your account, below, removes it from the database immediately.
        </p>

        <h2>Playing anonymously</h2>
        <p>
          In Settings, "Play anonymously" hides your username on the leaderboard - you appear as
          "Player #&lt;your id&gt;" instead. Your rank and statistics keep being recorded either
          way, and you can turn this off again at any time.
        </p>

        <h2>Deleting your account</h2>
        <p>
          In Settings, under "Delete account", entering your current password permanently deletes
          your account. Your fog progress, badges, visits, sessions and push subscription are all
          removed from the database immediately, with no soft delete. Bars you suggested stay in the
          shared catalogue for other players, but are no longer linked to your account. Routine
          server backups may still hold a copy until they cycle out - the same as for any
          self-hosted service - but the app itself keeps nothing back.
        </p>

        <h2>Outside services</h2>
        <p>
          Tipsy Trails runs no third-party analytics, trackers or advertising of any kind. Two
          outside services still see your traffic, though: Cloudflare tunnels every request to the
          server - including your position samples - so the app never needs an open port of its own;
          and, in a browser, only if you turn on notifications, your subscription and each reminder
          travel through your browser vendor's own push service (Google, Apple or Mozilla, depending
          on your browser). That second one is about browsers: the iPhone app schedules its
          notifications itself and uses no push service, as the next section says. Map tiles are
          served by this app's own server, not by OpenStreetMap directly - OpenStreetMap is where
          the underlying map data came from, and it is credited on the map itself.
        </p>

        {/* SPEC.md Section 10.3, "The iPhone app" (and ios/SPEC.md 10.2, which
            states the same six things). Rendered on the same page, everywhere
            it renders: the policy is one document and not one per client, so
            this is deliberately NOT behind the shell detection of
            shell/bridge.ts. A reader in Safari sees it too, and a reader in
            the app sees everything above it. Gating it on the shell would make
            the policy fork per client, and would hide the app's own section
            from exactly the reader most likely to be checking what an app on
            their phone does before installing it. */}
        <h2>The iPhone app</h2>
        <p>
          There is an iPhone app, and this policy covers it as well as the browser - it is one
          policy, shown in full to everyone, not one version per device. Everything above applies to
          the app too; what follows is what is different about it.
        </p>
        <ul>
          <li>
            The app can collect your position while it is closed - but only after you have given the
            separate consent it asks for in the app, which explains what background tracking does
            and is a box you tick yourself before iOS asks its own question
          </li>
          <li>
            Those positions are processed exactly as the ones a browser sends, and stored exactly as
            little: revealed grid cells, discovered bars and visit timestamps, never a trail
          </li>
          <li>
            The app schedules its notifications on your device itself and uses no push service, so
            no outside party carries them - the browser vendor's push service named above is about
            notifications in a browser, and does not apply to the app
          </li>
          <li>
            On your device the app stores only your consent choice, your notification choice and its
            own diagnostic counters - none of which is a position
          </li>
          <li>
            The time you consented is stored on your account, and it is deleted with your account
          </li>
          <li>The diagnostic report you can share from the app holds counts and no coordinates</li>
        </ul>

        <h2>More information</h2>
        <p>
          For the operator's details, the general privacy policy, and the legal notice (Impressum),
          see the main site:{' '}
          <a href={MAIN_SITE_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            Privacy policy
          </a>{' '}
          &middot;{' '}
          <a href={MAIN_SITE_LEGAL_URL} target="_blank" rel="noopener noreferrer">
            Legal notice
          </a>
        </p>
      </div>
      {!user && (
        <div className="screen__actions">
          <Link className="button button--secondary" to="/register">
            Back to registration
          </Link>
        </div>
      )}
    </main>
  );
}
