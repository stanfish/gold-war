import type { Settings } from './types.js';

export const MAP_SIZES = [30, 60] as const;
export const ROUND_SECONDS_OPTIONS = [60, 120, 180] as const;

interface SizeDefaults {
  mineCount: number;
  mineMin: number;
  mineMax: number;
  moveRange: number;
}

export const SIZE_DEFAULTS: Record<number, SizeDefaults> = {
  30: { mineCount: 15, mineMin: 1, mineMax: 60, moveRange: 4 },
  60: { mineCount: 40, mineMin: 1, mineMax: 200, moveRange: 6 },
};

export function defaultSettings(mapSize = 30): Settings {
  const d = SIZE_DEFAULTS[mapSize] ?? SIZE_DEFAULTS[30]!;
  return {
    mapSize,
    mineCount: d.mineCount,
    moveRange: d.moveRange,
    roundSeconds: 120,
    tableTalk: false,
    roundsTotal: 30,
    payoutMin: 2,
    payoutMax: 5,
    startWorkers: 5,
    startGold: 20,
  };
}

/** Returns a list of problems; empty means valid. */
export function validateSettings(s: Settings): string[] {
  const errs: string[] = [];
  const int = (v: number) => Number.isInteger(v);
  if (!int(s.mapSize) || s.mapSize < 5 || s.mapSize > 200) errs.push('mapSize must be an integer 5..200');
  if (!int(s.mineCount) || s.mineCount < 1 || s.mineCount > s.mapSize * s.mapSize - 1)
    errs.push('mineCount must be 1..(squares - 1)');
  if (!int(s.moveRange) || s.moveRange < 1 || s.moveRange >= s.mapSize) errs.push('moveRange must be 1..mapSize-1');
  if (!int(s.roundSeconds) || s.roundSeconds < 5) errs.push('roundSeconds must be >= 5');
  if (!int(s.roundsTotal) || s.roundsTotal < 1) errs.push('roundsTotal must be >= 1');
  if (!int(s.payoutMin) || !int(s.payoutMax) || s.payoutMin < 1 || s.payoutMax < s.payoutMin)
    errs.push('payout range invalid');
  if (!int(s.startWorkers) || s.startWorkers < 1) errs.push('startWorkers must be >= 1');
  if (!(s.startGold > 0) || !int(s.startGold * 2)) errs.push('startGold must be > 0 in 0.5 steps');
  return errs;
}
