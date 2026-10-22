import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PLAYERS,
  RULES_VERSION,
  aiState,
  buildPlayerBriefing,
  createGame,
  rematchNote,
  describeEvent,
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
  type RelayPrompt,
  type RoundEvent,
  type SeatConfig,
  type SeatUpdate,
  type SubmittedAction,
} from '@gold-war/engine';
import { parseAiResponse, type AiResponse } from './ai/parse.js';
import type { AiPlayer, AiPlayerContext, AiRoundInput } from './ai/types.js';

/** Table talk is real-time: per player, per round. */
export const MAX_MESSAGES_PER_ROUND = 10;
export const MAX_MESSAGE_CHARS = 200;
/** Extra AI turns per round triggered by opponent messages (bounds AI-vs-AI chatter and cost). */
export const MAX_AI_REPLIES_PER_ROUND = 2;
/** Don't start an AI reply turn with less time than this left in the round. */
const MIN_REPLY_MS = 20_000;

export type AiFactory = (agent: string, ctx: AiPlayerContext) => AiPlayer;

/** What a rematch takes over from the finished game: links, running AI agents and their notes. */
export interface Carry {
  keys: { p1?: string; p2?: string; god: string };
  ai: Partial<Record<PlayerId, AiPlayer>>;
  notes: Partial<Record<PlayerId, string>>;
  gameNumber: number;
}

interface PlayerSubmission {
  actions: SubmittedAction[];
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

/** Trimmed, length-capped message text, or null if empty / not a string. */
export function cleanMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, MAX_MESSAGE_CHARS);
  return t.length ? t : null;
}

/** One running game: owns the engine state, the round timer, AI players, chat and the game log. */
export class GameSession {
  readonly id = randomBytes(8).toString('hex');
  readonly keys: { p1?: string; p2?: string; god: string };
  readonly gameNumber: number;
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
  /** Relay seats ("player with AI"): same panel as an AI so the GOD view shows notes/rationale. */
  private relay: Partial<Record<PlayerId, AiPanel>> = {};
  /** AI players with a turn in flight (one at a time per agent). */
  private aiBusy = new Set<PlayerId>();
  /** AI players with unanswered opponent messages. */
  private aiUnread = new Set<PlayerId>();
  private aiReplies: Record<PlayerId, number> = { p1: 0, p2: 0 };
  private listeners = new Set<() => void>();
  private readonly createdAt = new Date().toISOString();

