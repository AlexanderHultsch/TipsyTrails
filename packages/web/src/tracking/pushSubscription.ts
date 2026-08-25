// Web Push client helpers (SPEC.md Sections 5.9, 7.5, 9.2, Phase 5 step 5).
// Split out of tracking/usePushSubscription.ts so the pure parts - VAPID key
// conversion and turning a browser PushSubscription into the API payload -
// are unit-testable without a jsdom ServiceWorker/PushManager, which do not
// exist (task Section E: this sandbox has no browser push stack at all).

const BASE64_PADDING = '=';

// `PushManager.subscribe()`'s `applicationServerKey` option wants a
// Uint8Array, but the VAPID public key travels everywhere else (.env.example,
// GET /api/push/vapid-public-key) as the URL-safe base64 string web-push's
// `generateVAPIDKeys()` produces - this is the one conversion point.
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = BASE64_PADDING.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

// Internal: what `toSubscriptionPayload` returns, handed straight to
// api/client.ts's subscribePush without ever being held under this name.
interface PushSubscriptionPayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// POST /api/push/subscribe's body shape (routes/push.ts's `subscribeSchema`).
// `PushSubscriptionJSON.keys` is typed optional because the same JSON shape
// also describes a subscription before its keys are known, but
// `PushManager.subscribe()` always returns one with both keys populated
// (RFC 8291's ECDH + auth secret) - a missing key here means something
// upstream is broken, not a state worth rendering around, so this throws
// rather than returning a partial payload.
export function toSubscriptionPayload(
  subscription: globalThis.PushSubscription,
): PushSubscriptionPayload {
  const json = subscription.toJSON();
  const { endpoint } = json;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('Push subscription is missing its endpoint or keys.');
  }
  return { endpoint, keys: { p256dh, auth } };
}
