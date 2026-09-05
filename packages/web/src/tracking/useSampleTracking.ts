import { useEffect, useRef, useState } from 'react';
import { CONFIG, TELEPORT_FIX } from '@tipsytrails/shared';
import { ApiError, postSamples } from '../api/client.js';
import type { Bar, Sample, SamplesResponse, VisitSummary } from '../api/types.js';
import { isShell, subscribeToShellEvents } from '../shell/bridge.js';
import type { TrackerEvent } from '../shell/events.js';
import { clearLastKnownPosition, setLastKnownPosition } from './lastKnownPosition.js';
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

// SPEC.md Sections 7.2/9.3: the admin teleport, as this hook sees it.
//
// `resolving` is an admin's map screen that has asked GET /api/admin/teleport
// and has no answer yet, and it is not the same as `off`. The watch must not
// start during it: a fix that arrives before the answer is a real position
// posted from a server that believes the account is elsewhere (refused, and
// silently), and it is the value the map would centre itself on with its
// one automatic centring. Every non-admin, and every failure of that request
// including the 404 a server without ADMIN_TELEPORT_ENABLED answers, is
// `off` and behaves exactly as this hook always has.
export type TeleportMode =
  { status: 'resolving' } | { status: 'off' } | { status: 'on'; lat: number; lon: number };

