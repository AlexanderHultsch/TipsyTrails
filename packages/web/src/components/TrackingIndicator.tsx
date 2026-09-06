import { useId, useState, type ReactNode } from 'react';
import { CONFIG } from '@tipsytrails/shared';
import type { BlockedReason } from '../shell/events.js';
import { postShellOpenConsent } from '../shell/messages.js';
import { useShellTracking } from '../shell/useShellTracking.js';
import type { ShellTrackingState } from '../shell/useShellTracking.js';
import type { ConnectionStatus, GpsStatus } from '../tracking/status.js';
import type { SampleTrackingState } from '../tracking/useSampleTracking.js';

// Section 8.6: the three icons keep a fixed shape and carry their state in
// colour alone, from the small named set Section 8.1 permits for this
// indicator and for nothing else. There are three states, not nine - the
// three icons share one scale - so the level is named for the state and
// never for the icon.
type StatusLevel = 'ok' | 'degraded' | 'bad';

const GPS_LEVELS: Record<GpsStatus, StatusLevel> = {
  good: 'ok',
  fair: 'degraded',
  poor: 'bad',
};

const CONNECTION_LEVELS: Record<ConnectionStatus, StatusLevel> = {
  online: 'ok',
  syncing: 'degraded',
  offline: 'bad',
};

// In the browser, tracking has no bad state: it pauses when the app is not
// in the foreground, which is how phones work rather than a fault - so
// paused is degraded, and the panel below says why in words.
const TRACKING_LEVELS: Record<'active' | 'paused', StatusLevel> = {
  active: 'ok',
  paused: 'degraded',
};

// Inside the iPhone shell the same icon carries four states instead
// (`SPEC.md` 8.6, `ios/SPEC.md` 8.3), and two of them are bad: a blocked
// authorization and a lost session are both faults, and neither is how
// phones work. `unreported` is the shell not having answered yet
// (shell/useShellTracking.ts) and is degraded rather than bad, because
// nothing is known to be wrong - only nothing is known.
//
// **The shapes do not change.** `SPEC.md` 8.6 fixes them for every state on
// every platform, and the `StatusIcon` below takes no state but a level and
// a name, so the four states can only ever reach the same three colours and
// the same one path. What changes is the words.
const SHELL_TRACKING_LEVELS: Record<ShellTrackingState['kind'], StatusLevel> = {
  background: 'ok',
  foregroundOnly: 'degraded',
  blocked: 'bad',
  idle: 'bad',
  unreported: 'degraded',
};

// `ios/SPEC.md` 7.3's four blocked reasons, in words. `servicesOff` names the
// device-wide switch rather than the app's permission, which is 6.5's
// requirement rather than a nicety: iOS reports "the player refused" and
// "Location Services is off for this iPhone" identically as `.denied`, the
// tracker is given the third field that tells them apart, and this sentence
// is the only place a player ever sees the difference.
const BLOCKED_REASONS: Record<BlockedReason, string> = {
  reducedAccuracy: 'Precise Location is off',
  denied: 'location access denied',
  restricted: 'location access restricted',
  servicesOff: 'Location Services is off',
};

// The state in words, short enough for an accessible name. One string per
// state, reused by the panel's "Right now" line with its first letter
// capitalised, so the two can never describe different states.
function shellTrackingWords(shell: ShellTrackingState): string {
  switch (shell.kind) {
    case 'background':
      return 'on in the background';
    case 'foregroundOnly':
      return 'on while open only';
    case 'blocked':
      return shell.reason ? `blocked - ${BLOCKED_REASONS[shell.reason]}` : 'blocked';
    case 'idle':
      return 'not signed in';
    case 'unreported':
      return 'not reported yet';
  }
}

