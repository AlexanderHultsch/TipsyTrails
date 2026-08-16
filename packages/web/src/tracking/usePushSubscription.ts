import { useCallback, useEffect, useState } from 'react';
import { ApiError, getVapidPublicKey, subscribePush, unsubscribePush } from '../api/client.js';
import { toSubscriptionPayload, urlBase64ToUint8Array } from './pushSubscription.js';
import { SERVICE_WORKER_URL } from '../sw/register.js';

// SPEC.md Section 7.5's 21-minute push reminder, client side (task Section
// D). The service worker itself is public/sw.js, a static file - Phase 8's
// task brief merged it with the offline shell worker (one scope, one
// service worker; see that file's own comment), so the URL now lives in
// sw/register.ts, the one place main.tsx also registers it from.

export type PushPermission = NotificationPermission | 'unsupported';

export interface UsePushSubscriptionResult {
  permission: PushPermission;
  subscribed: boolean;
  working: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// Registration and the permission prompt only ever run inside `enable`,
// which is only ever called from a user-initiated click
// (screens/HowMasteringWorks.tsx's button) - never from an effect on mount.
// An unsolicited permission prompt is exactly the pattern browsers penalise
// (task Section D), so there is deliberately no auto-subscribe path here.
export function usePushSubscription(): UsePushSubscriptionResult {
  const [permission, setPermission] = useState<PushPermission>(() =>
    pushSupported() ? Notification.permission : 'unsupported',
  );
  const [subscribed, setSubscribed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reflects whether a subscription already exists (e.g. from an earlier
  // visit that already granted permission) without requesting permission or
  // creating one - a read, never a write. enable()/disable() below own the
  // writes and update `subscribed` themselves once they finish.
  useEffect(() => {
    if (!pushSupported() || Notification.permission !== 'granted') {
      return;
    }
    let cancelled = false;
    navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => {
        if (!cancelled) {
          setSubscribed(subscription != null);
        }
      })
      .catch(() => {
        // Best-effort read only; enable()/disable() are the source of truth
        // for `subscribed` and report their own errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!pushSupported()) {
      setError('This browser does not support push notifications.');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const permissionResult = await Notification.requestPermission();
      setPermission(permissionResult);
      if (permissionResult !== 'granted') {
        return;
      }

      const { publicKey } = await getVapidPublicKey();
      if (!publicKey) {
        setError('Push notifications are not set up on this server yet.');
        return;
      }

      const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL);
      const ready = await navigator.serviceWorker.ready;
      const existing = await ready.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));

      await subscribePush(toSubscriptionPayload(subscription));
      setSubscribed(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enable notifications.');
    } finally {
      setWorking(false);
    }
  }, []);

  const disable = useCallback(async () => {
    if (!pushSupported()) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        // The server row is removed first: if `unsubscribe()` below then
        // failed for some browser-specific reason, a stale row on the
        // server is worse (a dead endpoint the maintenance tick keeps
        // trying, until it 404s/410s) than a live browser subscription the
        // server has already forgotten about.
        await unsubscribePush({ endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setSubscribed(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disable notifications.');
    } finally {
      setWorking(false);
    }
  }, []);

  return { permission, subscribed, working, error, enable, disable };
}
