// Bitmask helpers for `fog_state.mask` (SPEC.md Section 5.5): one bit per
// grid cell, `ceil(grid_width * grid_height / 8)` bytes.

/** Number of bytes needed to hold one bit per cell of a `grid_width x grid_height` grid. */
export function maskByteLength(grid: { grid_width: number; grid_height: number }): number {
  return Math.ceil((grid.grid_width * grid.grid_height) / 8);
}

export function isBitSet(mask: Buffer, cellIndex: number): boolean {
  return (mask[cellIndex >> 3] & (1 << (cellIndex & 7))) !== 0;
}

/** Sets the bit for `cellIndex`. Idempotent — setting an already-set bit is a no-op. */
export function setBit(mask: Buffer, cellIndex: number): void {
  mask[cellIndex >> 3] |= 1 << (cellIndex & 7);
}
