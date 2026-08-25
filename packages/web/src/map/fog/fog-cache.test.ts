import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CityMeta, FogMaskResponse } from '../../api/types.js';
import { clearFogState, loadFogState, saveFogState } from './fog-cache.js';

// Phase 8 task brief, part B: proves the round trip fog-cache.ts exists
// for (map/fog/useFogLayer.ts's own offline fallback) and its fail-open
// behaviour when storage is unusable, the same posture
// tracking/masteringExplainer.ts already established for this codebase's
// other localStorage-backed feature. Reviewer finding on the first pass:
// unlike that flag, this cache holds one person's walking history, so it
// is keyed per user id - the tests below prove the isolation directly
// (one user's saved mask is not returned for another) and that logout's
// clearFogState only removes the signed-out user's own entry.

function city(overrides: Partial<CityMeta> = {}): CityMeta {
  return {
    slug: 'karlsruhe',
    name: 'Karlsruhe',
    originLat: 48.94,
    originLon: 8.275,
    gridWidth: 3,
    gridHeight: 3,
    cellSizeM: 50,
    playableCells: 9,
    districts: [],
    ...overrides,
  };
}

function fog(mask: Uint8Array): FogMaskResponse {
  return { mask, progress: { revealedCells: 0, playableCells: 9, districts: [] } };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('loadFogState', () => {
  it('returns null when nothing has been saved yet for this user', () => {
    expect(loadFogState(1)).toBeNull();
  });

  it('round-trips the grid parameters and mask bytes exactly, including a byte with every bit set', () => {
    const mask = new Uint8Array([0b0000_0101, 0xff]);
    saveFogState(1, city(), fog(mask));

    const cached = loadFogState(1);
    expect(cached).not.toBeNull();
    expect(cached?.gridWidth).toBe(3);
    expect(cached?.gridHeight).toBe(3);
    expect(cached?.cellSizeM).toBe(50);
    expect(cached?.originLat).toBe(48.94);
    expect(cached?.originLon).toBe(8.275);
    expect(Array.from(cached?.mask ?? [])).toEqual([0b0000_0101, 0xff]);
  });

  it('reflects the most recently saved state for that user, not the first', () => {
    saveFogState(1, city(), fog(new Uint8Array([0x00])));
    saveFogState(1, city({ gridWidth: 5 }), fog(new Uint8Array([0xff])));

    const cached = loadFogState(1);
    expect(cached?.gridWidth).toBe(5);
    expect(Array.from(cached?.mask ?? [])).toEqual([0xff]);
  });

  it('never returns a mask saved under a different user id (the shared-device leak the reviewer flagged)', () => {
    saveFogState(1, city(), fog(new Uint8Array([0xff])));

    expect(loadFogState(2)).toBeNull();
  });

  it('keeps two users fully independent when both have saved a mask', () => {
    saveFogState(1, city({ gridWidth: 3 }), fog(new Uint8Array([0b0000_0001])));
    saveFogState(2, city({ gridWidth: 7 }), fog(new Uint8Array([0b0000_0010])));

    expect(loadFogState(1)?.gridWidth).toBe(3);
    expect(Array.from(loadFogState(1)?.mask ?? [])).toEqual([0b0000_0001]);
    expect(loadFogState(2)?.gridWidth).toBe(7);
    expect(Array.from(loadFogState(2)?.mask ?? [])).toEqual([0b0000_0010]);
  });

  it('fails open to null on corrupt stored JSON rather than throwing', () => {
    window.localStorage.setItem('tipsytrails:fog-cache:1', 'not json');
    expect(loadFogState(1)).toBeNull();
  });

  // Review block R2 (boundaries). The suite above already proved malformed
  // JSON is handled; these are the case it did not cover - JSON that parses
  // perfectly and simply is not this shape, which is what an entry written by
  // an older release of this app looks like.
  //
  // These three are the ones the shape check actually earns its place on, and
  // the split from the group below is deliberate rather than tidy. Each has a
  // *valid base64 mask*, so `atob` succeeds and nothing throws: before the
  // check, every one of them was read back as `undefined` or a string typed
  // `number` and handed straight to the fog renderer. Removing the check
  // fails exactly these three.
  it.each([
    [
      'a missing gridWidth',
      { gridHeight: 3, cellSizeM: 50, originLat: 1, originLon: 2, mask: 'AA==' },
    ],
    [
      'a gridWidth stored as a string',
      { gridWidth: '3', gridHeight: 3, cellSizeM: 50, originLat: 1, originLon: 2, mask: 'AA==' },
    ],
    [
      'a null originLat (what JSON.stringify writes for a NaN)',
      { gridWidth: 3, gridHeight: 3, cellSizeM: 50, originLat: null, originLon: 2, mask: 'AA==' },
    ],
  ])('drops the cache rather than returning type-confused data for %s', (_label, stored) => {
    window.localStorage.setItem('tipsytrails:fog-cache:1', JSON.stringify(stored));
    expect(loadFogState(1)).toBeNull();
  });

  // These four already failed safe before the shape check existed, because
  // `atob` throws on what they leave in `mask` and the try/catch turns that
  // into null. They are kept as regression guards for that fail-open path -
  // not as evidence for the check above, which they would pass without.
  it.each([
    [
      'a mask that is not a string',
      { gridWidth: 3, gridHeight: 3, cellSizeM: 50, originLat: 1, originLon: 2, mask: [0, 255] },
    ],
    ['a JSON array rather than an object', [1, 2, 3]],
    ['a JSON number rather than an object', 7],
    ['a JSON null', null],
  ])('also returns null for %s', (_label, stored) => {
    window.localStorage.setItem('tipsytrails:fog-cache:1', JSON.stringify(stored));
    expect(loadFogState(1)).toBeNull();
  });

  // The complement of the cases above: a shape check that also rejected good
  // entries would silently disable the offline fog for everyone, and no test
  // that only feeds it bad input could tell the difference.
  it('still accepts every value saveFogState itself writes, including zeroes and negatives', () => {
    saveFogState(1, city({ originLat: 0, originLon: -8.275, gridWidth: 1 }), fog(new Uint8Array()));
    const cached = loadFogState(1);
    expect(cached?.originLat).toBe(0);
    expect(cached?.originLon).toBe(-8.275);
    expect(Array.from(cached?.mask ?? [])).toEqual([]);
  });

  it('fails open rather than throwing when localStorage.getItem itself throws', () => {
    const original = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(loadFogState(1)).toBeNull();
    } finally {
      window.localStorage.getItem = original;
    }
  });
});

