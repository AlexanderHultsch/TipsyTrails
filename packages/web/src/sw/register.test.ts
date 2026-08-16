import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVICE_WORKER_URL, registerServiceWorker } from './register.js';

// Phase 8 task brief: "never leave two registrations racing." This proves
// registerServiceWorker() itself always targets the one, shared URL and
// degrades quietly rather than throwing - the App-level half of "registers
// once, not twice" (App.pwa.test.tsx) is the structural check that nothing
// else in the source registers a second, different URL.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerServiceWorker', () => {
  it('does nothing, without throwing, when the browser has no serviceWorker support', () => {
    vi.stubGlobal('navigator', {});
    expect(() => registerServiceWorker()).not.toThrow();
  });

  it('registers exactly the shared SERVICE_WORKER_URL, once', () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    registerServiceWorker();

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL);
  });

  it('swallows a rejected registration rather than throwing an unhandled rejection', async () => {
    const register = vi.fn().mockRejectedValue(new Error('registration failed'));
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    expect(() => registerServiceWorker()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
