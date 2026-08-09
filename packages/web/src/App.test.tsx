import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App', () => {
  it('renders the wordmark and the pitch', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(<App />);
    });

    expect(container.textContent).toContain('Tipsy Trails');
    expect(container.textContent).toContain('A location-based exploration game for Karlsruhe.');

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
