import {
  PLAYERS,
  opponentOf,
  type ActionType,
  type GameResult,
  type GameState,
  type PlayerId,
  type ResolvedAction,
  type RoundEvent,
  type Submission,
  type SubmittedAction,
  type Worker,
} from './types.js';
import { inBounds, seenBy, visibleCells } from './vision.js';

/**
 * Bump whenever action validation or resolution rules change. Clients compare it with the server's
 * so a stale server never silently rejects moves the UI allowed.
 */
export const RULES_VERSION = 4;

/**
 * Why a MOVE by (dx, dy) is illegal, or null if it is legal. Shared by the engine and the player UI.
 * Steps are orthogonal but may combine directions: any destination within Manhattan distance moveRange.
 */
export function moveError(worker: { x: number; y: number }, dx: number, dy: number, mapSize: number, moveRange: number): string | null {
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) return 'MOVE offsets must be integers';
  if (dx === 0 && dy === 0) return 'MOVE must go somewhere';
  const dist = Math.abs(dx) + Math.abs(dy);
  if (dist > moveRange) return `MOVE distance ${dist} exceeds range ${moveRange}`;
  if (!inBounds(mapSize, worker.x + dx, worker.y + dy)) return 'MOVE leaves the map';
  return null;
}

/** Cost of each action in half-gold units. */
export const COST2: Record<ActionType, number> = { MOVE: 2, COLLECT: 2, STAY: 1, DELETE: 0 };

