// Bit accessor for the raw fog mask `GET /api/fog` sends as its
// `application/octet-stream` body (SPEC.md Section 5.5/9.2). One bit per
// grid cell, `cellIndex = y * grid_width + x` (Section 5.2 / 6.1), packed
// LSB-first within each byte - mirrors `packages/api/src/fog/mask.ts`
// exactly (`mask[cellIndex >> 3] & (1 << (cellIndex & 7))`), reimplemented
// here rather than imported because the API package is not a dependency of
// the web client.

/** True when the bit for `cellIndex` is set in a bit-packed mask. */
export function isRevealed(mask: Uint8Array, cellIndex: number): boolean {
  return (mask[cellIndex >> 3] & (1 << (cellIndex & 7))) !== 0;
}

/** Bytes needed to hold one bit per cell of a `width x height` grid. */
export function maskByteLength(width: number, height: number): number {
  return Math.ceil((width * height) / 8);
}
