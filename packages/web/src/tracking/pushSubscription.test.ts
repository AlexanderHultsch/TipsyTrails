import { describe, expect, it } from 'vitest';
import { toSubscriptionPayload, urlBase64ToUint8Array } from './pushSubscription.js';

describe('urlBase64ToUint8Array', () => {
  it('decodes a URL-safe base64 string back to its original bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const base64url = Buffer.from(bytes).toString('base64url');

    expect(Array.from(urlBase64ToUint8Array(base64url))).toEqual(Array.from(bytes));
  });

  it('handles a real VAPID public-key length (65 raw bytes) without padding', () => {
    const bytes = new Uint8Array(65).fill(7);
    const base64url = Buffer.from(bytes).toString('base64url');

    expect(base64url.endsWith('=')).toBe(false);
    expect(urlBase64ToUint8Array(base64url).length).toBe(65);
    expect(Array.from(urlBase64ToUint8Array(base64url))).toEqual(Array.from(bytes));
  });
});

describe('toSubscriptionPayload', () => {
  function fakeSubscription(json: unknown): globalThis.PushSubscription {
    return { toJSON: () => json } as unknown as globalThis.PushSubscription;
  }

  it('extracts endpoint and keys from a well-formed PushSubscription', () => {
    const subscription = fakeSubscription({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });

    expect(toSubscriptionPayload(subscription)).toEqual({
      endpoint: 'https://push.example/abc',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    });
  });

  it('throws when the keys are missing', () => {
    const subscription = fakeSubscription({ endpoint: 'https://push.example/abc' });

    expect(() => toSubscriptionPayload(subscription)).toThrow();
  });

  it('throws when the endpoint is missing', () => {
    const subscription = fakeSubscription({ keys: { p256dh: 'a', auth: 'b' } });

    expect(() => toSubscriptionPayload(subscription)).toThrow();
  });
});
