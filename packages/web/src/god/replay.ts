import { PLAYERS, type GodUpdate, type Mine, type PlayerId, type Pos, type RoundEvent, type Snapshot } from '@gold-war/engine';

export type History = GodUpdate['history'];

/** Board before `round` resolved (round 1 → start). */
export function snapshotBefore(msg: GodUpdate, round: number): Snapshot {
  return round <= 1 ? msg.start : (msg.history[round - 2]?.snapshot ?? msg.start);
}

/** Board after `round` resolved (0 → start). */
export function snapshotAfter(msg: GodUpdate, round: number): Snapshot {
  return round <= 0 ? msg.start : (msg.history[round - 1]?.snapshot ?? msg.start);
}

// Animation phases, as fractions of one round's playback.
export const PHASE = {
  move: [0, 0.4],
  dashOut: [0.4, 0.55],
  atMine: [0.55, 0.6],
  dashBack: [0.6, 0.75],
  coins: [0.58, 0.82],
  float: [0.55, 1],
  spark: [0.53, 0.72],
  del: [0.75, 0.95],
  discover: [0.8, 1],
  invalid: [0, 0.4],
} as const;
export const ROUND_MS = 2800;

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const phaseT = (t: number, [a, b]: readonly [number, number]) => clamp01((t - a) / (b - a));
export const ease = (u: number) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/** Point along an orthogonal walk: x steps first, then y (moves are orthogonal steps). */
export function walk(from: Pos, to: Pos, u: number): Pos {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.abs(dx) + Math.abs(dy);
  if (!steps) return { ...from };
  const s = u * steps;
  if (s <= Math.abs(dx)) return { x: from.x + Math.sign(dx) * s, y: from.y };
  return { x: to.x, y: from.y + Math.sign(dy) * (s - Math.abs(dx)) };
}

const lerp = (a: Pos, b: Pos, u: number): Pos => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });

export interface AnimWorker {
  key: string;
  player: PlayerId;
  id: string;
  pos: Pos;
  alpha: number;
  /** Red ✕ over the worker (invalid or unaffordable order). */
  flagged: boolean;
}

/** One round's resolution, precomputed so a frame at time t is cheap. */
export interface Transition {
  round: number;
  before: Snapshot;
  after: Snapshot;
  events: RoundEvent[];
  moves: Map<string, { from: Pos; to: Pos }>;
  collects: Map<string, { mine: Pos }>;
  deletes: Set<string>;
  flagged: Set<string>;
}

const wkey = (p: PlayerId, id: string) => `${p}:${id}`;

export function buildTransition(msg: GodUpdate, round: number): Transition | null {
  const rec = msg.history[round - 1];
  if (!rec) return null;
  const mines = new Map(msg.state.mines.map((m) => [m.id, m]));
  const t: Transition = {
    round,
    before: snapshotBefore(msg, round),
    after: rec.snapshot,
    events: rec.events,
    moves: new Map(),
    collects: new Map(),
    deletes: new Set(),
    flagged: new Set(),
  };
  for (const e of rec.events) {
    if (e.type === 'move') t.moves.set(wkey(e.player, e.workerId), { from: e.from, to: e.to });
    else if (e.type === 'delete') t.deletes.add(wkey(e.player, e.workerId));
    else if (e.type === 'invalid' || e.type === 'downgrade') t.flagged.add(wkey(e.player, e.workerId));
    else if (e.type === 'collect' && e.collectors) {
      const m = mines.get(e.mineId);
      if (m) for (const p of PLAYERS) for (const id of e.collectors[p]) t.collects.set(wkey(p, id), { mine: m });
    }
  }
  return t;
}

