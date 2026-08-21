import { CONFIG } from '@tipsytrails/shared';
import { BurgerMenu } from '../components/BurgerMenu.js';

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
export function Privacy() {
  return (
    <main className="screen">
      <BurgerMenu />
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
          and, only if you turn on notifications, your subscription and each reminder travel through
          your browser vendor's own push service (Google, Apple or Mozilla, depending on your
          browser). Map tiles are served by this app's own server, not by OpenStreetMap directly -
          OpenStreetMap is where the underlying map data came from, and it is credited on the map
          itself.
        </p>

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
    </main>
  );
}
