import type { FastifyBaseLogger } from 'fastify';
import webpush from 'web-push';
import type { VapidConfig } from './config.js';

// SPEC.md Section 3: "Web Push | `web-push` (VAPID) | No third-party service
// required" — this is the one call site in the whole codebase for that
// library, doing RFC 8291 payload encryption and VAPID signing. Everything
// else (maintenance.ts's dispatch, and its tests) depends only on the
// `PushSender` seam below, never on `web-push` directly, so a fake sender
// can stand in without a browser, a push service, or a device — none of
// which this sandbox has (task Section E).

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendOutcome =
  | { delivered: true }
  | {
      delivered: false;
      // SPEC.md Section 5.9: 404/410 mean the subscription is gone for good
      // and the caller must delete it; any other status (or none, for a
      // network-level failure) means "log and leave the subscription in
      // place" instead.
      statusCode?: number;
    };

export interface PushSender {
  send(subscription: PushSubscriptionKeys, payload: string): Promise<PushSendOutcome>;
}

// Returns null (never throws) on an invalid VAPID configuration — e.g. a
// VAPID_SUBJECT that is neither a `mailto:` nor an `https:` URI, which
// `webpush.setVapidDetails` rejects synchronously — so a typo in a VAPID_*
// value degrades to "push disabled" the same way an absent one does, rather
// than taking the container down. The task brief only requires PUBLIC_ORIGIN
// and SESSION_SECRET to be hard requirements.
export function createWebPushSender(
  config: VapidConfig,
  log?: FastifyBaseLogger,
): PushSender | null {
  try {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  } catch (err) {
    log?.warn(
      { err },
      'Invalid VAPID configuration (VAPID_SUBJECT/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY); ' +
        'push reminders are disabled.',
    );
    return null;
  }

  return {
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        );
        return { delivered: true };
      } catch (err) {
        const statusCode = (err as { statusCode?: unknown }).statusCode;
        return {
          delivered: false,
          statusCode: typeof statusCode === 'number' ? statusCode : undefined,
        };
      }
    },
  };
}
