import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PLAYERS,
  RULES_VERSION,
  aiState,
  buildPlayerBriefing,
  createGame,
  opponentOf,
  playerView,
  resolveRound,
  type AiPanel,
  type ChatEntry,
  type CreateGameRequest,
  type GameState,
  type GodUpdate,
  type Phase,
  type PlayerId,
  type RoundEvent,
  type SeatConfig,
  type SeatUpdate,
  type SubmittedAction,
} from '@gold-war/engine';
import type { AiResponse } from './ai/parse.js';
import type { AiPlayer, AiPlayerContext, AiRoundInput } from './ai/types.js';

export const MAX_MESSAGES = 3;
export const MAX_MESSAGE_CHARS = 200;

export type AiFactory = (agent: string, ctx: AiPlayerContext) => AiPlayer;

interface PlayerSubmission {
  actions: SubmittedAction[];
  messages: string[];
}

interface RoundRecord {
  round: number;
  submissions: Partial<Record<PlayerId, PlayerSubmission>>;
  events: RoundEvent[];
}

/**
 * Events of a resolved round that `player` is entitled to see: all their own events, every collect (mine
 * name, payout and worker counts only — never coordinates), the end, and the opponent's public bookkeeping
 * (gold paid/earned, deletes). Opponent moves and discoveries stay hidden: they would reveal positions.
 */
const OPPONENT_PUBLIC = new Set<RoundEvent['type']>(['cost', 'income', 'delete']);

export function eventsFor(events: RoundEvent[], player: PlayerId): RoundEvent[] {
  return events.filter((e) => {
    if (e.type === 'end') return true;
    if (e.type === 'collect') return true;
    return e.player === player || OPPONENT_PUBLIC.has(e.type);
  });
}

export function sanitizeMessages(raw: unknown, tableTalk: boolean): string[] {
  if (!tableTalk || !Array.isArray(raw)) return [];
  return raw
    .filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    .slice(0, MAX_MESSAGES)
    .map((m) => m.trim().slice(0, MAX_MESSAGE_CHARS));
}

/** One running game: owns the engine state, the round timer, AI players, chat and the game log. */
export class GameSession {
  readonly id = randomBytes(8).toString('hex');
  readonly keys: { p1?: string; p2?: string; god: string };
  readonly seats: Record<PlayerId, SeatConfig>;
  state: GameState;
  phase: Phase = 'starting';
  phaseDetail: string | null = null;
  deadline: number | null = null;

  private timer: NodeJS.Timeout | null = null;
  private roundToken = 0;
  private submissions: Partial<Record<PlayerId, PlayerSubmission>> = {};
  private chat: ChatEntry[] = [];
  private history: RoundRecord[] = [];
  private connected = new Set<PlayerId>();
  private ai: Partial<Record<PlayerId, { player: AiPlayer; panel: AiPanel }>> = {};
  private listeners = new Set<() => void>();
  private readonly createdAt = new Date().toISOString();

