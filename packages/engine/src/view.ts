import { opponentOf, type GameResult, type GameState, type PlayerId, type Sighting } from './types.js';
import { seenBy } from './vision.js';

/** Per-round state handed to an AI player (spec §15 `get_state` schema, plus a few extras). */
export interface AiState {
  you: PlayerId;
  round: number;
  rounds_total: number;
  gold: number;
  base: { x: number; y: number };
  workers: { id: string; x: number; y: number }[];
  known_mines: { id: string; x: number; y: number; payout: number; collectable: boolean }[];
  visible_enemy_workers: { x: number; y: number }[];
  /** Last sighting of enemy workers, possibly stale (round says when). */
  enemy_last_seen: Sighting[];
  opponent: { gold: number; workers: number };
  settings: { map_size: number; move_range: number; round_seconds: number; table_talk: boolean };
  status: 'active' | 'finished';
  result: GameResult | null;
}

/** What a player's UI may receive: the AI state plus the explored mask for fog rendering. */
export interface PlayerView extends AiState {
  explored: number[];
}

export function aiState(state: GameState, player: PlayerId): AiState {
  const me = state.players[player];
  const opp = state.players[opponentOf(player)];
  const s = state.settings;
  return {
    you: player,
    round: state.round,
    rounds_total: s.roundsTotal,
    gold: me.gold2 / 2,
    base: { ...state.base },
    workers: me.workers.map((w) => ({ id: w.id, x: w.x, y: w.y })),
    known_mines: state.mines
      .filter((m) => me.knownMines[m.id] !== undefined)
      .map((m) => ({ id: m.id, x: m.x, y: m.y, payout: m.payout, collectable: me.knownMines[m.id]! < state.round })),
    visible_enemy_workers: opp.workers.filter((w) => seenBy(me.workers, w)).map((w) => ({ x: w.x, y: w.y })),
    enemy_last_seen: me.enemySightings.map((s) => ({ ...s })),
    opponent: { gold: opp.gold2 / 2, workers: opp.workers.length },
    settings: { map_size: s.mapSize, move_range: s.moveRange, round_seconds: s.roundSeconds, table_talk: s.tableTalk },
    status: state.status,
    result: state.result,
  };
}

export function playerView(state: GameState, player: PlayerId): PlayerView {
  return { ...aiState(state, player), explored: [...state.players[player].explored] };
}
