import { describe, expect, it } from 'vitest';
import {
  boundingTexelRect,
  cellToTexel,
  diffRevealedCells,
  extractTexelRect,
  maskToFogTexels,
  texelToCell,
} from './grid-texture.js';

// A small 4 x 3 grid keeps the expected values easy to check by hand while
// still exercising row/column math (SPEC.md Section 6.1's grid dimensions
// come from GET /api/city; here they stand in for it).
const GRID = { width: 4, height: 3 };

describe('cellToTexel / texelToCell', () => {
  it('matches the grid dimensions from the city (width x height, row-major)', () => {
    expect(cellToTexel(0, GRID)).toEqual({ x: 0, y: 0 });
    expect(cellToTexel(3, GRID)).toEqual({ x: 3, y: 0 });
    expect(cellToTexel(4, GRID)).toEqual({ x: 0, y: 1 });
    expect(cellToTexel(11, GRID)).toEqual({ x: 3, y: 2 });
  });

  it('is the inverse of texelToCell', () => {
    for (let index = 0; index < GRID.width * GRID.height; index++) {
      const { x, y } = cellToTexel(index, GRID);
      expect(texelToCell(x, y, GRID)).toBe(index);
    }
  });
});

describe('maskToFogTexels', () => {
  it('writes 255 (opaque fog) for unrevealed cells and 0 (clear) for revealed ones', () => {
    // Cells 0 and 5 revealed (bits 0 and 5 of the first byte); grid has 12
    // cells -> 2 bytes.
    const mask = new Uint8Array([0b0010_0001, 0b0000_0000]);
    const texels = maskToFogTexels(mask, GRID);
    expect(texels).toHaveLength(12);
    expect(texels[0]).toBe(0);
    expect(texels[5]).toBe(0);
    expect(texels[1]).toBe(255);
    expect(texels[11]).toBe(255);
  });
});

describe('boundingTexelRect', () => {
  it('returns null for no cells', () => {
    expect(boundingTexelRect([], GRID)).toBeNull();
  });

  it('covers exactly the given cells, no more', () => {
    // Cells (1,0) and (2,1) in a 4x3 grid: indices 1 and 6.
    const rect = boundingTexelRect([1, 6], GRID);
    expect(rect).toEqual({ x: 1, y: 0, width: 2, height: 2 });
  });

  it('collapses to a single texel for one cell', () => {
    expect(boundingTexelRect([5], GRID)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });
});

describe('diffRevealedCells', () => {
  it('finds only the cells whose bit flipped', () => {
    const before = new Uint8Array([0b0000_0001, 0b0000_0000]); // cell 0
    const after = new Uint8Array([0b0000_0011, 0b0000_0010]); // cells 0, 1, 9
    expect(diffRevealedCells(before, after, GRID).sort((a, b) => a - b)).toEqual([1, 9]);
  });

  it('is empty for identical masks', () => {
    const mask = new Uint8Array([0b0000_1111, 0b0000_0000]);
    expect(diffRevealedCells(mask, mask, GRID)).toEqual([]);
  });
});

describe('extractTexelRect', () => {
  it('extracts a row-major sub-rectangle matching the rect dimensions', () => {
    // Texel values equal to their cell index, for an easy-to-check pattern.
    const texels = Uint8Array.from({ length: GRID.width * GRID.height }, (_, i) => i);
    const rect = { x: 1, y: 1, width: 2, height: 2 };
    // Rows y=1..2, cols x=1..2 -> cells 5,6 (row 1) and 9,10 (row 2).
    expect(extractTexelRect(texels, GRID, rect)).toEqual(Uint8Array.from([5, 6, 9, 10]));
  });

  it('extracts the whole grid when the rect is the whole grid', () => {
    const texels = Uint8Array.from({ length: GRID.width * GRID.height }, (_, i) => i);
    const rect = { x: 0, y: 0, width: GRID.width, height: GRID.height };
    expect(extractTexelRect(texels, GRID, rect)).toEqual(texels);
  });
});
