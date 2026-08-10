import { describe, expect, it } from 'vitest';
import { isRevealed, maskByteLength } from './mask.js';

describe('isRevealed', () => {
  it('reads exactly the bits set in a known byte pattern, LSB-first', () => {
    // 0b00000101 -> cells 0 and 2 revealed, 1 and 3-7 not.
    const mask = new Uint8Array([0b0000_0101]);
    expect(isRevealed(mask, 0)).toBe(true);
    expect(isRevealed(mask, 1)).toBe(false);
    expect(isRevealed(mask, 2)).toBe(true);
    expect(isRevealed(mask, 3)).toBe(false);
    expect(isRevealed(mask, 7)).toBe(false);
  });

  it('reads bits from the correct byte once the index crosses a byte boundary', () => {
    // Cell 8 is the first bit of the second byte.
    const mask = new Uint8Array([0b0000_0000, 0b0000_0001]);
    expect(isRevealed(mask, 7)).toBe(false);
    expect(isRevealed(mask, 8)).toBe(true);
  });

  it('treats every bit of 0xff as revealed', () => {
    const mask = new Uint8Array([0xff]);
    for (let i = 0; i < 8; i++) {
      expect(isRevealed(mask, i)).toBe(true);
    }
  });
});

describe('maskByteLength', () => {
  it('rounds up to a whole byte', () => {
    expect(maskByteLength(3, 3)).toBe(2); // 9 cells -> 2 bytes
    expect(maskByteLength(4, 2)).toBe(1); // 8 cells -> 1 byte, exact
  });

  it('matches the Karlsruhe grid from SPEC.md Section 6.2 (417 x 343 -> ~17.5 KiB)', () => {
    expect(maskByteLength(417, 343)).toBe(17879);
  });
});