export function workerOrder(id: string): number {
  const n = parseInt(id.replace(/\D/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Validate one submitted action for a worker. Returns the resolved action or an error string.
 * Invalid actions are turned into STAY by the caller (spec §15), before affordability is checked.
 */
export function validateAction(state: GameState, player: PlayerId, worker: Worker, a: SubmittedAction): ResolvedAction | string {
  const n = state.settings.mapSize;
  switch (String(a.action).toUpperCase()) {
    case 'STAY':
      return { type: 'STAY' };
    case 'DELETE':
      return { type: 'DELETE' };
    case 'MOVE': {
      let dx: number;
      let dy: number;
      if (a.dx !== undefined || a.dy !== undefined) {
        dx = a.dx ?? 0;
        dy = a.dy ?? 0;
      } else if (a.x !== undefined && a.y !== undefined) {
        dx = a.x - worker.x;
        dy = a.y - worker.y;
      } else {
        return 'MOVE needs dx/dy or x/y';
      }
      return moveError(worker, dx, dy, n, state.settings.moveRange) ?? { type: 'MOVE', dx, dy };
    }
    case 'COLLECT': {
      const id = a.mine_id;
      if (!id) return 'COLLECT needs mine_id';
      const found = state.players[player].knownMines[id];
      if (found === undefined) return `mine ${id} is not known`;
      if (found >= state.round) return `mine ${id} was discovered this round`;
      return { type: 'COLLECT', mineId: id };
    }
    default:
      return `unknown action ${a.action}`;
  }
}

/**
 * Recompute a player's vision: mark explored squares, discover mines, record enemy sightings.
 * Mutates state. `round` is the round number to stamp on discoveries (0 = setup).
 */
export function updateVision(state: GameState, player: PlayerId, round: number, events: RoundEvent[]): void {
  const ps = state.players[player];
  const n = state.settings.mapSize;
  for (const cell of visibleCells(n, ps.workers)) ps.explored[cell] = 1;
  for (const m of state.mines) {
    if (ps.knownMines[m.id] === undefined && seenBy(ps.workers, m)) {
      ps.knownMines[m.id] = round;
      if (round > 0) events.push({ type: 'discover', player, mineId: m.id });
    }
  }
  const enemies = state.players[opponentOf(player)].workers.filter((w) => seenBy(ps.workers, w));
  if (enemies.length) ps.enemySightings = enemies.map((w) => ({ x: w.x, y: w.y, round }));
}

function compareGold(state: GameState, reasonPrefix: string): GameResult {
  const a = state.players.p1.gold2;
  const b = state.players.p2.gold2;
  if (a === b) return { winner: null, reason: `${reasonPrefix}: equal gold` };
  return { winner: a > b ? 'p1' : 'p2', reason: `${reasonPrefix}: more gold` };
}

/** Elimination check (spec §15). */
export function checkEnd(state: GameState): GameResult | null {
  const gold0 = (p: PlayerId) => state.players[p].gold2 <= 0;
  const workers0 = (p: PlayerId) => state.players[p].workers.length === 0;

  if (gold0('p1') && gold0('p2')) return { winner: null, reason: 'both players ran out of gold' };
  if (workers0('p1') && workers0('p2')) return compareGold(state, 'both players have no workers');

  const losers = PLAYERS.filter((p) => gold0(p) || workers0(p));
  if (losers.length === 2) return { winner: null, reason: 'both players eliminated' };
  if (losers.length === 1) {
    const loser = losers[0]!;
    return { winner: opponentOf(loser), reason: gold0(loser) ? `${loser} ran out of gold` : `${loser} has no workers` };
  }
  if (state.round >= state.settings.roundsTotal) return compareGold(state, `after round ${state.round}`);
  return null;
}

/**
 * Resolve one simultaneous round. Pure: returns a new state, never mutates the input.
 * Missing submissions / workers without an action default to STAY (or DELETE if unaffordable).
 */
export function resolveRound(
  prev: GameState,
  submissions: Partial<Record<PlayerId, Submission>>,
): { state: GameState; events: RoundEvent[] } {
  if (prev.status !== 'active') throw new Error('game is finished');
  const state: GameState = structuredClone(prev);
  const events: RoundEvent[] = [];
  const round = state.round;

  // 1. Assign + validate one action per worker. Missing/invalid -> STAY.
  const plan: Record<PlayerId, Map<string, ResolvedAction>> = { p1: new Map(), p2: new Map() };
  for (const p of PLAYERS) {
    const submitted = new Map<string, SubmittedAction>();
    for (const a of submissions[p]?.actions ?? []) {
      if (a && typeof a.worker_id === 'string' && !submitted.has(a.worker_id)) submitted.set(a.worker_id, a);
    }
    for (const w of state.players[p].workers) {
      const a = submitted.get(w.id);
      if (!a) {
        events.push({ type: 'missing', player: p, workerId: w.id });
        plan[p].set(w.id, { type: 'STAY' });
        continue;
      }
      const r = validateAction(state, p, w, a);
      if (typeof r === 'string') {
        events.push({ type: 'invalid', player: p, workerId: w.id, reason: r });
        plan[p].set(w.id, { type: 'STAY' });
      } else {
        plan[p].set(w.id, r);
      }
    }
  }

  // 2. Affordability: highest worker id first, MOVE/COLLECT -> STAY, then STAY -> DELETE.
  // 3. Deduct costs.
  for (const p of PLAYERS) {
    const ps = state.players[p];
    const actions = plan[p];
    const total = () => [...actions.values()].reduce((s, a) => s + COST2[a.type], 0);
    const byIdDesc = [...ps.workers].sort((a, b) => workerOrder(b.id) - workerOrder(a.id));
    for (const [from, to] of [
      [['MOVE', 'COLLECT'], 'STAY'],
      [['STAY'], 'DELETE'],
    ] as const) {
      for (const w of byIdDesc) {
        if (total() <= ps.gold2) break;
        const a = actions.get(w.id)!;
        if ((from as readonly string[]).includes(a.type)) {
          actions.set(w.id, { type: to } as ResolvedAction);
          events.push({ type: 'downgrade', player: p, workerId: w.id, from: a.type, to });
        }
      }
    }
    const cost = total();
    ps.gold2 -= cost;
    events.push({ type: 'cost', player: p, amount: cost / 2 });
  }

  // 4. Moves.
  for (const p of PLAYERS) {
    for (const w of state.players[p].workers) {
      const a = plan[p].get(w.id)!;
      if (a.type !== 'MOVE') continue;
      const from = { x: w.x, y: w.y };
      w.x += a.dx;
      w.y += a.dy;
      events.push({ type: 'move', player: p, workerId: w.id, from, to: { x: w.x, y: w.y } });
    }
  }

  // 5. Collects: per mine, majority takes all, tie splits. Collectors return to base.
  const collectors = new Map<string, Record<PlayerId, number>>();
  for (const p of PLAYERS) {
    for (const w of state.players[p].workers) {
      const a = plan[p].get(w.id)!;
      if (a.type !== 'COLLECT') continue;
      const c = collectors.get(a.mineId) ?? { p1: 0, p2: 0 };
      c[p]++;
      collectors.set(a.mineId, c);
      w.x = state.base.x;
      w.y = state.base.y;
    }
  }
  for (const mine of state.mines) {
    const c = collectors.get(mine.id);
    if (!c) continue;
    const gained2: Record<PlayerId, number> = { p1: 0, p2: 0 };
    const pay2 = mine.payout * 2;
    if (c.p1 > c.p2) gained2.p1 = pay2;
    else if (c.p2 > c.p1) gained2.p2 = pay2;
    else {
      gained2.p1 = pay2 / 2;
      gained2.p2 = pay2 / 2;
    }
    for (const p of PLAYERS) state.players[p].gold2 += gained2[p];
    events.push({
      type: 'collect',
      mineId: mine.id,
      payout: mine.payout,
      workers: { ...c },
      gained: { p1: gained2.p1 / 2, p2: gained2.p2 / 2 },
    });
  }

  for (const p of PLAYERS) {
    const amount = events.reduce((s, e) => s + (e.type === 'collect' ? e.gained[p] : 0), 0);
    events.push({ type: 'income', player: p, amount });
  }

  // 6. Deletes.
  for (const p of PLAYERS) {
    const ps = state.players[p];
    ps.workers = ps.workers.filter((w) => {
      if (plan[p].get(w.id)!.type !== 'DELETE') return true;
      events.push({ type: 'delete', player: p, workerId: w.id });
      return false;
    });
  }

  // 7. Vision.
  for (const p of PLAYERS) updateVision(state, p, round, events);

  // 8-9. Elimination / final round.
  const result = checkEnd(state);
  if (result) {
    state.status = 'finished';
    state.result = result;
    events.push({ type: 'end', result });
  } else {
    state.round = round + 1;
  }
  return { state, events };
}
