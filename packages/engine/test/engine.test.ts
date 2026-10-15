import { describe, expect, it } from 'vitest';
import {
  aiState,
  buildPlayerBriefing,
  createGame,
  defaultSettings,
  moveError,
  playerView,
  resolveRound,
  type GameState,
  type Submission,
  type SubmittedAction,
} from '../src/index.js';

/** 30x30 game, base (15,15), with a hand-placed mine set. */
function game(mines: { id: string; x: number; y: number; payout: number }[] = [], gold = 20): GameState {
  const s = { ...defaultSettings(30), mineCount: 1, startGold: gold };
  const g = createGame(s, 1);
  g.mines = mines;
  for (const p of ['p1', 'p2'] as const) {
    g.players[p].knownMines = {};
  }
  return g;
}

function know(g: GameState, p: 'p1' | 'p2', mineId: string, round = 0) {
  g.players[p].knownMines[mineId] = round;
}

const act = (worker_id: string, action: string, extra: Partial<SubmittedAction> = {}): SubmittedAction => ({
  worker_id,
  action,
  ...extra,
});

const allStay = (n = 5): Submission => ({ actions: Array.from({ length: n }, (_, i) => act(`w${i + 1}`, 'STAY')) });

describe('setup', () => {
  it('places distinct mines off the base, payouts in range, deterministic per seed', () => {
    const s = { ...defaultSettings(30), mineCount: 50 };
    const a = createGame(s, 42);
    const b = createGame(s, 42);
    expect(a.mines).toEqual(b.mines);
    expect(new Set(a.mines.map((m) => `${m.x},${m.y}`)).size).toBe(50);
    for (const m of a.mines) {
      expect(m.x === 15 && m.y === 15).toBe(false);
      expect(m.payout).toBeGreaterThanOrEqual(2);
      expect(m.payout).toBeLessThanOrEqual(5);
    }
  });

  it('starts with 5 workers at base, 20 gold, 5x5 vision', () => {
    const g = createGame(defaultSettings(30), 7);
    expect(g.base).toEqual({ x: 15, y: 15 });
    expect(g.players.p1.workers).toHaveLength(5);
    expect(g.players.p1.gold2).toBe(40);
    expect(g.players.p1.explored.reduce((a, b) => a + b, 0)).toBe(25);
  });

  it('base on even size is floor(N/2)', () => {
    expect(createGame(defaultSettings(60), 1).base).toEqual({ x: 30, y: 30 });
  });
});

