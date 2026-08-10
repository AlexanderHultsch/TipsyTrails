import { CONFIG } from '@tipsytrails/shared';

export type GpsStatus = 'good' | 'fair' | 'poor';
export type ConnectionStatus = 'online' | 'offline' | 'syncing';

export interface GpsFix {
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
// queue depth of unsent samples.
export function computeConnectionStatus(online: boolean, queueDepth: number): ConnectionStatus {
  if (!online) {
    return 'offline';
  }
  return queueDepth > 0 ? 'syncing' : 'online';
}
