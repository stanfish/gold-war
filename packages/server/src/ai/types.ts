import type { AiState, ChatEntry, PlayerId, RoundEvent, SubmittedAction } from '@gold-war/engine';
import type { AiResponse } from './parse.js';

/** Everything an AI receives for one round. */
export interface AiRoundInput extends AiState {
  /** 'round' = new round; 'message' = the opponent wrote in table talk during this round; 'game_over' = final brief. */
  trigger: 'round' | 'message' | 'game_over';
  last_round: { events: RoundEvent[] } | null;
  /** Recent table talk, oldest first (empty when table talk is off). */
  chat: ChatEntry[];
  /** Orders this player already submitted this round (null if none yet). */
  my_current_orders: SubmittedAction[] | null;
  notes: string;
}

export interface AiPlayer {
  readonly agent: string;
  /** Boot the agent and hand it the briefing. Resolves when it is ready to play. */
  start(briefing: string): Promise<void>;
  /** Decide one round. Must give up by `deadline` (epoch ms). Throws on failure. */
  decide(input: AiRoundInput, deadline: number): Promise<AiResponse>;
  /** Rematch: brief an already-running agent for a new game (keeps what it learnt). Without it, nothing is sent. */
  newGame?(briefing: string, note: string): Promise<void>;
  /** Tell the agent the game is over (result + final round). Best effort, no reply expected. */
  gameOver?(message: string, input: AiRoundInput): Promise<void>;
  /** Interrupt an in-flight decision (round timed out). */
  cancel(): Promise<void>;
  stop(): Promise<void>;
}

export interface AiPlayerContext {
  gameId: string;
  player: PlayerId;
  seed: number;
}
