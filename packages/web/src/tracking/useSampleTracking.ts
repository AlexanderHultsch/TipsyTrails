import { useEffect, useRef, useState } from 'react';
import { CONFIG } from '@tipsytrails/shared';
import { ApiError, postSamples } from '../api/client.js';
import type { Sample, VisitSummary } from '../api/types.js';
import { computeConnectionStatus, computeGpsStatus } from './status.js';
import type { ConnectionStatus, GpsStatus } from './status.js';

const SYNC_ERROR_MESSAGE = 'Could not sync your position. Your samples stay queued and will retry.';

// The most recent position accepted from the Geolocation API and its
// accuracy - in-memory only (Section 10.2 forbids persisting it), used by
// tracking/useVisits.ts to compute which discovered bars are currently
// within onsiteRadiusM(accuracy) (Section 7.5 step 1).
export interface LastAcceptedPosition {
  lat: number;
  lon: number;
  accuracy: number;
}

export interface SampleTrackingState {
  gpsStatus: GpsStatus;
  connectionStatus: ConnectionStatus;
  trackingActive: boolean;
  queueDepth: number;
  lastNewCells: number | null;
  postError: string | null;
  // Increments once per successful POST /api/samples that actually revealed
  // a cell (result.newCells > 0). Unlike lastNewCells - a count that can
  // repeat the same value across two different batches - this is monotonic,
  // so it is what map/fog/useFogLayer.ts depends on to notice "a reveal
  // just happened" and refetch the mask (see that file's own comment on
  // why GET /api/fog is refetched rather than diffed some cleverer way).
  revealVersion: number;
  // Increments once per successful POST /api/samples that reported a newly
  // discovered bar (result.newBars.length > 0). Kept separate from
  // revealVersion: a bar found inside fog the player has already revealed
  // produces newBars with newCells: 0, so a signal tied to revealed cells
  // would never fire for it. map/bars/useBarMarkers.ts is the consumer.
  discoveryVersion: number;
  // The visitUpdates array of the latest successful POST /api/samples
  // (Section 7.5 steps 3-4), replaced on every successful post - including
  // an empty one, unlike visitVersion below. tracking/useVisits.ts pairs
  // this with visitVersion to know both *what* changed and *when*.
  visitUpdates: VisitSummary[];
  // Increments once per successful POST /api/samples that reported any
  // visitUpdates. A third, independent signal from revealVersion and
  // discoveryVersion for the same reason those two are independent of each
  // other: a visit can be touched by a sample that reveals no fog and
  // discovers no bar. Never folded into either.
  visitVersion: number;
  // The most recently accepted position and its accuracy - see
  // LastAcceptedPosition above.
  lastPosition: LastAcceptedPosition | null;
}

