import type { Pos } from './types.js';

/** Default vision radius: a worker sees a (2r+1)x(2r+1) square centered on itself. */
export const DEFAULT_VISION_RADIUS = 2;

export function inBounds(n: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < n && y < n;
}

export function inVision(viewer: Pos, target: Pos, radius: number): boolean {
  return Math.abs(viewer.x - target.x) <= radius && Math.abs(viewer.y - target.y) <= radius;
}

export function seenBy(viewers: Pos[], target: Pos, radius: number): boolean {
  return viewers.some((v) => inVision(v, target, radius));
}

/** Indices (y*n + x) of all squares visible from the given positions, clipped to the map. */
export function visibleCells(n: number, viewers: Pos[], radius: number): Set<number> {
  const out = new Set<number>();
  for (const v of viewers) {
    for (let y = v.y - radius; y <= v.y + radius; y++) {
      for (let x = v.x - radius; x <= v.x + radius; x++) {
        if (inBounds(n, x, y)) out.add(y * n + x);
      }
    }
  }
  return out;
}
