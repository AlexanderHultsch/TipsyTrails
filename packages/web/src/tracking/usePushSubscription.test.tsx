import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePushSubscription } from './usePushSubscription.js';

// jsdom (this suite's test environment, vite.config.ts) implements none of
// serviceWorker/PushManager/Notification, so `permission` resolves to
// 'unsupported' deterministically here - the same real-world case as an
// older browser without Web Push support (task Section E: this sandbox has
// no browser push stack at all, so the real subscribe/enable path against
// push/sender.ts is not exercised here; maintenance.test.ts and
// routes/push.test.ts cover the server side with a faked sender instead).
// What this file does verify: no permission prompt or crash on mount
// (task Section D's "never automatic on page load"), and that enable()
// degrades to a readable error rather than throwing when unsupported.

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness() {
  const { permission, subscribed, working, error, enable } = usePushSubscription();
  return (
    <div>
      <span data-testid="permission">{permission}</span>
      <span data-testid="subscribed">{String(subscribed)}</span>
      <span data-testid="working">{String(working)}</span>
      <span data-testid="error">{error ?? ''}</span>
      <button type="button" onClick={() => void enable()}>
        enable
      </button>
    </div>
  );
}

function text(testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('usePushSubscription', () => {
  it('reports unsupported on mount without requesting permission or throwing', () => {
    act(() => {
      root.render(<Harness />);
    });

    expect(text('permission')).toBe('unsupported');
    expect(text('subscribed')).toBe('false');
    expect(text('error')).toBe('');
  });

  it('enable() surfaces a readable error instead of throwing when push is unsupported', async () => {
    act(() => {
      root.render(<Harness />);
    });

    await act(async () => {
      container.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(text('error')).toBe('This browser does not support push notifications.');
    expect(text('working')).toBe('false');
  });
});
