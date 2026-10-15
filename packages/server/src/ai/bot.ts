import { scriptedBot } from '@gold-war/engine';
import type { AiPlayer, AiPlayerContext, AiRoundInput } from './types.js';
import type { AiResponse } from './parse.js';

/** Built-in scripted opponent. Instant, free, deterministic — for tests and quick games. */
export class BotPlayer implements AiPlayer {
  readonly agent = 'bot';
  constructor(private ctx: AiPlayerContext) {}

  async start(): Promise<void> {}

  async decide(input: AiRoundInput): Promise<AiResponse> {
    const d = scriptedBot(input, this.ctx.seed);
    return { actions: d.actions, messages: [], notes: d.notes, thinking: d.thinking };
  }

  async cancel(): Promise<void> {}
  async stop(): Promise<void> {}
}