  constructor(
    req: CreateGameRequest,
    private opts: { makeAi: AiFactory; logDir: string | null; /** Pause between rounds when no human plays, so spectators can follow. */ aiPaceMs?: number },
    private carry?: Carry,
  ) {
    this.gameNumber = carry?.gameNumber ?? 1;
    const seed = req.seed ?? randomBytes(4).readUInt32LE(0);
    const hasRelay = PLAYERS.some((p) => req.seats[p].type === 'relay');
    // Relay seats can't do real-time chat (each AI turn is a manual copy-paste), so table talk is off for the game.
    this.state = createGame(hasRelay ? { ...req.settings, tableTalk: false } : req.settings, seed);
    this.seats = req.seats;
    const key = () => randomBytes(12).toString('base64url');
    // A rematch keeps the links, so players' open pages carry straight on into the new game.
    this.keys = carry ? { ...carry.keys } : { god: key() };
    for (const p of PLAYERS) {
      const seat = req.seats[p];
      const notes = carry?.notes[p] ?? '';
      if (seat.type !== 'ai' && !carry) this.keys[p] = key();
      if (seat.type === 'relay') this.relay[p] = { agent: 'player with AI', status: 'ready', notes, thinking: {}, lastError: null };
      if (seat.type === 'ai')
        this.ai[p] = {
          player: carry?.ai[p] ?? opts.makeAi(seat.agent, { gameId: this.id, player: p, seed }),
          panel: { agent: seat.agent, status: 'booting', notes, thinking: {}, lastError: null },
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
      const briefing = buildPlayerBriefing(this.state.settings, p);
      // Rematch: the agent is already running and keeps what it learnt; just tell it a new game begins.
      const boot = this.carry?.ai[p]
        ? (a.player.newGame?.(briefing, rematchNote(this.gameNumber)) ?? Promise.resolve())
        : a.player.start(briefing);
      return [
        boot.then(
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
    if (this.seats[p].type === 'ai') return;
    this.connected.add(p);
    this.maybeBegin();
  }

  private maybeBegin(): void {
    if (this.phase !== 'waiting') return;
    const missing = PLAYERS.filter((p) => this.seats[p].type !== 'ai' && !this.connected.has(p));
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
    this.aiReplies = { p1: 0, p2: 0 };
    this.aiUnread.clear();
    for (const p of PLAYERS) if (this.ai[p]) void this.runAi(p, token, 'round');
    for (const r of Object.values(this.relay)) r.status = 'thinking';
    this.emit();
  }

  private aiInput(p: PlayerId, trigger: AiRoundInput['trigger']): AiRoundInput {
    const last = this.history.at(-1);
    return {
      ...aiState(this.state, p),
      trigger,
      last_round: last ? { events: eventsFor(last.events, p) } : null,
      chat: this.state.settings.tableTalk ? this.chat.slice(-30) : [],
      my_current_orders: this.submissions[p]?.actions ?? null,
      notes: (this.ai[p]?.panel ?? this.relay[p])?.notes ?? '',
    };
  }

  /**
   * Final brief for one seat: the result in plain words, a short account of the final round, and the state
   * after it as JSON (same fog-filtered view as every round).
   */
  private finalBrief(p: PlayerId): { message: string; input: AiRoundInput } {
    const input = this.aiInput(p, 'game_over');
    const result = this.state.result;
    const opp = opponentOf(p);
    const outcome = !result ? 'The game ended' : result.winner === null ? 'It is a DRAW' : result.winner === p ? 'You WON' : 'You LOST';
    const lines = (input.last_round?.events ?? []).map((e) => describeEvent(e, p));
    const message =
      `# Gold War — game over\n\n` +
      `${outcome}${result ? ` (${result.reason})` : ''}. Final gold: you ${input.gold}, opponent ${input.opponent.gold}. ` +
      `Workers left: you ${input.workers.length}, opponent ${input.opponent.workers}.\n\n` +
      `What happened in the final round (round ${this.state.round}), from your (${p}) side:\n` +
      (lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- nothing visible to you') +
      `\n\nFinal state:\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n` +
      `No orders needed: the game is finished. Thanks for playing against ${opp}.`;
    return { message, input };
  }

  /** Tell AI seats how the game ended (relay seats see the same brief on their page). */
  private briefGameOver(): void {
    for (const p of PLAYERS) {
      const a = this.ai[p];
      if (!a?.player.gameOver) continue;
      const { message, input } = this.finalBrief(p);
      a.player.gameOver(message, input).catch((e: Error) => {
        a.panel.lastError = `final brief: ${e.message}`;
        this.emit();
      });
    }
  }

  /** Relay seat's copy-paste prompt for the open round (same state an AI seat would get). */
  private relayPrompt(p: PlayerId): RelayPrompt {
    if (this.state.status === 'finished') {
      return { round: this.state.round, briefing: '', turn: this.finalBrief(p).message, lastError: null, final: true };
    }
    const input = this.aiInput(p, 'round');
    const turn =
      (this.gameNumber > 1 && input.round === 1 ? `${rematchNote(this.gameNumber)}\n\n` : '') +
      `# Gold War — round ${input.round} of ${input.rounds_total}\n\n` +
      `Game state for this round:\n\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n\n` +
      'Decide your orders and reply with ONLY the response JSON in the briefing format. Give every worker exactly one action ' +
      'and keep the set affordable. Put anything you want to remember in "notes": it comes back next round.';
    return {
      round: this.state.round,
      briefing: buildPlayerBriefing(this.state.settings, p, 'chat'),
      turn,
      lastError: this.relay[p]?.lastError ?? null,
      final: false,
    };
  }

  /** Relay seat pasted the outside AI's reply. Returns an error string if it can't be used. */
  relaySubmit(p: PlayerId, raw: unknown): string | null {
    const panel = this.relay[p];
    if (!panel) return 'this seat is not a player-with-AI seat';
    if (this.phase !== 'playing') return 'no round is open';
    if (typeof raw !== 'string' || !raw.trim()) return 'paste the AI reply first';
    let resp: AiResponse;
    try {
      resp = parseAiResponse(raw);
    } catch (e) {
      panel.lastError = `round ${this.state.round}: ${(e as Error).message}`;
      this.emit();
      return (e as Error).message;
    }
    panel.status = 'submitted';
    panel.lastError = null;
    panel.notes = resp.notes;
    panel.thinking[this.state.round] = resp.thinking;
    return this.submit(p, { actions: resp.actions });
  }

  /**
   * One AI turn. 'round' = the round's main decision; 'message' = an extra turn because the opponent wrote
   * in table talk: the AI may reply and revise its orders.
   */
  private async runAi(p: PlayerId, token: number, trigger: 'round' | 'message'): Promise<void> {
    const a = this.ai[p]!;
    const round = this.state.round;
    this.aiBusy.add(p);
    this.aiUnread.delete(p);
    a.panel.status = 'thinking';
    this.emit();
    let resp: AiResponse;
    try {
      resp = await a.player.decide(this.aiInput(p, trigger), this.deadline!);
    } catch (e) {
      this.aiBusy.delete(p);
      if (token !== this.roundToken) return;
      a.panel.lastError = `round ${round}${trigger === 'message' ? ' (chat reply)' : ''}: ${(e as Error).message}`;
      if (this.submissions[p]) {
        a.panel.status = 'submitted'; // a failed chat reply keeps the earlier orders
        this.emit();
      } else {
        a.panel.status = 'failed';
        // Failure = every worker STAYs; submit now so the round need not wait out the timer.
        this.submit(p, { actions: [] });
      }
      this.maybeResolveEarly();
      return;
    }
    this.aiBusy.delete(p);
    if (token !== this.roundToken) return; // too late, round already resolved
    a.panel.status = 'submitted';
    a.panel.lastError = null;
    a.panel.notes = resp.notes;
    const prev = a.panel.thinking[round];
    a.panel.thinking[round] = trigger === 'message' && prev ? `${prev}\n\n— after table talk —\n${resp.thinking}` : resp.thinking;
    for (const m of resp.messages) this.postChat(p, m);
    this.submit(p, { actions: resp.actions });
    this.maybeAiReply(p);
    this.maybeResolveEarly();
  }

  /** Whether an AI could take a chat-reply turn right now (ignoring whether it is busy). */
  private canReply(p: PlayerId): boolean {
    const a = this.ai[p];
    if (!a || a.player.agent === 'bot' || this.phase !== 'playing' || this.deadline === null) return false;
    return this.aiReplies[p] < MAX_AI_REPLIES_PER_ROUND && this.deadline - Date.now() >= MIN_REPLY_MS;
  }

  /**
   * Early resolution (fullRoundTimer off): once both players submitted — but never while an AI is still
   * mid-turn or has an unanswered message it may reply to, so table talk is not cut off.
   */
  private maybeResolveEarly(): void {
    if (this.phase !== 'playing' || this.state.settings.fullRoundTimer) return;
    if (!PLAYERS.every((q) => this.submissions[q])) return;
    const conversing = PLAYERS.some((q) => this.aiBusy.has(q) || (this.aiUnread.has(q) && this.canReply(q)));
    if (!conversing) this.resolveNow();
  }

  /** Give an AI an extra turn to answer opponent messages, if it has any unread and the round allows it. */
  private maybeAiReply(p: PlayerId): void {
    if (!this.aiUnread.has(p) || this.aiBusy.has(p) || !this.canReply(p)) return;
    this.aiReplies[p]++;
    void this.runAi(p, this.roundToken, 'message');
  }

  /**
   * Table talk: delivered to the opponent (and GOD view) immediately. Allowed any time the game is running.
   * Returns an error string if rejected.
   */
  postChat(p: PlayerId, raw: unknown): string | null {
    if (!this.state.settings.tableTalk) return 'table talk is off';
    if (this.phase === 'finished' || this.phase === 'error') return 'game is over';
    const text = cleanMessage(raw);
    if (!text) return 'empty message';
    const round = this.state.round;
    const sent = this.chat.filter((c) => c.round === round && c.sender === p).length;
    if (sent >= MAX_MESSAGES_PER_ROUND) return `max ${MAX_MESSAGES_PER_ROUND} messages per round`;
    this.chat.push({ round, sender: p, text, at: Date.now() });
    const opp = opponentOf(p);
    if (this.ai[opp]) {
      this.aiUnread.add(opp);
      this.maybeAiReply(opp);
    }
    this.emit();
    return null;
  }

  /** Record (or replace) a player's submission for the open round. Returns an error string if rejected. */
  submit(p: PlayerId, sub: { actions: unknown }): string | null {
    if (this.phase !== 'playing') return 'no round is open';
    if (!Array.isArray(sub.actions)) return 'actions must be an array';
    this.submissions[p] = { actions: sub.actions as SubmittedAction[] };
    // With fullRoundTimer the round always runs to the deadline; players may resubmit until then.
    this.emit();
    this.maybeResolveEarly();
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
        if (this.submissions[p]) a.panel.status = 'submitted'; // chat reply cut off; earlier orders stand
        else {
          a.panel.status = 'failed';
          a.panel.lastError = `round ${this.state.round}: timed out`;
        }
        void a.player.cancel();
      }
    }
    for (const r of Object.values(this.relay)) {
      if (r.status !== 'thinking') continue;
      r.status = 'failed';
      r.lastError = `round ${this.state.round}: no AI reply pasted in time`;
    }

    const round = this.state.round;
    const subs = this.submissions;
    const { state, events } = resolveRound(this.state, subs);
    this.state = state;
    this.history.push({ round, submissions: subs, events });
    this.submissions = {};
    this.deadline = null;
    void this.persist();

    if (state.status === 'finished') {
      this.phase = 'finished';
      this.phaseDetail = state.result?.reason ?? null;
      this.briefGameOver();
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
      gameNumber: this.gameNumber,
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
      mySubmission: mine ? { actions: mine.actions } : null,
      ...(this.relay[p] && { relay: this.relayPrompt(p) }),
    };
  }

  godUpdate(): GodUpdate {
    const ai: GodUpdate['ai'] = {};
    for (const p of PLAYERS) if (this.ai[p] || this.relay[p]) ai[p] = this.ai[p]?.panel ?? this.relay[p];
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
    this.detach();
    await Promise.all(PLAYERS.map((p) => this.ai[p]?.player.stop()));
  }

  private detach(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.roundToken++;
    this.aiBusy.clear();
    this.listeners.clear();
  }

  /**
   * New game with the same seats and settings (fresh map, new seed), keeping links, AI agents and their notes.
   * Only after game over. The caller starts the returned session.
   */
  rematch(): GameSession {
    if (this.phase !== 'finished') throw new Error('the game is not over yet');
    this.detach();
    const carry: Carry = { keys: this.keys, ai: {}, notes: {}, gameNumber: this.gameNumber + 1 };
    for (const p of PLAYERS) {
      const a = this.ai[p];
      if (a) carry.ai[p] = a.player;
      carry.notes[p] = (a?.panel ?? this.relay[p])?.notes ?? '';
    }
    return new GameSession({ settings: this.state.settings, seats: this.seats }, this.opts, carry);
  }

  private async persist(): Promise<void> {
    if (!this.opts.logDir) return;
    const ai: Record<string, AiPanel> = {};
    for (const p of PLAYERS) if (this.ai[p] || this.relay[p]) ai[p] = (this.ai[p]?.panel ?? this.relay[p])!;
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
