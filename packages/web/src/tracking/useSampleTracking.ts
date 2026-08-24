import { useEffect, useRef, useState } from 'react';
import { CONFIG } from '@tipsytrails/shared';
import { ApiError, postSamples } from '../api/client.js';
import type { Bar, Sample, VisitSummary } from '../api/types.js';
import { setLastKnownPosition } from './lastKnownPosition.js';
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
  // The GPS course - degrees clockwise from true north, null when the
  // device is stationary or cannot tell. Display-only: it turns the own
  // position marker's direction cone (map/position/own-position-marker.ts)
  // and goes nowhere else. Deliberately not part of the Sample posted to
  // the server (api/types.ts) - constraint C4 / Section 10.2 keeps raw
  // positional data in memory, and the server needs no course for
  // anything.
  heading: number | null;
}

export interface SampleTrackingState {
  gpsStatus: GpsStatus;
  connectionStatus: ConnectionStatus;
  trackingActive: boolean;
  // Every sample still on this device, whatever its history: the one that
  // arrived a second ago, the batch currently in the air, and anything that
  // has failed a send. It is what the indicator panel's "(N queued)" reports,
  // because "how much of my walk is still on this phone" is the number a
  // player can act on. It is deliberately *not* what decides the connection
  // status - tracking/status.ts says why.
  queueDepth: number;
  // There is deliberately no `lastNewCells` here. The count POST /api/samples
  // returns was held as state for one consumer, the map screen's "Revealed N
  // new areas" message, and that message is gone (screens/Map.tsx says why).
  // Nothing else ever read it - what a reveal drives is `revealVersion`
  // below - so the field went with its only reader rather than being left as
  // state nothing consumes.
  //
  // Section 7.3: what the latest successful POST /api/samples said about the
  // reveal being refused for speed. Replaced by every successful post,
  // including one that says `false` - that is what makes the message clear
  // itself once the player slows down, rather than being a flag that only
  // ever gets set. A failed post leaves it alone: the last thing the server
  // actually said stands until the server says something else.
  //
  // Never computed here from `position.speed`. The server applies the rule
  // (packages/api/src/routes/fog.ts) and is the only side that can derive a
  // speed for a fix that carries none.
  tooFastToReveal: boolean;
  postError: string | null;
  // Increments once per successful POST /api/samples that actually revealed
  // a cell (result.newCells > 0). Monotonic, unlike the count itself, which
  // can repeat the same value across two different batches and so cannot
  // signal "something happened"; this is what map/fog/useFogLayer.ts depends
  // on to notice "a reveal just happened" and refetch the mask (see that
  // file's own comment on why GET /api/fog is refetched rather than diffed
  // some cleverer way).
  revealVersion: number;
  // Increments once per successful POST /api/samples that changed *what the
  // bar list would say* — a newly discovered bar (result.newBars.length > 0)
  // or a visit reaching `completed`, which masters its bar (Section 5.7) and
  // so changes the glass that bar's marker draws (Section 8.1). Both are
  // "refetch GET /api/bars", which is all this signal means; the name is
  // older than the second reason.
  //
  // Kept separate from revealVersion: a bar found inside fog the player has
  // already revealed produces newBars with newCells: 0, so a signal tied to
  // revealed cells would never fire for it. Kept separate from visitVersion
  // in the other direction: that one advances on every accepted on-site
  // sample, and refetching every bar at sample rate to catch the one sample
  // in ~40 that completes a visit is the trade the wrong way round.
  // map/bars/useDiscoveredBars.ts is the consumer.
  discoveryVersion: number;
  // Section 7.4: the bars this player had never been near before, exactly as
  // the latest successful POST /api/samples reported them — replaced on
  // every successful post, including with an empty array, unlike
  // newBarsVersion below.
  //
  // This exists because discoveryVersion above cannot answer the question
  // the map screen actually has. A counter says *that* something was
  // discovered; the bar stamp (map/bars/bar-stamps.ts) has to land on a
  // point and carry a name, so it needs *which* bars, and until this field
  // the response's `newBars` were read for their length and dropped. The
  // pair below is modelled on visitUpdates/visitVersion for the reason that
  // pair gives: the array is what changed, the counter is when.
  //
  // Keyed on separately from discoveryVersion rather than folded into it,
  // and that is the whole reason there are two: since v1.29 discoveryVersion
  // also advances when a visit reaches `completed`, because both cases mean
  // "refetch GET /api/bars". Mastering a bar is not discovering one — it has
  // its own message (screens/Map.tsx) — so a stamp keyed on that signal
  // would fire at the wrong moment.
  newBars: Bar[];
  // Increments once per successful POST /api/samples that reported at least
  // one newly discovered bar. The same independence the three counters above
  // already have from each other, for the same reason: a discovery can
  // arrive on a sample that reveals no fog and touches no visit.
  //
  // The emptiness check behind this is guarded twice, deliberately and with
  // no test holding the second one: `BarStamps.stamp` returns on an empty
  // batch before it touches any state, so advancing this counter on a post
  // that discovered nothing has no observable effect - it calls a no-op
  // every ten seconds. Removing the guard here was mutation-tested and
  // survived the whole suite for exactly that reason. It stays because it
  // is what makes the sentence above true for the *next* consumer, which
  // may not guard for itself; it is not load-bearing for today's one.
  newBarsVersion: number;
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
  // How many queued samples have already survived a flush attempt - the
  // "behind" of tracking/status.ts, and the only input to the connection
  // status besides navigator.onLine. Distinct from queueDepth above, which
  // counts everything unsent including the sample that arrived a moment ago
  // and the batch currently in the air. Written only by flush() below,
  // because only flush() knows what a send attempt found and what it left.
  const [behindDepth, setBehindDepth] = useState(0);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>('poor');
  const [trackingActive, setTrackingActive] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [tooFastToReveal, setTooFastToReveal] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [revealVersion, setRevealVersion] = useState(0);
  const [discoveryVersion, setDiscoveryVersion] = useState(0);
  const [newBars, setNewBars] = useState<Bar[]>([]);
  const [newBarsVersion, setNewBarsVersion] = useState(0);
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
      const accepted: LastAcceptedPosition = {
        lat: sample.lat,
        lon: sample.lon,
        accuracy: sample.accuracy,
        // Read off the fix rather than off `sample`: the course is not part
        // of what is posted, and must not become part of it.
        heading: position.coords.heading,
      };
      setLastPosition(accepted);
      // Also outside this component's state, for map/MapPicker.tsx - see
      // tracking/lastKnownPosition.ts for why that screen reads a holder
      // rather than mounting this hook.
      setLastKnownPosition(accepted);
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
      // Read before the await, and it is what makes "behind" measurable: the
      // queue can grow while the request is in the air (watchPosition keeps
      // firing), and those later samples have not missed a send cycle. Only
      // the ones counted here were present when this attempt began.
      const queuedAtAttempt = queueRef.current.length;
      const batch = queueRef.current.slice(0, CONFIG.SAMPLE_MAX_BATCH);
      try {
        const result = await postSamples(batch);
        queueRef.current = queueRef.current.slice(batch.length);
        setQueueDepth(queueRef.current.length);
        // Whatever was queued when this attempt began and is still queued did
        // not fit into SAMPLE_MAX_BATCH: the cycle that should have carried it
        // went without it, so this device is behind by exactly that many
        // samples. Nought whenever the queue fitted in one batch, which is the
        // normal case and is what puts the icon back to `online`.
        setBehindDepth(queuedAtAttempt - batch.length);
        // Set from the answer either way round, never only when it is true:
        // a message about a train that survives the player getting off it is
        // the same kind of lie as a banner claiming time the player never
        // spent at a bar.
        setTooFastToReveal(result.tooFastToReveal === true);
        if (result.newCells > 0) {
          setRevealVersion((version) => version + 1);
        }
        // Section 5.7 / 8.1: mastering a bar changes the glass its marker
        // draws, and a bar reaching `completed` is one the player discovered
        // long before — so nothing else in this response refetches the bar
        // list for it, and the marker would keep drawing the full glass
        // until the next discovery or the next time the map is opened.
        // `completed` is terminal and permanent, so this fires once per bar
        // in a player's whole history, not once per sample.
        const masteredABar = (result.visitUpdates ?? []).some(
          (visit) => visit.status === 'completed',
        );
        // Read once and used three times below, so "was anything discovered
        // by this batch" cannot come out differently for the bar list, the
        // stamp and the stamp's signal.
        const discovered = result.newBars ?? [];
        if (discovered.length > 0 || masteredABar) {
          setDiscoveryVersion((version) => version + 1);
        }
        setNewBars(discovered);
        if (discovered.length > 0) {
          setNewBarsVersion((version) => version + 1);
        }
        setVisitUpdates(result.visitUpdates ?? []);
        if ((result.visitUpdates?.length ?? 0) > 0) {
          setVisitVersion((version) => version + 1);
        }
        setPostError(null);
      } catch (err) {
        // The send failed and nothing left the queue, so everything that was
        // in it when this attempt began has now failed at least one send.
        setBehindDepth(queuedAtAttempt);
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
    connectionStatus: computeConnectionStatus(isOnline, behindDepth),
    trackingActive,
    queueDepth,
    tooFastToReveal,
    postError,
    revealVersion,
    discoveryVersion,
    newBars,
    newBarsVersion,
    visitUpdates,
    visitVersion,
    lastPosition,
  };
}
