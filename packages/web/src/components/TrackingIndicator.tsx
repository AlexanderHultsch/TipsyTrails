import { useId, useState } from 'react';
import { CONFIG } from '@tipsytrails/shared';
import type { SampleTrackingState } from '../tracking/useSampleTracking.js';

const GPS_LABELS: Record<SampleTrackingState['gpsStatus'], string> = {
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

// Section 8.6: a compact GPS / connection / foreground-tracking indicator,
// always visible on the map screen, that opens a short explanation of each
// state when tapped.
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
        <span>GPS: {GPS_LABELS[state.gpsStatus]}</span>
        <span>{connectionLabel(state)}</span>
        <span>{state.trackingActive ? 'Tracking' : 'Paused'}</span>
      </button>
      {open && (
        <div
          id={panelId}
          className="tracking-indicator__panel"
          role="dialog"
          aria-label="Tracking status"
        >
          <dl>
            <dt>GPS</dt>
            <dd>
              Good: within {CONFIG.GPS_ACCURACY_GOOD_M} m. Fair: within {CONFIG.GPS_ACCURACY_FAIR_M}{' '}
              m. Poor: worse than that, or no recent fix.
            </dd>
            <dt>Connection</dt>
            <dd>
              Online: your position is syncing normally. Syncing: samples are queued and sending.
              Offline: no connection right now - samples stay queued on this device until it's back.
            </dd>
            <dt>Foreground tracking</dt>
            <dd>
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