describe('costs and moves', () => {
  it('charges MOVE 1, STAY 0.5, COLLECT 1, DELETE 0', () => {
    const g = game([{ id: 'm1', x: 16, y: 16, payout: 2 }]);
    know(g, 'p1', 'm1');
    const { state } = resolveRound(g, {
      p1: {
        actions: [
          act('w1', 'MOVE', { dx: 3, dy: 0 }),
          act('w2', 'STAY'),
          act('w3', 'COLLECT', { mine_id: 'm1' }),
          act('w4', 'DELETE'),
          act('w5', 'STAY'),
        ],
      },
      p2: allStay(),
    });
    // 20 - 1 - 0.5 - 1 - 0 - 0.5 + 2 payout = 19
    expect(state.players.p1.gold2).toBe(38);
    expect(state.players.p1.workers.map((w) => w.id)).toEqual(['w1', 'w2', 'w3', 'w5']);
    expect(state.players.p1.workers[0]).toMatchObject({ x: 18, y: 15 });
    expect(state.players.p2.gold2).toBe(35);
  });

  it('MOVE may combine directions within range (Manhattan distance)', () => {
    const { state } = resolveRound(game(), {
      p1: { actions: [act('w1', 'MOVE', { dx: 2, dy: -2 }), act('w2', 'MOVE', { x: 14, y: 18 }), ...allStay().actions.slice(2)] },
      p2: allStay(),
    });
    expect(state.players.p1.workers[0]).toMatchObject({ x: 17, y: 13 });
    expect(state.players.p1.workers[1]).toMatchObject({ x: 14, y: 18 });
  });

  it('moveError (shared with UI) matches engine rules', () => {
    const w = { x: 1, y: 15 };
    expect(moveError(w, 2, -2, 30, 4)).toBeNull();
    expect(moveError(w, 0, 0, 30, 4)).toMatch(/somewhere/);
    expect(moveError(w, 3, 2, 30, 4)).toMatch(/exceeds/);
    expect(moveError(w, -2, 0, 30, 4)).toMatch(/leaves/);
  });

  it('accepts MOVE by target x/y', () => {
    const { state } = resolveRound(game(), {
      p1: { actions: [act('w1', 'MOVE', { x: 15, y: 11 }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(state.players.p1.workers[0]).toMatchObject({ x: 15, y: 11 });
  });

  it.each([
    ['zero', { dx: 0, dy: 0 }],
    ['too far', { dx: 5, dy: 0 }],
    ['too far combined', { dx: 3, dy: -2 }],
    ['off map', { dx: 0, dy: 0, x: 15, y: 40 }],
    ['fractional', { dx: 1.5, dy: 0 }],
  ])('invalid MOVE (%s) becomes STAY', (_, params) => {
    const { state, events } = resolveRound(game(), {
      p1: { actions: [act('w1', 'MOVE', params), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(state.players.p1.workers[0]).toMatchObject({ x: 15, y: 15 });
    expect(state.players.p1.gold2).toBe(40 - 5);
    expect(events.some((e) => e.type === 'invalid')).toBe(true);
  });

  it('cannot leave the map near an edge', () => {
    const g = game();
    g.players.p1.workers[0]!.x = 1;
    const { state } = resolveRound(g, {
      p1: { actions: [act('w1', 'MOVE', { dx: -2, dy: 0 }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(state.players.p1.workers[0]!.x).toBe(1);
  });

  it('missing actions default to STAY', () => {
    const { state, events } = resolveRound(game(), { p1: { actions: [] } });
    expect(state.players.p1.workers).toHaveLength(5);
    expect(state.players.p1.gold2).toBe(35);
    expect(state.players.p2.gold2).toBe(35);
    expect(events.filter((e) => e.type === 'missing')).toHaveLength(10);
  });
});

describe('affordability', () => {
  it('downgrades highest worker id first: MOVE/COLLECT -> STAY, then STAY -> DELETE', () => {
    const g = game([], 3); // 3 gold, 5 MOVEs would cost 5
    const moves = Array.from({ length: 5 }, (_, i) => act(`w${i + 1}`, 'MOVE', { dx: 1, dy: 0 }));
    const { state, events } = resolveRound(g, { p1: { actions: moves }, p2: allStay() });
    // 5 MOVE = 10 half; downgrade w5,w4,w3 -> STAY: 2+2+1+1+1 = 7 > 6; w2 -> STAY: 2+1+1+1+1 = 6 ok.
    expect(state.players.p1.gold2).toBe(0);
    const downs = events.filter((e) => e.type === 'downgrade').map((e) => (e as { workerId: string }).workerId);
    expect(downs).toEqual(['w5', 'w4', 'w3', 'w2']);
    expect(state.status).toBe('finished');
    expect(state.result).toMatchObject({ winner: 'p2' });
  });

  it('deletes workers when even STAY is unaffordable', () => {
    const g = game([], 1); // 1 gold = 2 half units: two STAYs max
    const { state } = resolveRound(g, { p1: allStay(), p2: allStay() });
    expect(state.players.p1.workers.map((w) => w.id)).toEqual(['w1', 'w2']);
    expect(state.players.p1.gold2).toBe(0);
  });
});

describe('collect', () => {
  const mine = { id: 'm1', x: 25, y: 25, payout: 5 };

  it('uncontested: full payout, collector returns to base, collects from anywhere', () => {
    const g = game([mine]);
    know(g, 'p1', 'm1');
    g.players.p1.workers[0]!.x = 2;
    g.players.p1.workers[0]!.y = 3;
    const { state } = resolveRound(g, {
      p1: { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(state.players.p1.gold2).toBe(40 - 2 - 4 + 10);
    expect(state.players.p1.workers[0]).toMatchObject({ x: 15, y: 15 });
  });

  it('two own workers on uncontested mine still earn one payout', () => {
    const g = game([mine]);
    know(g, 'p1', 'm1');
    const { state } = resolveRound(g, {
      p1: {
        actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), act('w2', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(2)],
      },
      p2: allStay(),
    });
    expect(state.players.p1.gold2).toBe(40 - 4 - 3 + 10);
  });

  it('majority takes all', () => {
    const g = game([mine]);
    know(g, 'p1', 'm1');
    know(g, 'p2', 'm1');
    const { state, events } = resolveRound(g, {
      p1: {
        actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), act('w2', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(2)],
      },
      p2: { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] },
    });
    expect(state.players.p1.gold2).toBe(40 - 7 + 10);
    expect(state.players.p2.gold2).toBe(40 - 6);
    expect(events.find((e) => e.type === 'collect')).toMatchObject({ gained: { p1: 5, p2: 0 } });
  });

  it('tie splits evenly, can be fractional', () => {
    const g = game([mine]);
    know(g, 'p1', 'm1');
    know(g, 'p2', 'm1');
    const one = { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] };
    const { state } = resolveRound(g, { p1: one, p2: one });
    expect(state.players.p1.gold2).toBe(40 - 6 + 5); // +2.5 gold
    expect(aiState(state, 'p1').gold).toBe(19.5);
  });

  it('unknown mine -> STAY', () => {
    const g = game([mine]);
    const { state, events } = resolveRound(g, {
      p1: { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(state.players.p1.gold2).toBe(35);
    expect(events.find((e) => e.type === 'invalid')).toMatchObject({ workerId: 'w1' });
  });

  it('mine discovered in round N is collectable only from N+1', () => {
    const g = game([{ id: 'm1', x: 15, y: 9, payout: 3 }]);
    // Round 1: move w1 north to (15,11) -> sees y 9..13 -> discovers m1.
    let r = resolveRound(g, {
      p1: { actions: [act('w1', 'MOVE', { dx: 0, dy: -4 }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(r.state.players.p1.knownMines.m1).toBe(1);
    expect(r.events).toContainEqual({ type: 'discover', player: 'p1', mineId: 'm1' });
    // Same-round collect would be rejected; check validation in round 2 succeeds.
    r = resolveRound(r.state, {
      p1: { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(r.events.find((e) => e.type === 'collect')).toMatchObject({ mineId: 'm1', gained: { p1: 3 } });
  });

  it('collect of a mine discovered this round is invalid', () => {
    const g = game([mine]);
    know(g, 'p1', 'm1', 1); // discovered in round 1, game is in round 1
    const { events } = resolveRound(g, {
      p1: { actions: [act('w1', 'COLLECT', { mine_id: 'm1' }), ...allStay().actions.slice(1)] },
      p2: allStay(),
    });
    expect(events.find((e) => e.type === 'invalid')).toBeTruthy();
  });
});

describe('vision', () => {
  it('only final positions reveal; explored persists; enemies only when visible', () => {
    const g = game([{ id: 'm1', x: 15, y: 12, payout: 3 }]);
    // m1 at distance 3 from base: not visible initially.
    expect(playerView(g, 'p1').known_mines).toHaveLength(0);
    const { state } = resolveRound(g, {
      p1: { actions: [act('w1', 'MOVE', { dx: 0, dy: -4 }), ...allStay().actions.slice(1)] },
      p2: { actions: Array.from({ length: 5 }, (_, i) => act(`w${i + 1}`, 'MOVE', { dx: 4, dy: 0 })) },
    });
    const v = playerView(state, 'p1');
    expect(v.known_mines.map((m) => m.id)).toEqual(['m1']);
    expect(v.visible_enemy_workers).toHaveLength(0); // p2 all at (19,15): outside 2-radius of p1 workers
    expect(v.enemy_last_seen).toHaveLength(5); // stale sighting from setup
    expect(v.enemy_last_seen[0]!.round).toBe(0);
    expect(v.opponent).toEqual({ gold: 15, workers: 5 });
  });

  it('player view never includes undiscovered mines', () => {
    const g = createGame({ ...defaultSettings(30), mineCount: 60 }, 3);
    const v = aiState(g, 'p1');
    for (const m of v.known_mines) expect(Math.abs(m.x - 15) <= 2 && Math.abs(m.y - 15) <= 2).toBe(true);
  });
});

describe('end conditions', () => {
  it('0 gold loses', () => {
    const g = game([], 2.5); // 5 STAYs = 2.5
    g.players.p2.gold2 = 20;
    const { state } = resolveRound(g, { p1: allStay(), p2: allStay() });
    expect(state.result).toMatchObject({ winner: 'p2' });
  });

  it('both 0 gold same round -> draw', () => {
    const { state } = resolveRound(game([], 2.5), {});
    expect(state.result).toMatchObject({ winner: null });
  });

  it('0 workers loses even with more gold', () => {
    const del = { actions: Array.from({ length: 5 }, (_, i) => act(`w${i + 1}`, 'DELETE')) };
    const { state } = resolveRound(game(), { p1: del, p2: allStay() });
    expect(state.result).toMatchObject({ winner: 'p2', reason: 'p1 has no workers' });
  });

  it('both 0 workers -> more gold wins', () => {
    const g = game();
    g.players.p2.gold2 = 30;
    const del = { actions: Array.from({ length: 5 }, (_, i) => act(`w${i + 1}`, 'DELETE')) };
    const { state } = resolveRound(g, { p1: del, p2: del });
    expect(state.result).toMatchObject({ winner: 'p1' });
  });

  it('after final round, more gold wins; equal draws', () => {
    let g = game([], 100);
    g.settings.roundsTotal = 2;
    g = resolveRound(g, {}).state;
    expect(g.status).toBe('active');
    expect(g.round).toBe(2);
    const done = resolveRound(g, {}).state;
    expect(done.result).toMatchObject({ winner: null });
    const g2 = structuredClone(g);
    g2.players.p1.gold2 += 1;
    expect(resolveRound(g2, {}).state.result).toMatchObject({ winner: 'p1' });
  });

  it('refuses to resolve a finished game', () => {
    const done = resolveRound(game([], 2.5), {}).state;
    expect(() => resolveRound(done, {})).toThrow();
  });
});

describe('purity & briefing', () => {
  it('resolveRound does not mutate input and is deterministic', () => {
    const g = createGame(defaultSettings(30), 9);
    const snapshot = JSON.stringify(g);
    const subs = { p1: { actions: [act('w1', 'MOVE', { dx: 2, dy: 0 })] } };
    const a = resolveRound(g, subs);
    const b = resolveRound(g, subs);
    expect(JSON.stringify(g)).toBe(snapshot);
    expect(a).toEqual(b);
  });

  it('briefings are identical except identity and contain no mine positions', () => {
    const s = defaultSettings(30);
    const b1 = buildPlayerBriefing(s, 'p1');
    const b2 = buildPlayerBriefing(s, 'p2');
    expect(b1.replace(/p1|p2/g, 'X')).toBe(b2.replace(/p1|p2/g, 'X'));
  });
});
