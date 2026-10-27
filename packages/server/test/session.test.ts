import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type PlayerId } from '@gold-war/engine';
import { BotPlayer } from '../src/ai/bot.js';
import { parseAiResponse } from '../src/ai/parse.js';
import type { AiPlayer } from '../src/ai/types.js';
import { GameSession, MAX_AI_REPLIES_PER_ROUND, MAX_MESSAGES_PER_ROUND, cleanMessage, eventsFor, type AiFactory } from '../src/session.js';
import type { AiRoundInput } from '../src/ai/types.js';

const bots: AiFactory = (_agent, ctx) => new BotPlayer(ctx);
const settings = (over = {}) => ({ ...defaultSettings(30), roundSeconds: 60, fullRoundTimer: false, ...over });

async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('GameSession', () => {
  it('plays bot vs bot to completion without timers', async () => {
    const s = new GameSession(
      { settings: settings(), seats: { p1: { type: 'ai', agent: 'bot' }, p2: { type: 'ai', agent: 'bot' } }, seed: 5 },
      { makeAi: bots, logDir: null },
    );
    await s.start();
    for (let i = 0; i < 100 && s.phase !== 'finished'; i++) await flush();
    expect(s.phase).toBe('finished');
    expect(s.state.result).not.toBeNull();
    const god = s.godUpdate();
    expect(god.ai.p1?.thinking[1]).toBeTruthy();
    s.stop();
  });

  it('waits for humans, resolves when both submit, keeps seat views filtered', async () => {
    const s = new GameSession(
      { settings: settings({ tableTalk: true }), seats: { p1: { type: 'human' }, p2: { type: 'human' } }, seed: 1 },
      { makeAi: bots, logDir: null },
    );
    await s.start();
    expect(s.phase).toBe('waiting');
    s.humanConnected('p1');
    expect(s.phase).toBe('waiting');
    s.humanConnected('p2');
    expect(s.phase).toBe('playing');
    expect(s.submit('p1', { actions: [{ worker_id: 'w1', action: 'MOVE', dx: 3, dy: 0 }] })).toBeNull();
    expect(s.state.round).toBe(1);
    expect(s.seatUpdate('p1').mySubmission?.actions).toHaveLength(1);
    expect(s.seatUpdate('p2').mySubmission).toBeNull();
    expect(s.godUpdate().pending.p1?.actions).toHaveLength(1);
    expect(s.godUpdate().pending.p2).toBeUndefined();
    expect(JSON.stringify(s.seatUpdate('p2'))).not.toContain('"dx":3');
    s.submit('p2', { actions: [] });
    expect(s.state.round).toBe(2);
    expect(s.godUpdate().pending).toEqual({});
    expect(s.godUpdate().history[0]?.submissions.p1?.actions[0]).toMatchObject({ action: 'MOVE', dx: 3 });

    // Seat payload must never include the full state or undiscovered mines.
    const u = s.seatUpdate('p2') as unknown as Record<string, unknown>;
    expect(u.state).toBeUndefined();
    const known = new Set(Object.keys(s.state.players.p2.knownMines));
    for (const m of s.seatUpdate('p2').view.known_mines) expect(known.has(m.id)).toBe(true);
    expect(JSON.stringify(u)).not.toContain('"mines"');
    s.stop();
  });

  it('relay seat: one copy-paste prompt per round, pasted AI reply becomes orders, no table talk', async () => {
    const s = new GameSession(
      { settings: settings({ tableTalk: true }), seats: { p1: { type: 'relay' }, p2: { type: 'ai', agent: 'bot' } }, seed: 3 },
      { makeAi: bots, logDir: null },
    );
    expect(s.keys.p1).toBeTruthy();
    expect(s.state.settings.tableTalk).toBe(false);
    await s.start();
    expect(s.phase).toBe('waiting');
    s.humanConnected('p1');
    await flush();
    const relay = s.seatUpdate('p1').relay!;
    expect(relay.round).toBe(1);
    expect(relay.briefing).toContain('reply with your orders as JSON');
    expect(relay.briefing).not.toContain('response file');
    expect(relay.turn).toContain('"you": "p1"');
    expect(s.seatUpdate('p2').relay).toBeUndefined();
    expect(s.postChat('p1', 'hi')).toBe('table talk is off');

    expect(s.relaySubmit('p1', 'not json at all')).toMatch(/invalid AI response/);
    expect(s.seatUpdate('p1').relay?.lastError).toMatch(/invalid AI response/);
    expect(s.state.round).toBe(1);

    const reply = 'Here you go:\n```json\n{"actions":[{"worker_id":"w1","action":"MOVE","dx":2,"dy":0}],"notes":"went east","rationale":"scout"}\n```';
    expect(s.relaySubmit('p1', reply)).toBeNull();
    await flush();
    expect(s.state.round).toBe(2);
    expect(s.state.players.p1.workers.find((w) => w.id === 'w1')).toMatchObject({ x: 17, y: 15 });
    expect(s.godUpdate().ai.p1).toMatchObject({ notes: 'went east', thinking: { 1: 'scout' } });
    const next = s.seatUpdate('p1').relay!;
    expect(next.round).toBe(2);
    expect(next.lastError).toBeNull();
    expect(next.turn).toContain('went east');
    s.stop();
  });

  it('game over: AI seats get a final brief, relay seats see it instead of a prompt', async () => {
    const briefs: { message: string; input: AiRoundInput }[] = [];
    const makeAi: AiFactory = (agent, ctx) => {
      const bot = new BotPlayer(ctx);
      return Object.assign(bot, { agent, gameOver: async (message: string, input: AiRoundInput) => void briefs.push({ message, input }) });
    };
    const s = new GameSession(
      { settings: settings({ roundsTotal: 1 }), seats: { p1: { type: 'relay' }, p2: { type: 'ai', agent: 'fake' } }, seed: 3 },
      { makeAi, logDir: null },
    );
    await s.start();
    s.humanConnected('p1');
    await flush();
    expect(s.relaySubmit('p1', '{"actions":[]}')).toBeNull();
    await flush();
    expect(s.phase).toBe('finished');

    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.input).toMatchObject({ trigger: 'game_over', you: 'p2', status: 'finished' });
    expect(briefs[0]!.message).toMatch(/You (WON|LOST)|DRAW/);
    expect(briefs[0]!.message).toContain('final round (round 1)');

    const relay = s.seatUpdate('p1').relay!;
    expect(relay.final).toBe(true);
    expect(relay.turn).toContain('game over');
    expect(relay.turn).toContain('"trigger": "game_over"');
    expect(relay.turn).not.toContain('"you": "p2"');
    s.stop();
  });

  it('rematch: same links and seats, fresh map, running AI is re-briefed (not restarted), notes carry over', async () => {
    const calls: string[] = [];
    const makeAi: AiFactory = (agent, ctx) =>
      Object.assign(new BotPlayer(ctx), {
        agent,
        start: async () => void calls.push('start'),
        newGame: async (_b: string, note: string) => void calls.push(`newGame:${note}`),
        stop: async () => void calls.push('stop'),
      });
    const s = new GameSession(
      { settings: settings({ roundsTotal: 1 }), seats: { p1: { type: 'relay' }, p2: { type: 'ai', agent: 'fake' } }, seed: 3 },
      { makeAi, logDir: null },
    );
    expect(() => s.rematch()).toThrow(/not over/);
    await s.start();
    s.humanConnected('p1');
    await flush();
    s.relaySubmit('p1', '{"actions":[],"notes":"opponent rushes east"}');
    await flush();
    expect(s.phase).toBe('finished');

    const r = s.rematch();
    expect(r.id).not.toBe(s.id);
    expect(r.keys).toEqual(s.keys);
    expect(r.gameNumber).toBe(2);
    expect(r.seats).toEqual(s.seats);
    expect(r.state.seed).not.toBe(s.state.seed);
    expect(r.state.settings).toEqual(s.state.settings);
    await r.start();
    r.humanConnected('p1');
    await flush();
    expect(calls).toEqual(['start', expect.stringMatching(/^newGame:NEW GAME: this is a rematch \(game 2/)]);
    expect(r.seatUpdate('p1').gameNumber).toBe(2);
    const relay = r.seatUpdate('p1').relay!;
    expect(relay.round).toBe(1);
    expect(relay.turn).toMatch(/^NEW GAME: this is a rematch/);
    expect(relay.turn).toContain('opponent rushes east');
    r.stop();
  });

  it('GOD history has per-round snapshots and collector ids; seat views never get collector ids', async () => {
    const s = new GameSession(
      { settings: settings({ roundsTotal: 6 }), seats: { p1: { type: 'ai', agent: 'bot' }, p2: { type: 'ai', agent: 'bot' } }, seed: 5 },
      { makeAi: bots, logDir: null },
    );
    await s.start();
    for (let i = 0; i < 100 && s.phase !== 'finished'; i++) await flush();
    const god = s.godUpdate();
    expect(god.start.players.p1.workers).toHaveLength(5);
    expect(god.start.players.p1.gold).toBe(20);
    const last = god.history.at(-1)!;
    expect(last.snapshot.players.p1.gold).toBe(s.state.players.p1.gold2 / 2);
    expect(last.snapshot.players.p2.workers).toEqual(s.state.players.p2.workers);
    const collects = god.history.flatMap((h) => h.events).filter((e) => e.type === 'collect');
    expect(collects.length).toBeGreaterThan(0);
    for (const c of collects) if (c.type === 'collect') expect(c.collectors!.p1.length + c.collectors!.p2.length).toBe(c.workers.p1 + c.workers.p2);
    for (const e of eventsFor(last.events, 'p1')) expect(e).not.toHaveProperty('collectors');
    s.stop();
  });

  it('resolves on timeout with missing actions as STAY', async () => {
    vi.useFakeTimers();
    try {
      const s = new GameSession(
        { settings: settings({ roundSeconds: 10 }), seats: { p1: { type: 'human' }, p2: { type: 'human' } }, seed: 1 },
        { makeAi: bots, logDir: null },
      );
      await s.start();
      s.humanConnected('p1');
      s.humanConnected('p2');
      vi.advanceTimersByTime(10_001);
      expect(s.state.round).toBe(2);
      expect(s.state.players.p1.workers).toHaveLength(5);
      expect(s.state.players.p1.gold2).toBe(35);
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fullRoundTimer: both submitted still waits for the deadline, resubmits allowed', async () => {
    vi.useFakeTimers();
    try {
      const s = new GameSession(
        { settings: settings({ roundSeconds: 120, fullRoundTimer: true }), seats: { p1: { type: 'human' }, p2: { type: 'human' } }, seed: 1 },
        { makeAi: bots, logDir: null },
      );
      await s.start();
      s.humanConnected('p1');
      s.humanConnected('p2');
      s.submit('p1', { actions: [{ worker_id: 'w1', action: 'MOVE', dx: 1, dy: 0 }] });
      s.submit('p2', { actions: [] });
      vi.advanceTimersByTime(60_000);
      expect(s.state.round).toBe(1);
      expect(s.submit('p1', { actions: [{ worker_id: 'w1', action: 'MOVE', dx: 2, dy: 0 }] })).toBeNull();
      vi.advanceTimersByTime(60_001);
      expect(s.state.round).toBe(2);
      expect(s.state.players.p1.workers[0]!.x).toBe(17); // the resubmitted order won
      s.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('AI failure submits STAY for everyone and records the error', async () => {
    const failing: AiFactory = (agent) =>
      ({
        agent,
        start: async () => {},
        decide: async () => {
          throw new Error('boom');
        },
        cancel: async () => {},
        stop: async () => {},
      }) satisfies AiPlayer;
    const s = new GameSession(
      { settings: settings(), seats: { p1: { type: 'ai', agent: 'claude' }, p2: { type: 'human' } }, seed: 1 },
      { makeAi: failing, logDir: null },
    );
    await s.start();
    s.humanConnected('p2');
    await flush();
    expect(s.godUpdate().ai.p1?.lastError).toContain('boom');
    s.submit('p2', { actions: [] });
    expect(s.state.round).toBe(2);
    expect(s.state.players.p1.gold2).toBe(35);
    s.stop();
  });

  it('boot failure puts the session in error phase', async () => {
    const broken: AiFactory = (agent) => ({
      agent,
      start: async () => {
        throw new Error('herdr missing');
      },
      decide: async () => ({ actions: [], messages: [], notes: '', thinking: '' }),
      cancel: async () => {},
      stop: async () => {},
    });
    const s = new GameSession(
      { settings: settings(), seats: { p1: { type: 'ai', agent: 'codex' }, p2: { type: 'human' } } },
      { makeAi: broken, logDir: null },
    );
    await s.start();
    expect(s.phase).toBe('error');
    expect(s.phaseDetail).toContain('herdr missing');
  });
});

describe('table talk', () => {
  const humans = async (over = {}) => {
    const s = new GameSession(
      { settings: settings({ tableTalk: true, fullRoundTimer: true, ...over }), seats: { p1: { type: 'human' }, p2: { type: 'human' } }, seed: 1 },
      { makeAi: bots, logDir: null },
    );
    await s.start();
    s.humanConnected('p1');
    s.humanConnected('p2');
    return s;
  };

  it('delivers messages immediately, independent of orders', async () => {
    const s = await humans();
    expect(s.postChat('p1', 'want to split m3?')).toBeNull();
    expect(s.seatUpdate('p2').chat).toMatchObject([{ round: 1, sender: 'p1', text: 'want to split m3?' }]);
    expect(s.postChat('p2', 'no')).toBeNull();
    expect(s.seatUpdate('p1').chat.map((c) => c.text)).toEqual(['want to split m3?', 'no']);
    expect(s.godUpdate().chat).toHaveLength(2);
    expect(s.state.round).toBe(1); // chatting does not resolve anything
    s.stop();
  });

  it('enforces table talk toggle and per-round limit', async () => {
    const off = await humans({ tableTalk: false });
    expect(off.postChat('p1', 'hi')).toMatch(/off/);
    off.stop();
    const s = await humans();
    for (let i = 0; i < MAX_MESSAGES_PER_ROUND; i++) expect(s.postChat('p1', `m${i}`)).toBeNull();
    expect(s.postChat('p1', 'one too many')).toMatch(/max/);
    expect(s.postChat('p1', '   ')).toMatch(/empty/);
    s.stop();
  });

  it('AI gets a reply turn when the opponent writes, can answer and revise orders, capped per round', async () => {
    const inputs: AiRoundInput[] = [];
    const chatty: AiFactory = (agent) => ({
      agent,
      start: async () => {},
      decide: async (input) => {
        inputs.push(input);
        const reply = input.trigger === 'message';
        return {
          actions: [{ worker_id: 'w1', action: 'MOVE', dx: reply ? 2 : 1, dy: 0 }],
          messages: reply ? [`re: ${input.chat.at(-1)?.text}`] : [],
          notes: '',
          thinking: reply ? 'replied' : 'opened',
        };
      },
      cancel: async () => {},
      stop: async () => {},
    });
    const s = new GameSession(
      { settings: settings({ tableTalk: true, fullRoundTimer: true }), seats: { p1: { type: 'ai', agent: 'claude-sonnet' }, p2: { type: 'human' } }, seed: 1 },
      { makeAi: chatty, logDir: null },
    );
    await s.start();
    s.humanConnected('p2');
    await flush();
    expect(inputs.map((i) => i.trigger)).toEqual(['round']);

    s.postChat('p2', 'truce?');
    await flush();
    expect(inputs.at(-1)).toMatchObject({ trigger: 'message', my_current_orders: [{ dx: 1 }] });
    expect(s.seatUpdate('p2').chat.map((c) => c.text)).toEqual(['truce?', 're: truce?']);
    expect(s.godUpdate().pending.p1?.actions[0]).toMatchObject({ dx: 2 }); // revised orders
    expect(s.godUpdate().ai.p1?.thinking[1]).toContain('after table talk');

    for (let i = 0; i < 5; i++) {
      s.postChat('p2', `ping ${i}`);
      await flush();
    }
    expect(inputs.filter((i) => i.trigger === 'message')).toHaveLength(MAX_AI_REPLIES_PER_ROUND);
    s.stop();
  });
});

describe('table talk with early resolution', () => {
  it('round does not resolve while an AI is answering a message', async () => {
    let calls = 0;
    const talker: AiFactory = (agent, ctx) => ({
      agent,
      start: async () => {},
      decide: async (input) => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return {
          actions: [],
          messages: [`${ctx.player} ${input.trigger} ${input.chat.length}`],
          notes: '',
          thinking: '',
        };
      },
      cancel: async () => {},
      stop: async () => {},
    });
    const s = new GameSession(
      { settings: settings({ tableTalk: true, fullRoundTimer: false }), seats: { p1: { type: 'ai', agent: 'claude-opus' }, p2: { type: 'ai', agent: 'claude-sonnet' } }, seed: 1 },
      { makeAi: talker, logDir: null },
    );
    await s.start();
    for (let i = 0; i < 50 && s.state.round === 1; i++) await new Promise((r) => setTimeout(r, 5));
    const r1 = s.godUpdate().chat.filter((c) => c.round === 1);
    // 2 opening messages + up to 2 replies each before the round could resolve.
    expect(r1.length).toBe(2 + 2 * MAX_AI_REPLIES_PER_ROUND);
    expect(r1.filter((c) => c.text.includes('message'))).toHaveLength(2 * MAX_AI_REPLIES_PER_ROUND);
    expect(s.state.round).toBe(2);
    expect(calls).toBeGreaterThanOrEqual(6);
    s.stop();
  });
});

describe('helpers', () => {
  it('eventsFor hides opponent positional events, keeps all collects and public bookkeeping', () => {
    const ev = [
      { type: 'move', player: 'p2' as PlayerId, workerId: 'w1', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
      { type: 'discover', player: 'p2' as PlayerId, mineId: 'm9' },
      { type: 'cost', player: 'p2' as PlayerId, amount: 3 },
      { type: 'income', player: 'p2' as PlayerId, amount: 4 },
      { type: 'delete', player: 'p2' as PlayerId, workerId: 'w5' },
      { type: 'collect', mineId: 'm1', payout: 3, workers: { p1: 1, p2: 1 }, gained: { p1: 1.5, p2: 1.5 } },
      { type: 'collect', mineId: 'm2', payout: 3, workers: { p1: 0, p2: 1 }, gained: { p1: 0, p2: 3 } },
    ] as const;
    expect(eventsFor([...ev], 'p1').map((e) => e.type)).toEqual(['cost', 'income', 'delete', 'collect', 'collect']);
  });

  it('cleanMessage trims, caps length, rejects empty / non-strings', () => {
    expect(cleanMessage('  hi ')).toBe('hi');
    expect(cleanMessage('x'.repeat(500))).toHaveLength(200);
    expect(cleanMessage('   ')).toBeNull();
    expect(cleanMessage(5)).toBeNull();
  });

  it('parseAiResponse accepts fenced JSON and rejects junk', () => {
    const r = parseAiResponse('Sure!\n```json\n{"actions":[{"worker_id":"w1","action":"STAY"}],"notes":"n"}\n```');
    expect(r.actions).toHaveLength(1);
    expect(r.thinking).toBe('');
    expect(() => parseAiResponse('no json here')).toThrow(/invalid AI response/);
    expect(() => parseAiResponse('{"actions": "nope"}')).toThrow(/actions/);
  });
});
