import { useId, useState, type ReactNode } from 'react';
import { CONFIG } from '@tipsytrails/shared';
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

// Tracking has no bad state: it pauses when the app is not in the
// foreground, which is how phones work rather than a fault - so paused is
// degraded, and the panel below says why in words.
const TRACKING_LEVELS: Record<'active' | 'paused', StatusLevel> = {
  active: 'ok',
  paused: 'degraded',
};

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

function trackingIconLabel(active: boolean): string {
  return `Foreground tracking: ${active ? 'active' : 'paused'}`;
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
          level={TRACKING_LEVELS[state.trackingActive ? 'active' : 'paused']}
          label={trackingIconLabel(state.trackingActive)}
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
              Online: your position is syncing normally. Syncing: samples are queued and sending.
              Offline: no connection right now - samples stay queued on this device until it's back.
            </dd>
            <dt>Foreground tracking</dt>
            <dd>
              <span className="tracking-indicator__current">Right now: {trackingLabel(state)}</span>
              Tracking only runs while Tipsy Trails is the open, visible app. It pauses
              automatically when you switch away and resumes when you come back - phones don't let
              apps track location in the background, so this is expected, not a bug.
            </dd>
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
