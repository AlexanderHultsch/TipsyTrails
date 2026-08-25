import { CONFIG } from '@tipsytrails/shared';

export type GpsStatus = 'good' | 'fair' | 'poor';
export type ConnectionStatus = 'online' | 'offline' | 'syncing';

// Internal: `computeGpsStatus`'s argument, which its caller satisfies with a
// value it already holds rather than by naming this type.
interface GpsFix {
  accuracy: number;
  receivedAt: number;
}

// Section 8.6: three GPS states derived from the last accepted sample's
// accuracy, and poor when there has been no fix for GPS_STALE_MS. `now` is
// passed in explicitly rather than read from Date.now() here, so this stays
// a pure function under fake timers in tests.
export function computeGpsStatus(lastFix: GpsFix | null, now: number): GpsStatus {
  if (!lastFix || now - lastFix.receivedAt >= CONFIG.GPS_STALE_MS) {
    return 'poor';
  }
  if (lastFix.accuracy <= CONFIG.GPS_ACCURACY_GOOD_M) {
    return 'good';
  }
  if (lastFix.accuracy <= CONFIG.GPS_ACCURACY_FAIR_M) {
    return 'fair';
  }
  return 'poor';
}

// Section 8.6: online / offline / syncing from navigator.onLine plus the
// samples this device is *behind* on.
//
// WHY THIS IS NOT THE QUEUE DEPTH. It was `queueDepth > 0`, and that reported
// a healthy device as a struggling one for nearly all of its life. Section 7.2
// batches samples on purpose: every accepted fix is pushed onto the queue and
// waits there until the next flush tick, up to SAMPLE_MIN_INTERVAL_MS away. A
// phone with a good fix produces a fix roughly every second, so the queue held
// something almost continuously and the icon read `syncing` almost
// continuously - flapping to `online` only in the instant after each flush
// emptied it. Raising the threshold would not have fixed that: "three requests
// in the air" is the same wrong question with a bigger number, and it would
// have hidden a genuine three-sample backlog.
//
// `behindDepth` is therefore not "samples waiting" but "samples that were
// already queued when the last flush attempt began and are still queued now" -
// counted by tracking/useSampleTracking.ts, which is the only place that knows
// when a flush started and what it removed. A sample that is in the air right
// now, or that is sitting in the batching window waiting for its first send,
// has not yet missed anything and leaves this `online`. One that survived a
// send attempt has: either the POST failed and it stays queued for a retry, or
// it did not fit in SAMPLE_MAX_BATCH and the cycle that should have carried it
// went without it. Both mean the same thing to the player - this device is
// behind, and there is a reason to keep the app open - which is what the
// `syncing` colour is for.
//
// The definition deliberately needs no duration and no count threshold: "it
// survived a flush attempt" is a fact the flush itself observes, so there is no
// tuning constant to get wrong (Section 0, rule 3 would put one in config.ts if
// there were one).
//
// Offline still wins over all of it. A device with no connection is not behind
// on sending, it is unable to send, and Section 8.6 gives that its own state.
export function computeConnectionStatus(online: boolean, behindDepth: number): ConnectionStatus {
  if (!online) {
    return 'offline';
  }
  return behindDepth > 0 ? 'syncing' : 'online';
}
