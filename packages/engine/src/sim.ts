import { createGame, defaultSettings, resolveRound, aiState, scriptedBot, PLAYERS, type GameState } from './index.js';

const games = Number(process.argv[2] ?? 100);
const size = Number(process.argv[3] ?? 30);
const tally: Record<string, number> = { p1: 0, p2: 0, draw: 0 };
const reasons: Record<string, number> = {};
let rounds = 0;

for (let g = 0; g < games; g++) {
  let state: GameState = createGame(defaultSettings(size), g + 1);
  while (state.status === 'active') {
    const subs = Object.fromEntries(PLAYERS.map((p) => [p, scriptedBot(aiState(state, p), g)]));
    state = resolveRound(state, subs).state;
    for (const p of PLAYERS) {
      const ps = state.players[p];
      if (ps.gold2 < 0) throw new Error(`negative gold g${g} ${p}`);
      if (ps.workers.length > state.settings.startWorkers) throw new Error('too many workers');
      for (const w of ps.workers)
        if (w.x < 0 || w.y < 0 || w.x >= size || w.y >= size) throw new Error('worker out of bounds');
    }
  }
  rounds += state.round;
  tally[state.result!.winner ?? 'draw']!++;
  const r = state.result!.reason.replace(/p[12]/, 'pX');
  reasons[r] = (reasons[r] ?? 0) + 1;
}
console.log(`${games} games on ${size}x${size}: avg ${(rounds / games).toFixed(1)} rounds`, tally);
console.log(reasons);
