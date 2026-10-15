import type { Pos } from './types.js';

export const VISION_RADIUS = 2;

export function inBounds(n: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < n && y < n;
}

export function inVision(viewer: Pos, target: Pos): boolean {
  return Math.abs(viewer.x - target.x) <= VISION_RADIUS && Math.abs(viewer.y - target.y) <= VISION_RADIUS;
}

export function seenBy(viewers: Pos[], target: Pos): boolean {
  return viewers.some((v) => inVision(v, target));
}

/** Indices (y*n + x) of all squares visible from the given positions, clipped to the map. */
export function visibleCells(n: number, viewers: Pos[]): Set<number> {
  const out = new Set<number>();
  for (const v of viewers) {
    for (let y = v.y - VISION_RADIUS; y <= v.y + VISION_RADIUS; y++) {
      for (let x = v.x - VISION_RADIUS; x <= v.x + VISION_RADIUS; x++) {
        if (inBounds(n, x, y)) out.add(y * n + x);
      }
    }
  }
  return out;
}