function capitalise(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The panel's own words for each state - what it means and, where there is
// one, what to do about it. The browser's sentence about tracking pausing in
// the background is not among them: it is true of the browser and of nothing
// else (`SPEC.md` 8.6), and `ios/SPEC.md` 8.4 replaces it here rather than
// letting the app repeat it.
function shellTrackingExplanation(shell: ShellTrackingState): string {
  switch (shell.kind) {
    case 'background':
      return (
        "Tipsy Trails is recording your position even when it's closed or your screen is off, " +
        'so a walk counts without you opening the app.'
      );
    case 'foregroundOnly':
      return shell.because === 'whenInUse'
        ? 'Tipsy Trails may use your location only while the app is open, so nothing is recorded ' +
            'once you switch away. Background tracking needs the "Always" permission.'
        : "You haven't turned background tracking on, so Tipsy Trails records only while the app " +
            'is open. Turning it on lets a walk count with the phone in your pocket.';
    case 'blocked':
      return shell.reason
        ? `Nothing is being recorded: ${BLOCKED_REASONS[shell.reason]}. Until that changes, no ` +
            'fog clears and no bar is discovered.'
        : 'Nothing is being recorded, because this phone is not letting Tipsy Trails use your ' +
            'location. Until that changes, no fog clears and no bar is discovered.';
    case 'idle':
      return "You're not signed in, so nothing is being recorded.";
    case 'unreported':
      return 'The app has not reported its tracking state yet.';
  }
}

const GPS_LABELS: Record<GpsStatus, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

function connectionLabel(state: SampleTrackingState): string {
  const { connectionStatus, queueDepth } = state;
  if (connectionStatus === 'offline') {
    return queueDepth > 0 ? `Offline (${queueDepth} queued)` : 'Offline';
  }
  if (connectionStatus === 'syncing') {
    return `Syncing (${queueDepth} queued)`;
  }
  return 'Online';
}

function trackingLabel(state: SampleTrackingState): string {
  return state.trackingActive ? 'Tracking' : 'Paused';
}

// Section 8.6: "an accessible name that states its state in words rather
// than naming the icon". These are that name and nothing else - they are
// not a substitute for the luminance separation of the palette, which is
// asserted from the real tokens in App.a11y.test.tsx.
function gpsIconLabel(status: GpsStatus): string {
  return `GPS signal: ${status}`;
}

function connectionIconLabel(status: ConnectionStatus): string {
  return `Connection: ${status}`;
}

// The browser's two states, and the shell's four, in the one pattern
// Section 8.6 fixes: the icon's own name, then the state in words. The
// heading differs because the icon means something else in the two places -
// in Safari it is _foreground_ tracking, active or paused, and in the shell
// it is tracking, which can be happening in a pocket (ios/SPEC.md 8.3).
function trackingIconLabel(active: boolean): string {
  return `Foreground tracking: ${active ? 'active' : 'paused'}`;
}

function shellTrackingIconLabel(shell: ShellTrackingState): string {
  return `Tracking: ${shellTrackingWords(shell)}`;
}

// The shape markup exists exactly once per icon and takes no state: the svg
// is drawn in `currentColor` and only the level class below sets that
// colour, so a shape cannot drift apart between two states of the same
// icon. Section 8.6 fixes the shapes by decision; this is what makes that
// decision structural rather than a convention to be remembered.
function StatusIcon({
  name,
  level,
  label,
  children,
}: {
  name: 'gps' | 'connection' | 'tracking';
  level: StatusLevel;
  label: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`tracking-indicator__icon tracking-indicator__icon--${name} tracking-indicator__icon--${level}`}
      role="img"
      aria-label={label}
      focusable="false"
    >
      {children}
    </svg>
  );
}

