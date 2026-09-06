import { describe, expect, it } from 'vitest';
import { computeBehindDepth } from './tracking.js';

// SPEC.md Section 8.6's "behind". The two call shapes are the whole surface -
// a success passes the batch it sent, a failure passes nothing - so they are
// what is asserted here, plus the boundary between them: the attempt that
// carried away exactly what was queued.
describe('computeBehindDepth', () => {
  // The success shape, and the reason the rule exists: a queue larger than
  // SAMPLE_MAX_BATCH leaves a remainder the cycle went without.
  it('is the unsent remainder when one batch could not carry everything queued at attempt start', () => {
    expect(computeBehindDepth(80, 60)).toBe(20);
  });

  // The failure shape. A failed post removes nothing, so everything that was
  // queued when the attempt began has now failed a send.
  it('is everything queued at attempt start when the attempt sent nothing', () => {
    expect(computeBehindDepth(12, 0)).toBe(12);
  });

  // The boundary, and the normal case on a healthy phone: the batch carried
  // the whole queue, so nothing is behind and the icon goes back to `online`.
  it('is zero when the batch sent exactly what was queued at attempt start', () => {
    expect(computeBehindDepth(5, 5)).toBe(0);
  });

  // flush() returns before it posts on an empty queue, so this pair never
  // reaches the function in either client - asserted anyway because zero is
  // the value the connection status treats as healthy, and a rule that did
  // not hold here would be one that reported a device with nothing to send as
  // behind.
  it('is zero when nothing was queued at attempt start', () => {
    expect(computeBehindDepth(0, 0)).toBe(0);
  });

  // The sign, stated on its own. `computeConnectionStatus` reads
  // `behindDepth > 0`, so an inverted subtraction is not an off-by-one - it is
  // `syncing` on every healthy phone and `online` on every backlogged one.
  it('subtracts what was sent from what was queued, and never the other way round', () => {
    expect(computeBehindDepth(3, 1)).toBeGreaterThan(0);
    expect(computeBehindDepth(1, 3)).toBeLessThan(0);
  });
});
