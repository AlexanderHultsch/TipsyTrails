import type { FastifyBaseLogger } from 'fastify';
import webpush from 'web-push';
import { describe, expect, it, vi } from 'vitest';
import type { VapidConfig } from './config.js';
import { createWebPushSender } from './sender.js';

// A real keypair, generated at test runtime rather than committed anywhere
// (CLAUDE.md forbids key material in the repository, including in tests and
// fixtures) — this only exercises `webpush.setVapidDetails`'s local format
// validation, never a network call, so it needs no route to a real push
// service.
const keys = webpush.generateVAPIDKeys();

function fakeLog(): FastifyBaseLogger {
  return { warn: vi.fn() } as unknown as FastifyBaseLogger;
}

describe('createWebPushSender', () => {
  it('returns a sender for a well-formed VAPID configuration', () => {
    const config: VapidConfig = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:admin@example.com',
    };

    const sender = createWebPushSender(config);

    expect(sender).not.toBeNull();
    expect(typeof sender?.send).toBe('function');
  });

  it('accepts an https: subject as well as a mailto: one', () => {
    const config: VapidConfig = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'https://tipsytrails.ahultsch.com',
    };

    expect(createWebPushSender(config)).not.toBeNull();
  });

  it('returns null and logs a warning for a subject that is neither mailto: nor https:', () => {
    const config: VapidConfig = {
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'not-a-valid-subject',
    };
    const log = fakeLog();

    const sender = createWebPushSender(config, log);

    expect(sender).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null without throwing for malformed key material', () => {
    const config: VapidConfig = {
      publicKey: 'not-a-valid-key',
      privateKey: 'also-not-valid',
      subject: 'mailto:admin@example.com',
    };

    expect(() => createWebPushSender(config)).not.toThrow();
    expect(createWebPushSender(config)).toBeNull();
  });
});