  constructor(
    req: CreateGameRequest,
    private opts: { makeAi: AiFactory; logDir: string | null; /** Pause between rounds when no human plays, so spectators can follow. */ aiPaceMs?: number },
  ) {
    const seed = req.seed ?? randomBytes(4).readUInt32LE(0);
    this.state = createGame(req.settings, seed);
    this.seats = req.seats;
    const key = () => randomBytes(12).toString('base64url');
    this.keys = { god: key() };
    for (const p of PLAYERS) {
      const seat = req.seats[p];
      if (seat.type === 'human') this.keys[p] = key();
      else
        this.ai[p] = {
          player: opts.makeAi(seat.agent, { gameId: this.id, player: p, seed }),
          panel: { agent: seat.agent, status: 'booting', notes: '', thinking: {}, lastError: null },
        };
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Boot AI players, then wait for humans to connect before round 1. */
  async start(): Promise<void> {
    this.phase = 'starting';
    this.phaseDetail = 'starting AI players';
    this.emit();
    const boots = PLAYERS.flatMap((p) => {
      const a = this.ai[p];
      if (!a) return [];
      return [
        a.player.start(buildPlayerBriefing(this.state.settings, p)).then(
          () => {
            a.panel.status = 'ready';
            this.emit();
          },
          (e: Error) => {
            a.panel.status = 'failed';
            a.panel.lastError = e.message;
            throw new Error(`${p} (${a.panel.agent}) failed to start: ${e.message}`);
          },
        ),
      ];
    });
    try {
      await Promise.all(boots);
    } catch (e) {
      this.phase = 'error';
      this.phaseDetail = (e as Error).message;
      this.emit();
      // Don't leave the other agent (or its panes) running for a game that cannot start.
      await Promise.allSettled(PLAYERS.map((p) => this.ai[p]?.player.stop()));
      return;
    }
    this.phase = 'waiting';
    this.maybeBegin();
  }

  humanConnected(p: PlayerId): void {
    if (this.seats[p].type !== 'human') return;
    this.connected.add(p);
    this.maybeBegin();
  }

  private maybeBegin(): void {
    if (this.phase !== 'waiting') return;
    const missing = PLAYERS.filter((p) => this.seats[p].type === 'human' && !this.connected.has(p));
    if (missing.length) {
      this.phaseDetail = `waiting for ${missing.join(' and ')} to open their link`;
      this.emit();
      return;
    }
    this.openRound();
  }

  private openRound(): void {
    this.phase = 'playing';
    this.phaseDetail = null;
    this.submissions = {};
    const token = ++this.roundToken;
    const ms = this.state.settings.roundSeconds * 1000;
    this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => this.resolveNow(), ms);
    for (const p of PLAYERS) if (this.ai[p]) void this.runAi(p, token);
    this.emit();
  }

  private aiInput(p: PlayerId): AiRoundInput {
    const last = this.history.at(-1);
    return {
      ...aiState(this.state, p),
      last_round: last
        ? {
            events: eventsFor(last.events, p),
            opponent_messages: last.submissions[opponentOf(p)]?.messages ?? [],
          }
        : null,
      notes: this.ai[p]?.panel.notes ?? '',
    };
  }

  private async runAi(p: PlayerId, token: number): Promise<void> {
    const a = this.ai[p]!;
    const round = this.state.round;
    a.panel.status = 'thinking';
    this.emit();
    let resp: AiResponse;
    try {
      resp = await a.player.decide(this.aiInput(p), this.deadline!);
    } catch (e) {
      if (token !== this.roundToken) return;
      a.panel.status = 'failed';
      a.panel.lastError = `round ${round}: ${(e as Error).message}`;
      // Failure = every worker STAYs; submit now so the round need not wait out the timer.
      this.submit(p, { actions: [], messages: [] });
      return;
    }
    if (token !== this.roundToken) return; // too late, round already resolved
    a.panel.status = 'submitted';
    a.panel.lastError = null;
    a.panel.notes = resp.notes;
    a.panel.thinking[round] = resp.thinking;
    this.submit(p, { actions: resp.actions, messages: resp.messages });
  }

  /** Record (or replace) a player's submission for the open round. Returns an error string if rejected. */
  submit(p: PlayerId, sub: { actions: unknown; messages?: unknown }): string | null {
    if (this.phase !== 'playing') return 'no round is open';
    if (!Array.isArray(sub.actions)) return 'actions must be an array';
    this.submissions[p] = {
      actions: sub.actions as SubmittedAction[],
      messages: sanitizeMessages(sub.messages, this.state.settings.tableTalk),
    };
    // With fullRoundTimer the round always runs to the deadline; players may resubmit until then.
    if (!this.state.settings.fullRoundTimer && PLAYERS.every((q) => this.submissions[q])) this.resolveNow();
    else this.emit();
    return null;
  }

  private resolveNow(): void {
    if (this.phase !== 'playing') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.roundToken++;
    for (const p of PLAYERS) {
      const a = this.ai[p];
      if (a && a.panel.status === 'thinking') {
        a.panel.status = 'failed';
        a.panel.lastError = `round ${this.state.round}: timed out`;
        void a.player.cancel();
      }
    }

    const round = this.state.round;
    const subs = this.submissions;
    const { state, events } = resolveRound(this.state, subs);
    this.state = state;
    for (const p of PLAYERS) for (const text of subs[p]?.messages ?? []) this.chat.push({ round, sender: p, text });
    this.history.push({ round, submissions: subs, events });
    this.submissions = {};
    this.deadline = null;
    void this.persist();

    if (state.status === 'finished') {
      this.phase = 'finished';
      this.phaseDetail = state.result?.reason ?? null;
      this.emit();
      return;
    }
    const pace = this.opts.aiPaceMs ?? 0;
    if (pace > 0 && !this.state.settings.fullRoundTimer && PLAYERS.every((p) => this.seats[p].type === 'ai')) {
      this.phaseDetail = 'next round starting';
      this.emit();
      const token = this.roundToken;
      this.timer = setTimeout(() => {
        if (token === this.roundToken) this.openRound();
      }, pace);
      return;
    }
    this.openRound();
  }

  private base() {
    return {
      gameId: this.id,
      rulesVersion: RULES_VERSION,
      phase: this.phase,
      phaseDetail: this.phaseDetail,
      deadline: this.deadline,
      submitted: { p1: !!this.submissions.p1, p2: !!this.submissions.p2 },
      seats: this.seats,
      chat: this.chat,
    };
  }

  seatUpdate(p: PlayerId): SeatUpdate {
    const last = this.history.at(-1);
    const mine = this.submissions[p];
    return {
      ...this.base(),
      type: 'seat',
      seat: p,
      view: playerView(this.state, p),
      lastEvents: last ? eventsFor(last.events, p) : [],
      mySubmission: mine ? { actions: mine.actions, messages: mine.messages } : null,
    };
  }

  godUpdate(): GodUpdate {
    const ai: GodUpdate['ai'] = {};
    for (const p of PLAYERS) if (this.ai[p]) ai[p] = this.ai[p]!.panel;
    return {
      ...this.base(),
      type: 'god',
      state: this.state,
      pending: this.submissions,
      history: this.history.map((h) => ({ round: h.round, events: h.events, submissions: h.submissions })),
      ai,
    };
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.roundToken++;
    this.listeners.clear();
    await Promise.all(PLAYERS.map((p) => this.ai[p]?.player.stop()));
  }

  private async persist(): Promise<void> {
    if (!this.opts.logDir) return;
    const ai: Record<string, AiPanel> = {};
    for (const p of PLAYERS) if (this.ai[p]) ai[p] = this.ai[p]!.panel;
    const log = {
      gameId: this.id,
      createdAt: this.createdAt,
      seed: this.state.seed,
      settings: this.state.settings,
      seats: this.seats,
      rounds: this.history,
      chat: this.chat,
      ai,
      result: this.state.result,
    };
    try {
      await mkdir(this.opts.logDir, { recursive: true });
      await writeFile(join(this.opts.logDir, `${this.id}.json`), JSON.stringify(log, null, 2));
    } catch (e) {
      console.error('failed to write game log', e);
    }
  }
}
