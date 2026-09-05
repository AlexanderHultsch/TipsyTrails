import { describe, expect, it } from 'vitest';
import { computeBehindDepth } from './samples.js';

describe('computeBehindDepth', () => {
  it('is zero when the whole queue at attempt start was sent', () => {
    expect(computeBehindDepth(5, 5)).toBe(0);
  });

  it('is the unsent remainder when the batch could not carry everything queued at attempt start', () => {
    expect(computeBehindDepth(80, 60)).toBe(20);
  });

  it('is the full amount queued at attempt start on a failed attempt, which sends nothing', () => {
    expect(computeBehindDepth(12, 0)).toBe(12);
  });

  it('is zero when nothing was queued at attempt start', () => {
    expect(computeBehindDepth(0, 0)).toBe(0);
  });
});