describe('saveFogState', () => {
  it('does not throw when localStorage.setItem itself throws', () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(() => saveFogState(1, city(), fog(new Uint8Array([0x01])))).not.toThrow();
    } finally {
      window.localStorage.setItem = original;
    }
  });
});

describe('clearFogState', () => {
  it('removes the given user’s cached mask, called on logout (auth/useLogout.ts)', () => {
    saveFogState(1, city(), fog(new Uint8Array([0xff])));
    expect(loadFogState(1)).not.toBeNull();

    clearFogState(1);

    expect(loadFogState(1)).toBeNull();
  });

  it('leaves a different user’s cached mask untouched', () => {
    saveFogState(1, city(), fog(new Uint8Array([0xff])));
    saveFogState(2, city(), fog(new Uint8Array([0x0f])));

    clearFogState(1);

    expect(loadFogState(1)).toBeNull();
    expect(loadFogState(2)).not.toBeNull();
  });

  it('does not throw when nothing was ever saved for that user', () => {
    expect(() => clearFogState(99)).not.toThrow();
  });

  it('does not throw when localStorage.removeItem itself throws', () => {
    const original = window.localStorage.removeItem;
    window.localStorage.removeItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(() => clearFogState(1)).not.toThrow();
    } finally {
      window.localStorage.removeItem = original;
    }
  });
});
