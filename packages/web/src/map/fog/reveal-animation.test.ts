import { describe, expect, it } from 'vitest';
import { fogTexelAt, FOG_REVEAL_ANIMATION_MS, revealProgress } from './reveal-animation.js';

describe('revealProgress', () => {
  it('runs from 0 to 1 across the configured duration', () => {
    expect(revealProgress(0, FOG_REVEAL_ANIMATION_MS, false)).toBe(0);
    expect(revealProgress(FOG_REVEAL_ANIMATION_MS / 2, FOG_REVEAL_ANIMATION_MS, false)).toBe(0.5);
    expect(revealProgress(FOG_REVEAL_ANIMATION_MS, FOG_REVEAL_ANIMATION_MS, false)).toBe(1);
  });

  it('clamps past the end of the duration', () => {
    expect(revealProgress(FOG_REVEAL_ANIMATION_MS * 10, FOG_REVEAL_ANIMATION_MS, false)).toBe(1);
  });

  it('jumps straight to 1 when prefers-reduced-motion is set, at any elapsed time', () => {
    expect(revealProgress(0, FOG_REVEAL_ANIMATION_MS, true)).toBe(1);
    expect(revealProgress(1, FOG_REVEAL_ANIMATION_MS, true)).toBe(1);
  });
});

describe('fogTexelAt', () => {
  it('starts opaque and ends fully clear', () => {
    expect(fogTexelAt(0)).toBe(255);
    expect(fogTexelAt(1)).toBe(0);
  });

  it('is roughly linear in between', () => {
    expect(fogTexelAt(0.5)).toBe(128);
  });

  it('clamps out-of-range progress', () => {
    expect(fogTexelAt(-1)).toBe(255);
    expect(fogTexelAt(2)).toBe(0);
  });
});