// Section 8.6: a compact GPS / connection / foreground-tracking indicator,
// always visible on the map screen, that opens a short explanation of each
// state when tapped. One button holding three icons rather than three
// buttons: one tap target, which keeps the 44px minimum of Section 8.2.
//
// The button takes no aria-label of its own. Its accessible name is
// computed from its contents - the visually hidden lead-in below, then each
// icon's own name - so a screen reader hears what the control opens *and*
// the three states it is reporting, and that name follows the state instead
// of being a fixed string that goes stale. aria-expanded/aria-controls say
// the rest: this is a disclosure, and here is what it discloses.
export function TrackingIndicator({ state }: { state: SampleTrackingState }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // The third icon's four shell states, and `null` in every browser
  // (ios/SPEC.md 8.3). They come from the shell module rather than from
  // `state`, which is what keeps `SampleTrackingState` at thirteen members;
  // `state.trackingActive` stays the coarse boolean this component uses in
  // Safari, and is the same event read less specifically under the shell.
  const shellTracking = useShellTracking();

  return (
    <div className="tracking-indicator">
      <button
        type="button"
        className="tracking-indicator__button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="visually-hidden">Tracking status.</span>
        {/* A map pin: a teardrop outline with a hollow centre, the mark for
            "where you are". */}
        <StatusIcon
          name="gps"
          level={GPS_LEVELS[state.gpsStatus]}
          label={gpsIconLabel(state.gpsStatus)}
        >
          <path d="M12 3.2a6 6 0 0 0-6 6c0 4.2 6 11.6 6 11.6s6-7.4 6-11.6a6 6 0 0 0-6-6z" />
          <circle cx="12" cy="9.2" r="2.2" />
        </StatusIcon>
        {/* A broadcast mark: two arcs opening upwards over a filled dot,
            the shape a signal reaching out from a point. */}
        <StatusIcon
          name="connection"
          level={CONNECTION_LEVELS[state.connectionStatus]}
          label={connectionIconLabel(state.connectionStatus)}
        >
          <path d="M4.6 10.4a10.5 10.5 0 0 1 14.8 0" />
          <path d="M8.1 13.9a5.5 5.5 0 0 1 7.8 0" />
          <circle className="tracking-indicator__icon-dot" cx="12" cy="17.8" r="1.5" />
        </StatusIcon>
        {/* A trail: a zigzag route climbing from bottom left to top right,
            with a filled dot at its head for the position being recorded. */}
        <StatusIcon
          name="tracking"
          level={
            shellTracking
              ? SHELL_TRACKING_LEVELS[shellTracking.kind]
              : TRACKING_LEVELS[state.trackingActive ? 'active' : 'paused']
          }
          label={
            shellTracking
              ? shellTrackingIconLabel(shellTracking)
              : trackingIconLabel(state.trackingActive)
          }
        >
          <path d="M4.2 19.4 9 12.2l4.8 3.4L18.6 7" />
          <circle className="tracking-indicator__icon-dot" cx="18.6" cy="7" r="2" />
        </StatusIcon>
      </button>
      {open && (
        <div
          id={panelId}
          className="tracking-indicator__panel"
          role="dialog"
          aria-label="Tracking status"
        >
          {/* With the words gone from the button, this panel is the only
              place the current state is readable as text - so it says both
              what each state means (which is what makes an icon-only
              indicator learnable at all) and which one is in force right
              now, queue depth included. */}
          <dl>
            <dt>GPS</dt>
            <dd>
              <span className="tracking-indicator__current">
                Right now: {GPS_LABELS[state.gpsStatus]}
              </span>
              Good: within {CONFIG.GPS_ACCURACY_GOOD_M} m. Fair: within {CONFIG.GPS_ACCURACY_FAIR_M}{' '}
              m. Poor: worse than that, or no recent fix.
            </dd>
            <dt>Connection</dt>
            <dd>
              <span className="tracking-indicator__current">
                Right now: {connectionLabel(state)}
              </span>
              Online: your position is syncing normally - samples are batched and sent every few
              seconds, so a few waiting is what working looks like. Syncing: samples didn't get
              through on their last try and are waiting for the next one. Offline: no connection
              right now - samples stay queued on this device until it's back.
            </dd>
            {shellTracking ? (
              <>
                <dt>Tracking</dt>
                <dd>
                  <span className="tracking-indicator__current">
                    Right now: {capitalise(shellTrackingWords(shellTracking))}
                  </span>
                  {shellTrackingExplanation(shellTracking)}
                  {/* 8.3: the degraded state "offers `openConsent`" - the one
                      state with a way out the player can take from here. The
                      shell answers by showing its own Consent screen, which
                      is where both ways out live: the account's consent
                      record (5.4) and iOS's Always upgrade (6.2). Blocked
                      offers nothing here on purpose - its way out is iOS's
                      own Settings app, which the shell deep-links to from
                      that same screen and this page cannot reach. */}
                  {shellTracking.kind === 'foregroundOnly' && (
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={postShellOpenConsent}
                    >
                      Background tracking settings
                    </button>
                  )}
                </dd>
              </>
            ) : (
              <>
                <dt>Foreground tracking</dt>
                <dd>
                  <span className="tracking-indicator__current">
                    Right now: {trackingLabel(state)}
                  </span>
                  Tracking only runs while Tipsy Trails is the open, visible app. It pauses
                  automatically when you switch away and resumes when you come back - phones don't
                  let apps track location in the background, so this is expected, not a bug.
                </dd>
              </>
            )}
          </dl>
          {state.postError && (
            <p className="error-message" role="alert">
              {state.postError}
            </p>
          )}
          <button type="button" className="button button--secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
