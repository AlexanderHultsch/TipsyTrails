import { useEffect, useRef, useState } from 'react';
import { CONFIG } from '@tipsytrails/shared';
import { ApiError, postSamples } from '../api/client.js';
import type { Sample } from '../api/types.js';
import { computeConnectionStatus, computeGpsStatus } from './status.js';
import type { ConnectionStatus, GpsStatus } from './status.js';

const SYNC_ERROR_MESSAGE = 'Could not sync your position. Your samples stay queued and will retry.';

export interface SampleTrackingState {
  gpsStatus: GpsStatus;
  connectionStatus: ConnectionStatus;
  trackingActive: boolean;
  queueDepth: number;
  lastNewCells: number | null;
  postError: string | null;
}

// Section 7.2 + 8.6: watches position via watchPosition while the map
// screen is in the foreground, batches samples client-side, throttles
// posts to SAMPLE_MIN_INTERVAL_MS, holds a Screen Wake Lock while running,
// and queues samples across offline stretches rather than dropping them
// (Section 12, Phase 8's "never fail silently" habit, applied early).
export function useSampleTracking(): SampleTrackingState {
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
  };
}
