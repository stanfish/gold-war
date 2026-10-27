/** Wire types shared by server and web. Types only — no runtime code. */
import type { GameState, PlayerId, RoundEvent, Settings, SubmittedAction, Worker } from './types.js';
import type { PlayerView } from './view.js';

/** 'bot' = built-in scripted player; anything else is a herdr agent kind (claude, codex, grok, ...). */
/** `label` is the display name (e.g. "Claude Opus"), filled in by the server. */
/** 'relay' = "player with AI": a human copies each round's AI prompt into any AI outside the game and pastes its reply back. */
export type SeatConfig = { type: 'human' } | { type: 'relay' } | { type: 'ai'; agent: string; label?: string };

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
  /** Epoch ms when it was sent. */
  at: number;
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
  /** 1 for a fresh game, 2+ for rematches against the same opponent. */
  gameNumber: number;
  /** Server's RULES_VERSION; the UI refuses to submit when it differs from its own. */
  rulesVersion: number;
  phase: Phase;
  phaseDetail: string | null;
  /** Epoch ms when the current round's timer runs out; null when no round is open. */
  deadline: number | null;
  submitted: Record<PlayerId, boolean>;
  seats: Record<PlayerId, SeatConfig>;
  /** Table talk, delivered in real time. */
  chat: ChatEntry[];
}

export interface SeatUpdate extends UpdateBase {
  type: 'seat';
  seat: PlayerId;
  view: PlayerView;
  /** Events of the last resolved round that this player is entitled to see. */
  lastEvents: RoundEvent[];
  /** This player's own submission for the open round, if any. */
  mySubmission: { actions: SubmittedAction[] } | null;
  /** Relay seats only: what to paste into the outside AI this round. */
  relay?: RelayPrompt;
}

export interface RelayPrompt {
  round: number;
  /** Full rules (copy-paste variant). Only needs to go into a fresh AI conversation. */
  briefing: string;
  /** This round's message: the state JSON plus the reply instruction. */
  turn: string;
  /** Error from the last pasted reply, if it could not be used. */
  lastError: string | null;
  /** Game over: `turn` is the final brief (result + final round); nothing to paste back. */
  final: boolean;
}

export interface Orders {
  actions: SubmittedAction[];
}

/** Board state at one point in time (GOD replay): before round 1, or after a round resolved. */
export interface Snapshot {
  players: Record<PlayerId, { gold: number; workers: Worker[]; knownMines: string[] }>;
}

export interface GodUpdate extends UpdateBase {
  type: 'god';
  state: GameState;
  /** Orders submitted so far in the open round (latest version per player). */
  pending: Partial<Record<PlayerId, Orders>>;
  /** Board before round 1. */
  start: Snapshot;
  /** `snapshot` = board after that round resolved. */
  history: { round: number; events: RoundEvent[]; submissions: Partial<Record<PlayerId, Orders>>; snapshot: Snapshot }[];
  ai: Partial<Record<PlayerId, AiPanel>>;
}

export type ServerMessage = SeatUpdate | GodUpdate | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'submit'; actions: SubmittedAction[] }
  | { type: 'chat'; text: string }
  /** Relay seats: the outside AI's raw reply, parsed by the server. */
  | { type: 'relay'; text: string }
  /** After game over (GOD view, or seats that are not AI): new game, same seats and settings. */
  | { type: 'rematch' };
