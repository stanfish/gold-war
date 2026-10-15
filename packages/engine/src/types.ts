export type PlayerId = 'p1' | 'p2';
export const PLAYERS: readonly PlayerId[] = ['p1', 'p2'];

export function opponentOf(p: PlayerId): PlayerId {
  return p === 'p1' ? 'p2' : 'p1';
}

export interface Settings {
  mapSize: number;
  mineCount: number;
  moveRange: number;
  roundSeconds: number;
  tableTalk: boolean;
  roundsTotal: number;
  payoutMin: number;
  payoutMax: number;
  startWorkers: number;
  startGold: number;
}

export interface Pos {
  x: number;
  y: number;
}

export interface Worker extends Pos {
  id: string;
}

export interface Mine extends Pos {
  id: string;
  payout: number;
}

export interface Sighting extends Pos {
  round: number;
}

export interface PlayerState {
  id: PlayerId;
  /** Gold in half-units (gold * 2) to keep 0.5 steps exact. */
  gold2: number;
  workers: Worker[];
  /** Row-major N*N mask: 1 = square has been seen at least once. */
  explored: number[];
  /** mineId -> round number in which the player discovered it (0 = at setup). */
  knownMines: Record<string, number>;
  /** Most recent opponent worker sightings (from the last round with any sighting). */
  enemySightings: Sighting[];
}

export type GameResult =
  | { winner: PlayerId; reason: string }
  | { winner: null; reason: string };

export interface GameState {
  settings: Settings;
  seed: number;
  /** Round currently being played (1-based). After the game ends it stays at the last played round. */
  round: number;
  base: Pos;
  mines: Mine[];
  players: Record<PlayerId, PlayerState>;
  status: 'active' | 'finished';
  result: GameResult | null;
}

export type ActionType = 'MOVE' | 'STAY' | 'COLLECT' | 'DELETE';

/** Action as submitted by a UI or an AI (spec §15 JSON schema). */
export interface SubmittedAction {
  worker_id: string;
  action: string;
  dx?: number;
  dy?: number;
  x?: number;
  y?: number;
  mine_id?: string;
}

export interface Submission {
  actions: SubmittedAction[];
}

/** Action after validation, used internally by resolution. */
export type ResolvedAction =
  | { type: 'MOVE'; dx: number; dy: number }
  | { type: 'COLLECT'; mineId: string }
  | { type: 'STAY' }
  | { type: 'DELETE' };

export type RoundEvent =
  | { type: 'missing'; player: PlayerId; workerId: string }
  | { type: 'invalid'; player: PlayerId; workerId: string; reason: string }
  | { type: 'downgrade'; player: PlayerId; workerId: string; from: ActionType; to: ActionType }
  | { type: 'move'; player: PlayerId; workerId: string; from: Pos; to: Pos }
  | {
      type: 'collect';
      mineId: string;
      payout: number;
      workers: Record<PlayerId, number>;
      gained: Record<PlayerId, number>;
    }
  | { type: 'delete'; player: PlayerId; workerId: string }
  | { type: 'discover'; player: PlayerId; mineId: string }
  | { type: 'cost'; player: PlayerId; amount: number }
  | { type: 'end'; result: GameResult };
