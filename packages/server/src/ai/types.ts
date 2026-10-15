import type { AiState, PlayerId, RoundEvent } from '@gold-war/engine';
import type { AiResponse } from './parse.js';

/** Everything an AI receives for one round. */
export interface AiRoundInput extends AiState {
  last_round: { events: RoundEvent[]; opponent_messages: string[] } | null;
  notes: string;
}

export interface AiPlayer {
  readonly agent: string;
  /** Boot the agent and hand it the briefing. Resolves when it is ready to play. */
  start(briefing: string): Promise<void>;
  /** Decide one round. Must give up by `deadline` (epoch ms). Throws on failure. */
  decide(input: AiRoundInput, deadline: number): Promise<AiResponse>;
  /** Interrupt an in-flight decision (round timed out). */
  cancel(): Promise<void>;
  stop(): Promise<void>;
}

export interface AiPlayerContext {
  gameId: string;
  player: PlayerId;
  seed: number;
}