// Section 7.2 + 8.6: watches position via watchPosition while the map
// screen is in the foreground, batches samples client-side, throttles
// posts to SAMPLE_MIN_INTERVAL_MS, holds a Screen Wake Lock while running,
// and queues samples across offline stretches rather than dropping them
// (Section 12, Phase 8's "never fail silently" habit, applied early).
export function useSampleTracking(): SampleTrackingState {
  // In-memory only, deliberately - this is what SPEC.md Section 12's
  // "queued samples survive going offline and are posted on reconnect"
  // actually covers (Phase 8 task brief, part C): a stretch offline while
  // this component stays mounted, ended by the browser's 'online' event
  // (handleOnline below). It does not survive the tab being closed or the
  // page reloaded - there is no localStorage/IndexedDB backing here, so a
  // reload starts this ref, and the queue, empty again. Persisting the
  // queue itself was judged out of scope for the offline *shell* (this
  // ref's own samples are the input to POST /api/samples, not the derived,
  // storable state Section 10.2 scopes client-side persistence to - see
  // map/fog/fog-cache.ts for what is persisted instead). App.test.tsx's
  // "queues samples while offline ... flushes ... on reconnect" test proves
  // the narrower claim; there is no test claiming reload-survival, and this
  // comment is that decision on record.
  const queueRef = useRef<Sample[]>([]);
  const watchIdRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const staleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushingRef = useRef(false);

  const [queueDepth, setQueueDepth] = useState(0);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('poor');
  const [trackingActive, setTrackingActive] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [lastNewCells, setLastNewCells] = useState<number | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [revealVersion, setRevealVersion] = useState(0);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [visitUpdates, setVisitUpdates] = useState<VisitSummary[]>([]);
  const [visitVersion, setVisitVersion] = useState(0);
  const [lastPosition, setLastPosition] = useState<LastAcceptedPosition | null>(null);

  useEffect(() => {
    function scheduleStaleCheck() {
      if (staleTimeoutRef.current !== null) {
        clearTimeout(staleTimeoutRef.current);
      }
      staleTimeoutRef.current = setTimeout(() => {
        setGpsStatus('poor');
      }, CONFIG.GPS_STALE_MS);
    }

    function handlePosition(position: GeolocationPosition) {
      const sample: Sample = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
        speed: position.coords.speed,
        timestamp: position.timestamp,
      };
      queueRef.current.push(sample);
      setQueueDepth(queueRef.current.length);
      const now = Date.now();
      setGpsStatus(computeGpsStatus({ accuracy: sample.accuracy, receivedAt: now }, now));
      setLastPosition({ lat: sample.lat, lon: sample.lon, accuracy: sample.accuracy });
      scheduleStaleCheck();
    }

    function startWatch() {
      if (!('geolocation' in navigator) || watchIdRef.current !== null) {
        return;
      }
      watchIdRef.current = navigator.geolocation.watchPosition(
        handlePosition,
        () => {
          // No fix available right now - the stale timeout (if one is
          // already scheduled) will move the GPS status to poor on its
          // own; there is nothing more specific to surface per-error.
        },
        { enableHighAccuracy: true },
      );
      setTrackingActive(true);
    }

    function stopWatch() {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      setTrackingActive(false);
    }

    function acquireWakeLock() {
      if (!('wakeLock' in navigator)) {
        return;
      }
      navigator.wakeLock
        .request('screen')
        .then((sentinel) => {
          wakeLockRef.current = sentinel;
        })
        .catch(() => {
          // Not every browser grants a lock in every state - Section 7.2
          // requires handling this without throwing, not requires success.
          wakeLockRef.current = null;
        });
    }

    function releaseWakeLock() {
      const sentinel = wakeLockRef.current;
      wakeLockRef.current = null;
      sentinel?.release().catch(() => {});
    }

    async function flush() {
      if (flushingRef.current || queueRef.current.length === 0 || !navigator.onLine) {
        return;
      }
      flushingRef.current = true;
      const batch = queueRef.current.slice(0, CONFIG.SAMPLE_MAX_BATCH);
      try {
        const result = await postSamples(batch);
        queueRef.current = queueRef.current.slice(batch.length);
        setQueueDepth(queueRef.current.length);
        setLastNewCells(result.newCells);
        if (result.newCells > 0) {
          setRevealVersion((version) => version + 1);
        }
        if ((result.newBars?.length ?? 0) > 0) {
          setDiscoveryVersion((version) => version + 1);
        }
        setVisitUpdates(result.visitUpdates ?? []);
        if ((result.visitUpdates?.length ?? 0) > 0) {
          setVisitVersion((version) => version + 1);
        }
        setPostError(null);
      } catch (err) {
        setPostError(err instanceof ApiError ? err.message : SYNC_ERROR_MESSAGE);
      } finally {
        flushingRef.current = false;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        startWatch();
        acquireWakeLock();
      } else {
        stopWatch();
        releaseWakeLock();
      }
    }

    function handleOnline() {
      setIsOnline(true);
      void flush();
    }

    function handleOffline() {
      setIsOnline(false);
    }

    if (document.visibilityState === 'visible') {
      startWatch();
      acquireWakeLock();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    const flushInterval = setInterval(() => {
      void flush();
    }, CONFIG.SAMPLE_MIN_INTERVAL_MS);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(flushInterval);
      if (staleTimeoutRef.current !== null) {
        clearTimeout(staleTimeoutRef.current);
      }
      stopWatch();
      releaseWakeLock();
    };
  }, []);

  return {
    gpsStatus,
    connectionStatus: computeConnectionStatus(isOnline, queueDepth),
    trackingActive,
    queueDepth,
    lastNewCells,
    postError,
    revealVersion,
    discoveryVersion,
    visitUpdates,
    visitVersion,
    lastPosition,
  };
}