// Section 7.2 + 8.6: watches position via watchPosition while the map
// screen is in the foreground, batches samples client-side, throttles
// posts to SAMPLE_MIN_INTERVAL_MS, holds a Screen Wake Lock while running,
// and queues samples across offline stretches rather than dropping them
// (Section 12, Phase 8's "never fail silently" habit, applied early).
//
// Section 9.3: while a teleport stands, the teleported point IS the
// position. The watch is not started, and that one change fixes the map
// marker, the nearby-bars panel, the check-in offer and the battery drain
// together, because all four already read `lastPosition` and nothing else.
// Samples keep being posted on the ordinary cadence from that point, through
// POST /api/samples with every ordinary guard on: the server's `lastAccepted`
// is already there, so a sample from the same point implies zero speed and
// passes. There is no bypass anywhere on that path and there must never be
// one - Section 10.1 is the whole argument.
//
// ios/SPEC.md 8.3: THE HOOK HAS TWO DRIVERS, CHOSEN ONCE AT MOUNT. In every
// browser it is the `watchPosition` driver described above, unchanged. Inside
// the iPhone shell it is the shell driver, which subscribes to the tracker's
// events through shell/bridge.ts and starts no watch, holds no wake lock,
// keeps no queue and posts nothing - inside the shell the tracker is the only
// sampler (ios/SPEC.md I4). `SampleTrackingState` is identical under both,
// which is what lets every screen read it without knowing which is running.
//
// HOW THE SEAM IS EXPRESSED, AND WHAT WAS REJECTED. The branch is one `if` on
// `shellDriven` inside the single existing effect, and its two arms are
// `attachGeolocationDriver` and `attachShellDriver` below. Each arm owns only
// what is its own - the watch, the wake lock and `visibilitychange`; the
// subscription - and everything both drivers need is shared between them: the
// teleport, `flush()`, the `online`/`offline` listeners, the cadence interval,
// and `applyServerAnswer`. That shared middle is not left over from a
// refactor, it is what 8.3 requires: one `computeConnectionStatus` over one
// `behindDepth`, so SPEC.md Section 8.6's `syncing` cannot mean two things on
// one icon, and one teleport path under both drivers.
//
// Three other shapes were weighed and rejected:
//
//  - TWO HOOKS BEHIND ONE DISPATCHER - the clearest to read, and not
//    available: a hook cannot be called conditionally, so both would have to
//    run with the inactive one made inert, which is two live drivers to keep
//    honest instead of one branch.
//  - A DRIVER OBJECT PASSED IN BY THE CALLER - screens/Map.tsx would then
//    have to know which platform it is on in order to construct one, which
//    puts the shell into the one file 8.3 exists to keep ignorant of it, and
//    makes the hook's signature, read by every screen, part of the change.
//  - A SECOND MODULE THE SAFARI PATH IS MOVED INTO - moving working code is
//    the one thing that would turn "the Safari path is unchanged" from a diff
//    into a reading exercise. Nothing that was here has moved.
//
// What makes the Safari path provably unchanged: `shellDriven` is false
// whenever `window.__tipsyTrails` is absent (shell/bridge.ts), which is every
// browser; nothing new runs behind that false; and the existing tracking,
// teleport, locate, check-in and PWA suites pass unedited.
export function useSampleTracking(teleport: TeleportMode): SampleTrackingState {
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
  // ios/SPEC.md 8.3: the driver, "chosen once at mount". A lazy useState
  // initialiser rather than a plain `isShell()` call, and that is the whole
  // of "once": the initialiser runs on the first render and never again, so
  // an injected object arriving later - a shell that finished booting, a test
  // installing one - cannot move a mounted hook from one driver to the other
  // halfway through. It is in the effect's dependency list below for honesty
  // and never changes, so the effect never re-runs for it.
  const [shellDriven] = useState(isShell);
  // Whether the effect below last ran with a teleport standing, so that
  // leaving the mode can drop the position it asserted. A ref rather than
  // state: it is a latch the effect reads and writes, and the effect that
  // reads it is already re-running for the change that sets it.
  const wasTeleportedRef = useRef(false);

  // Read out of the mode as three primitives, because the effect keys on
  // them: an object rebuilt by the map screen on every render would tear the
  // watch down and rebuild it on every render with it.
  const teleportStatus = teleport.status;
  const teleportLat = teleport.status === 'on' ? teleport.lat : null;
  const teleportLon = teleport.status === 'on' ? teleport.lon : null;

  useEffect(() => {
    // Both null for every non-admin and for every admin who is not
    // teleported, which is the case this whole effect had before and still
    // has: one watch, started when the screen is visible.
    const teleported =
      teleportLat !== null && teleportLon !== null ? { lat: teleportLat, lon: teleportLon } : null;
    const resolving = teleportStatus === 'resolving';

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

    // Section 9.3: the teleported point is the position, so there is nothing
    // for a watch to report. Guarded here rather than at each of the three
    // call sites below (mount, visibilitychange, coming back from a hidden
    // tab), so no path into a watch can be added later that forgets the
    // mode. `resolving` holds it back for the same reason - see TeleportMode.
    function startWatch() {
      if (resolving || teleported || !('geolocation' in navigator) || watchIdRef.current !== null) {
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
      // While teleported this stays true, and that is not a cosmetic choice.
      // Section 8.6's third icon reports whether this device is recording a
      // position at all, and it is: the interval below keeps posting the
      // teleported point whether the tab is in the foreground or not, so
      // "paused" would be the false statement here.
      setTrackingActive(teleported !== null);
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

    // What the server said about a batch: the seven members that read the
    // answer rather than the attempt, and the four counters over them.
    //
    // ONE IMPLEMENTATION FOR BOTH DRIVERS, and that is the point of it being
    // a function rather than two copies. Safari's flush() calls it with the
    // body of its own POST; the shell driver calls it with the tracker's
    // `flush` event, which carries the same server answer (ios/SPEC.md 7.5,
    // shell/events.ts's `FlushEvent extends SamplesResponse`). Two copies
    // could advance `discoveryVersion` on different predicates, and the
    // symptom would be a bar list that refetches in one app and not the
    // other - invisible in a browser, which is where every one of these
    // predicates is tested.
    //
    // `advanceCounters` is the whole of ios/SPEC.md 8.2's `isReplay` rule as
    // this hook sees it. A replayed payload is the tracker's latest answer
    // handed to a listener that arrived late, so it must SEED the four
    // replaced-on-every-post members and must never ADVANCE a counter:
    // map/bars/useBarStamps.ts and tracking/useVisits.ts read `version === 0`
    // as "nothing has happened yet in this mount", so a counter advanced by a
    // replay re-stamps bars discovered before the map existed, every time the
    // player returns to the map. Safari passes `true` always, because a POST
    // this hook made is by definition not a replay.
    function applyServerAnswer(result: SamplesResponse, advanceCounters: boolean) {
      // Set from the answer either way round, never only when it is true:
      // a message about a train that survives the player getting off it is
      // the same kind of lie as a banner claiming time the player never
      // spent at a bar.
      setTooFastToReveal(result.tooFastToReveal === true);
      if (advanceCounters && result.newCells > 0) {
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
      if (advanceCounters && (discovered.length > 0 || masteredABar)) {
        setDiscoveryVersion((version) => version + 1);
      }
      setNewBars(discovered);
      if (advanceCounters && discovered.length > 0) {
        setNewBarsVersion((version) => version + 1);
      }
      setVisitUpdates(result.visitUpdates ?? []);
      if (advanceCounters && (result.visitUpdates?.length ?? 0) > 0) {
        setVisitVersion((version) => version + 1);
      }
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
        // A post this hook made is never a replay, so the counters advance.
        applyServerAnswer(result, true);
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

    // THE SAFARI DRIVER (SPEC.md Section 7.2). Everything above is shared;
    // this is the half that is only ever this one's - the watch, the wake
    // lock, and the visibility event that starts and stops both. It is the
    // code this effect has always run, gathered behind one call so that the
    // other driver's absence of it is a fact about a branch rather than a
    // trail of conditions through a function.
    function attachGeolocationDriver(): () => void {
      if (document.visibilityState === 'visible') {
        startWatch();
        acquireWakeLock();
      }
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        stopWatch();
        releaseWakeLock();
      };
    }

    // THE SHELL DRIVER (ios/SPEC.md 8.3). One subscription, and every one of
    // the thirteen members below comes off 7.5's events by that section's
    // table. There is no watchPosition here, no wake lock, no queue of this
    // hook's own and no POST - the tracker owns all four inside the shell
    // (I4), and the only sample this hook can still put on the wire is a
    // standing teleport's, which keeps its own path under both drivers.
    function attachShellDriver(): () => void {
      // One function for both callbacks, because ios/SPEC.md 8.3's table is
      // the same table for a replayed payload and a live one: every row but
      // the four counters is "the latest such event", which a replay is by
      // definition. `advanceCounters` is the single difference, and it is
      // passed to the single place that could act on it.
      function receive(event: TrackerEvent, advanceCounters: boolean): void {
        switch (event.type) {
          // 8.3: `trackingActive` is the TRACKER's state and not this web
          // view's visibility. A phone in a pocket with the map unmounted is
          // recording, and that is the entire point of the app; `blocked` is
          // false because nothing is being queued and `idle` is false because
          // nothing is being tracked (7.3).
          case 'tracking':
            setTrackingActive(event.state === 'tracking');
            return;
          case 'position': {
            // The same computeGpsStatus and the same GPS_STALE_MS timer as
            // Safari, over the event's own `receivedAt` rather than this
            // page's clock (shell/events.ts says why it rides along). 8.3
            // records the one consequence and accepts it: the web app never
            // sees a fix the tracker refused, so a stretch of bad fixes
            // arrives as no events at all and this reaches `poor` through
            // staleness up to GPS_STALE_MS later than Safari reaches it
            // through accuracy. Both end in the same state.
            const now = Date.now();
            setGpsStatus(
              computeGpsStatus({ accuracy: event.accuracy, receivedAt: event.receivedAt }, now),
            );
            scheduleStaleCheck();
            // Section 9.3 / 8.3: while a teleport stands the teleported point
            // IS the position, and the shell's fixes are the real one - which
            // is exactly what the mode exists to override. So they are
            // ignored for `lastPosition` and for nothing else: the GPS
            // reading above is still the honest state of this device's
            // receiver, and Safari has no equivalent only because it stopped
            // its watch.
            if (teleported) {
              return;
            }
            const accepted: LastAcceptedPosition = {
              lat: event.lat,
              lon: event.lon,
              accuracy: event.accuracy,
              // No course under the shell (ios/SPEC.md 6.6, O-I3): Core
              // Location's course is not forwarded, so the direction cone is
              // absent there rather than pointed the wrong way.
              heading: null,
            };
            setLastPosition(accepted);
            // The same out-of-band holder Safari fills, for the same reader -
            // map/MapPicker.tsx. In memory only, here as there (C4 / Section
            // 10.2); ios/SPEC.md I2 says the same of the device.
            setLastKnownPosition(accepted);
            return;
          }
          // The tracker's queue is the only queue there is under this driver
          // (7.4), so its `queued` is `queueDepth` and its `behind` is this
          // hook's internal `behindDepth` - the tracker computes the latter
          // "exactly as useSampleTracking computes it", which is what lets
          // one computeConnectionStatus serve both drivers (8.3, D2).
          //
          // Both are the teleport path's while a teleport stands, exactly as
          // in Safari, so the tracker's counts are not written over them.
          case 'queue':
            if (!teleported) {
              setQueueDepth(event.queued);
              setBehindDepth(event.behind);
            }
            return;
          case 'flush':
            if (!teleported) {
              setQueueDepth(event.queued);
              setBehindDepth(event.behind);
            }
            // Whoever posted them, these are the server's answers, so they
            // keep feeding the members that read the server (8.3).
            applyServerAnswer(event, advanceCounters);
            return;
          // `visit`, `sessionLost` and `notification` (7.5) reach no member of
          // this interface. `sessionLost` in particular is deliberately not
          // `postError`: the shell reloads the web view to its login screen on
          // it (5.2), so a message on the map would be shown to nobody.
          default:
            return;
        }
      }

      return subscribeToShellEvents({
        onEvent: (event) => {
          receive(event, true);
        },
        onReplay: (event) => {
          receive(event, false);
        },
      });
    }

    // Section 9.3, the whole client half of the mode. The teleported point
    // becomes this device's position immediately, without waiting for a
    // cadence tick, because the map marker, the nearby panel and the
    // check-in offer all read it and an empty screen for ten seconds is not
    // a state worth having. `heading: null` because a course is measured
    // between fixes and nothing here moved; `accuracy` is the server's own
    // TELEPORT_FIX, so the radius the client offers check-in at is the
    // radius the server will judge it by.
    if (teleported) {
      wasTeleportedRef.current = true;
      const standingAt: LastAcceptedPosition = {
        ...teleported,
        accuracy: TELEPORT_FIX.accuracy,
        heading: null,
      };
      setLastPosition(standingAt);
      setLastKnownPosition(standingAt);
      // In Safari this is what keeps the third icon honest while the watch is
      // stopped: the interval below is posting, so "paused" would be false.
      // Under the shell driver the icon reports the tracker's own state
      // (ios/SPEC.md 8.3's table, which gives `trackingActive` no teleport
      // exception where it gives the other four one) - the phone in the
      // pocket is still what the player is being told about, and a `tracking`
      // event is the only thing entitled to say otherwise.
      if (!shellDriven) {
        setTrackingActive(true);
      }
    } else if (wasTeleportedRef.current) {
      // Leaving the mode. The teleported point is dropped rather than left
      // standing until the first real fix replaces it: the server has just
      // forgotten it too (the DELETE drops `lastAccepted`), and a marker
      // claiming a position neither side believes is exactly the phantom
      // this feature was filing bugs against.
      wasTeleportedRef.current = false;
      setLastPosition(null);
      clearLastKnownPosition();
    }

    // THE SEAM, and it is one expression. Everything above this line runs
    // under both drivers; everything either driver owns alone is inside the
    // call it is behind. Chosen from `shellDriven`, which was fixed at mount.
    const detachDriver = shellDriven ? attachShellDriver() : attachGeolocationDriver();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    // Left running under both drivers, and under the shell driver it has
    // nothing to do unless a teleport stands. That is a fact about the queue
    // rather than about this timer: `queueRef` is written in exactly two
    // places, `handlePosition` (which only the watch calls, and the watch
    // never starts under the shell) and the teleport branch just below, so
    // under the shell driver an empty queue makes flush() return before it
    // can reach postSamples. Cutting the timer instead would strand whatever
    // the teleport queued at the moment the admin left the mode.
    const flushInterval = setInterval(() => {
      // The teleported point, on the ordinary cadence and through the
      // ordinary route. It needs no bypass and must not have one: the
      // server's `lastAccepted` is already at this point, so the implied
      // speed is zero and every Section 7.2 gate passes on its own terms.
      // What these samples buy is Section 7.5's visit progress - mastering
      // needs on-site samples twenty minutes apart, and a teleport that
      // posted once could never produce the second one.
      //
      // ios/SPEC.md 8.3: this is the one thing the hook still posts under the
      // shell driver, and O-I8 records what it costs - two posters against one
      // account for as long as an admin stays teleported inside the app.
      if (teleported) {
        queueRef.current.push({
          ...teleported,
          ...TELEPORT_FIX,
          timestamp: Date.now(),
        });
        setQueueDepth(queueRef.current.length);
      }
      void flush();
    }, CONFIG.SAMPLE_MIN_INTERVAL_MS);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(flushInterval);
      if (staleTimeoutRef.current !== null) {
        clearTimeout(staleTimeoutRef.current);
      }
      // Last, so that the Safari driver's own teardown - the visibility
      // listener, the watch, the wake lock - still happens in the order it
      // always did, after the interval and the stale timer.
      detachDriver();
    };
    // Deliberately keyed on the teleport mode and the driver, and nothing
    // else. Entering or leaving the mode is the one thing that changes what
    // this hook does, and it happens at most twice in a session; the driver
    // is fixed at mount and can never change, so it never re-runs this. The
    // queue, the in-flight latch and the watch id are all refs, so they
    // survive the rebuild - and so, under the shell driver, does the
    // bridge's cache, which replays the tracker's latest payloads into the
    // new subscription without advancing a counter. Every other value this
    // effect closes over is a setter, which React keeps stable.
  }, [teleportStatus, teleportLat, teleportLon, shellDriven]);

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
