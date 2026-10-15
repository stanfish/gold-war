import { createRng } from './rng.js';
import type { SubmittedAction } from './types.js';
import type { AiState } from './view.js';

export interface BotDecision {
  actions: SubmittedAction[];
  notes: string;
  thinking: string;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Simple scripted opponent: collect from the best collectable mines (one worker each),
 * send the rest exploring in spread-out directions, never overspend.
 */
export function scriptedBot(view: AiState, seed = 1): BotDecision {
  const rng = createRng(seed * 7919 + view.round * 31 + (view.you === 'p1' ? 1 : 2));
  const actions: SubmittedAction[] = [];
  const reasons: string[] = [];
  let budget2 = Math.round(view.gold * 2);
  const roundsLeft = view.rounds_total - view.round + 1;

  const mines = view.known_mines.filter((m) => m.collectable).sort((a, b) => b.payout - a.payout);
  const workers = [...view.workers];
  let mineIdx = 0;

  for (const [i, w] of workers.entries()) {
    const keepReserve2 = (workers.length - i - 1) * 1; // leave enough for others to at least STAY
    const mine = mines[mineIdx];
    if (mine && budget2 - 2 >= keepReserve2) {
      actions.push({ worker_id: w.id, action: 'COLLECT', mine_id: mine.id });
      reasons.push(`${w.id}: collect ${mine.id} (+${mine.payout})`);
      mineIdx++;
      budget2 -= 2;
      continue;
    }
    // Explore while there is time to profit from it and money to spare.
    if (roundsLeft > 3 && budget2 - 2 >= keepReserve2 && budget2 > 8) {
      const n = view.settings.map_size;
      const range = view.settings.move_range;
      const start = (workerIdx(w.id) + Math.floor(rng() * 4)) % 4;
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[(start + k) % 4]!;
        const dist = Math.min(range, dx > 0 ? n - 1 - w.x : dx < 0 ? w.x : dy > 0 ? n - 1 - w.y : w.y);
        if (dist >= 1) {
          actions.push({ worker_id: w.id, action: 'MOVE', dx: dx * dist, dy: dy * dist });
          reasons.push(`${w.id}: explore (${dx * dist},${dy * dist})`);
          budget2 -= 2;
          break;
        }
      }
      if (actions.at(-1)?.worker_id === w.id) continue;
    }
    if (budget2 - 1 >= keepReserve2 && budget2 > 1) {
      actions.push({ worker_id: w.id, action: 'STAY' });
      reasons.push(`${w.id}: stay`);
      budget2 -= 1;
    } else {
      actions.push({ worker_id: w.id, action: 'DELETE' });
      reasons.push(`${w.id}: delete (cannot afford)`);
    }
  }
  return { actions, notes: `known mines: ${view.known_mines.map((m) => m.id).join(',')}`, thinking: reasons.join('\n') };
}

function workerIdx(id: string): number {
  return parseInt(id.replace(/\D/g, ''), 10) || 0;
}
