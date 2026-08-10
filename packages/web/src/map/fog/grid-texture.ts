// Cell <-> texel mapping and mask diffing for the fog texture (SPEC.md
// Section 7.3): "the mask is uploaded to the GPU as a texture (one texel
// per grid cell, R8 format) ... reveals update the texture via
// texSubImage2D on the affected region only." Pure, GL-free, so it is
// unit-testable without a GPU (jsdom has none) - see grid-texture.test.ts.

import { isRevealed } from './mask.js';

export interface GridSize {
  width: number;
  height: number;
}

/**
 * Texel coordinates for a cell, following the same `index = y * width + x`
 * layout as the mask (Section 5.2/6.1) and `packages/api/src/fog/mask.ts`.
 * Row `y = 0` is the grid's southern edge (the city origin), which is what
 * ends up at texture `v = 0` for an un-flipped `texImage2D` upload - see
 * webgl-fog-layer.ts's vertex/UV setup.
 */
export function cellToTexel(cellIndex: number, grid: GridSize): { x: number; y: number } {
  return { x: cellIndex % grid.width, y: Math.floor(cellIndex / grid.width) };
}

export function texelToCell(x: number, y: number, grid: GridSize): number {
  return y * grid.width + x;
}

/** One R8 texel per cell: 255 = opaque fog (unrevealed), 0 = fully clear. */
export function maskToFogTexels(mask: Uint8Array, grid: GridSize): Uint8Array {
  const total = grid.width * grid.height;
  const texels = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    texels[i] = isRevealed(mask, i) ? 0 : 255;
  }
  return texels;
}

export interface TexelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest axis-aligned texel rectangle covering every given cell index. */
export function boundingTexelRect(cellIndices: Iterable<number>, grid: GridSize): TexelRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const index of cellIndices) {
    any = true;
    const { x, y } = cellToTexel(index, grid);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!any) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Cell indices whose revealed bit differs between two same-shaped masks. */
export function diffRevealedCells(
  previous: Uint8Array,
  next: Uint8Array,
  grid: GridSize,
): number[] {
  const total = grid.width * grid.height;
  const changed: number[] = [];
  for (let i = 0; i < total; i++) {
    if (isRevealed(previous, i) !== isRevealed(next, i)) {
      changed.push(i);
    }
  }
  return changed;
}

/**
 * Row-major sub-array of `texels` covering `rect`, ready for
 * `texSubImage2D(..., rect.x, rect.y, rect.width, rect.height, ...)`.
 */
export function extractTexelRect(texels: Uint8Array, grid: GridSize, rect: TexelRect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const srcStart = (rect.y + row) * grid.width + rect.x;
    out.set(texels.subarray(srcStart, srcStart + rect.width), row * rect.width);
  }
  return out;
}
