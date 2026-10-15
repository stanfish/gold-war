import { createRng, randInt } from './rng.js';
import { validateSettings } from './settings.js';
import { PLAYERS, type GameState, type Mine, type PlayerId, type PlayerState, type Settings } from './types.js';
import { updateVision } from './resolve.js';

export function createGame(settings: Settings, seed: number): GameState {
  const errs = validateSettings(settings);
  if (errs.length) throw new Error(`Invalid settings: ${errs.join('; ')}`);

  const n = settings.mapSize;
  const base = { x: Math.floor(n / 2), y: Math.floor(n / 2) };
  const rng = createRng(seed);

  // Pick distinct squares (never the base) via partial Fisher-Yates over all other cells.
  const cells: number[] = [];
  for (let i = 0; i < n * n; i++) if (i !== base.y * n + base.x) cells.push(i);
  const mines: Mine[] = [];
  for (let i = 0; i < settings.mineCount; i++) {
    const j = i + Math.floor(rng() * (cells.length - i));
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    const cell = cells[i]!;
    mines.push({
      id: `m${i + 1}`,
      x: cell % n,
      y: Math.floor(cell / n),
      payout: randInt(rng, settings.payoutMin, settings.payoutMax),
    });
  }

  const makePlayer = (id: PlayerId): PlayerState => ({
    id,
    gold2: Math.round(settings.startGold * 2),
    workers: Array.from({ length: settings.startWorkers }, (_, i) => ({ id: `w${i + 1}`, x: base.x, y: base.y })),
    explored: new Array(n * n).fill(0),
    knownMines: {},
    enemySightings: [],
  });

  const state: GameState = {
    settings: { ...settings },
    seed,
    round: 1,
    base,
    mines,
    players: { p1: makePlayer('p1'), p2: makePlayer('p2') },
    status: 'active',
    result: null,
  };
  for (const p of PLAYERS) updateVision(state, p, 0, []);
  return state;
}
