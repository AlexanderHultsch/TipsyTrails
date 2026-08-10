// SPEC.md Section 7.3 reveal rule: "reveal every cell whose centre lies
// within FOG_REVEAL_RADIUS_M of the position (~13 cells at 50 m)."

import { CONFIG, cellCenterXY, haversineDistanceM, toCell } from '@tipsytrails/shared';
import type { GridParams, LatLon } from '@tipsytrails/shared';

/**
 * Cell indices (`y * grid_width + x`) whose centre lies within
 * `CONFIG.FOG_REVEAL_RADIUS_M` of `position`. Returns an empty array if
 * `position` itself falls outside the grid — callers are expected to have
 * already rejected such samples (SPEC.md Section 7.2 step 3), this is just
 * a safe default rather than a silent assumption.
 */
export function cellsWithinRevealRadius(position: LatLon, grid: GridParams): number[] {
  const centerIndex = toCell(position.lat, position.lon, grid);
  if (centerIndex === null) {
    return [];
  }

  const cx = centerIndex % grid.grid_width;
  const cy = Math.floor(centerIndex / grid.grid_width);
  const radiusCells = Math.ceil(CONFIG.FOG_REVEAL_RADIUS_M / grid.cell_size_m);

  const minX = Math.max(0, cx - radiusCells);
  const maxX = Math.min(grid.grid_width - 1, cx + radiusCells);
  const minY = Math.max(0, cy - radiusCells);
  const maxY = Math.min(grid.grid_height - 1, cy + radiusCells);

  const indices: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const center = cellCenterXY(x, y, grid);
      if (haversineDistanceM(position, center) <= CONFIG.FOG_REVEAL_RADIUS_M) {
        indices.push(y * grid.grid_width + x);
      }
    }
  }
  return indices;
}
