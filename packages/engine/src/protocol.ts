/** Wire types shared by server and web. Types only — no runtime code. */
import type { GameState, PlayerId, RoundEvent, Settings, SubmittedAction } from './types.js';
import type { PlayerView } from './view.js';

/** 'bot' = built-in scripted player; anything else is a herdr agent kind (claude, codex, grok, ...). */
export type SeatConfig = { type: 'human' } | { type: 'ai'; agent: string };

/** One entry of the setup screen's AI dropdown. */
export interface AgentOption {
  id: string;
  label: string;
  /** Whether the agent's CLI was found on the server's PATH. */
  installed: boolean;
  isolation?: string;
}

export interface ChatEntry {
  round: number;
  sender: PlayerId;
  text: string;
}

export type Phase = 'starting' | 'waiting' | 'playing' | 'finished' | 'error';

export type AiStatus = 'booting' | 'ready' | 'thinking' | 'submitted' | 'failed' | 'stopped';

export interface AiPanel {
  agent: string;
  status: AiStatus;
  notes: string;
  /** Thinking trace per round. */
  thinking: Record<number, string>;
  lastError: string | null;
}

export interface CreateGameRequest {
  settings: Settings;
  seats: Record<PlayerId, SeatConfig>;
  seed?: number;
}

export interface CreateGameResponse {
  gameId: string;
  links: { p1?: string; p2?: string; god: string };
}

interface UpdateBase {
  gameId: string;
  /** Server's RULES_VERSION; the UI refuses to submit when it differs from its own. */
  rulesVersion: number;
  phase: Phase;
  phaseDetail: string | null;
  /** Epoch ms when the current round's timer runs out; null when no round is open. */
  deadline: number | null;
  submitted: Record<PlayerId, boolean>;
  seats: Record<PlayerId, SeatConfig>;
  /** Revealed chat (messages are revealed when their round resolves). */
  chat: ChatEntry[];
}

export interface SeatUpdate extends UpdateBase {
  type: 'seat';
  seat: PlayerId;
  view: PlayerView;
  /** Events of the last resolved round that this player is entitled to see. */
  lastEvents: RoundEvent[];
  /** This player's own submission for the open round, if any. */
  mySubmission: { actions: SubmittedAction[]; messages: string[] } | null;
}

export interface GodUpdate extends UpdateBase {
  type: 'god';
  state: GameState;
  history: { round: number; events: RoundEvent[] }[];
  ai: Partial<Record<PlayerId, AiPanel>>;
}

export type ServerMessage = SeatUpdate | GodUpdate | { type: 'error'; message: string };

export type ClientMessage = { type: 'submit'; actions: SubmittedAction[]; messages?: string[] };