/** Worker positions at time t (0..1) of a transition; null transition = static snapshot. */
export function workersAt(snap: Snapshot, tr: Transition | null, t: number, base: Pos): AnimWorker[] {
  if (!tr) {
    return PLAYERS.flatMap((p) =>
      snap.players[p].workers.map((w) => ({ key: wkey(p, w.id), player: p, id: w.id, pos: { x: w.x, y: w.y }, alpha: 1, flagged: false })),
    );
  }
  return PLAYERS.flatMap((p) =>
    tr.before.players[p].workers.map((w) => {
      const key = wkey(p, w.id);
      let pos: Pos = { x: w.x, y: w.y };
      let alpha = 1;
      const mv = tr.moves.get(key);
      const col = tr.collects.get(key);
      if (mv) pos = walk(mv.from, mv.to, ease(phaseT(t, PHASE.move)));
      if (col) {
        if (t < PHASE.atMine[0]) pos = lerp(pos, col.mine, ease(phaseT(t, PHASE.dashOut)));
        else if (t < PHASE.dashBack[0]) pos = { x: col.mine.x, y: col.mine.y };
        else pos = lerp(col.mine, base, ease(phaseT(t, PHASE.dashBack)));
      }
      if (tr.deletes.has(key)) alpha = 1 - phaseT(t, PHASE.del);
      const flagged = tr.flagged.has(key) && t < PHASE.invalid[1];
      return { key, player: p, id: w.id, pos, alpha, flagged };
    }),
  ).filter((w) => w.alpha > 0.01);
}

/** Known-mine sets to draw at time t: discoveries appear when their ping starts. */
export function knownAt(snap: Snapshot, tr: Transition | null, t: number): Record<PlayerId, Set<string>> {
  const s = tr && t < PHASE.discover[0] ? tr.before : snap;
  return { p1: new Set(s.players.p1.knownMines), p2: new Set(s.players.p2.knownMines) };
}

/** Move paths of recent rounds (for fading trails), newest last. */
export function trails(msg: GodUpdate, upTo: number, depth = 3): { player: PlayerId; from: Pos; to: Pos; age: number }[] {
  const out: { player: PlayerId; from: Pos; to: Pos; age: number }[] = [];
  for (let r = Math.max(1, upTo - depth + 1); r <= upTo; r++) {
    for (const e of msg.history[r - 1]?.events ?? []) if (e.type === 'move') out.push({ player: e.player, from: e.from, to: e.to, age: upTo - r });
  }
  return out;
}

export interface PlayerStats {
  minesFound: number;
  goldMined: number;
  contestsWon: number;
  contestsLost: number;
  workersLost: number;
  bestMine: { id: string; gold: number } | null;
}

export function gameStats(msg: GodUpdate): Record<PlayerId, PlayerStats> {
  const blank = (): PlayerStats => ({ minesFound: 0, goldMined: 0, contestsWon: 0, contestsLost: 0, workersLost: 0, bestMine: null });
  const st: Record<PlayerId, PlayerStats> = { p1: blank(), p2: blank() };
  const perMine: Record<PlayerId, Map<string, number>> = { p1: new Map(), p2: new Map() };
  for (const h of msg.history) {
    for (const e of h.events) {
      if (e.type === 'discover') st[e.player].minesFound++;
      else if (e.type === 'delete') st[e.player].workersLost++;
      else if (e.type === 'collect') {
        for (const p of PLAYERS) {
          st[p].goldMined += e.gained[p];
          perMine[p].set(e.mineId, (perMine[p].get(e.mineId) ?? 0) + e.gained[p]);
        }
        if (e.workers.p1 > 0 && e.workers.p2 > 0 && e.workers.p1 !== e.workers.p2) {
          const w: PlayerId = e.workers.p1 > e.workers.p2 ? 'p1' : 'p2';
          st[w].contestsWon++;
          st[w === 'p1' ? 'p2' : 'p1'].contestsLost++;
        }
      }
    }
  }
  for (const p of PLAYERS) {
    for (const [id, gold] of perMine[p]) if (gold > 0 && (!st[p].bestMine || gold > st[p].bestMine.gold)) st[p].bestMine = { id, gold };
  }
  return st;
}

/** Gold per player after each round, starting with round 0 (start). */
export function goldSeries(msg: GodUpdate): { round: number; p1: number; p2: number }[] {
  return [msg.start, ...msg.history.map((h) => h.snapshot)].map((s, i) => ({ round: i, p1: s.players.p1.gold, p2: s.players.p2.gold }));
}

export type MineInfo = Pick<Mine, 'id' | 'x' | 'y' | 'payout'>;
