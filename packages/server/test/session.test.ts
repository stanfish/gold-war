import { describe, expect, it, vi } from 'vitest';
import { defaultSettings, type PlayerId } from '@gold-war/engine';
import { BotPlayer } from '../src/ai/bot.js';
import { parseAiResponse } from '../src/ai/parse.js';
import type { AiPlayer } from '../src/ai/types.js';
import { GameSession, eventsFor, sanitizeMessages, type AiFactory } from '../src/session.js';

const bots: AiFactory = (_agent, ctx) => new BotPlayer(ctx);
const settings = (over = {}) => ({ ...defaultSettings(30), roundSeconds: 60, ...over });

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
    expect(s.submit('p1', { actions: [{ worker_id: 'w1', action: 'MOVE', dx: 3, dy: 0 }], messages: ['hi', 'x'.repeat(500)] })).toBeNull();
    expect(s.state.round).toBe(1);
    expect(s.seatUpdate('p1').mySubmission?.messages).toEqual(['hi', 'x'.repeat(200)]);
    expect(s.seatUpdate('p2').mySubmission).toBeNull();
    expect(s.seatUpdate('p2').chat).toEqual([]); // not revealed before resolution
    s.submit('p2', { actions: [] });
    expect(s.state.round).toBe(2);
    expect(s.seatUpdate('p2').chat).toHaveLength(2);

    // Seat payload must never include the full state or undiscovered mines.
    const u = s.seatUpdate('p2') as unknown as Record<string, unknown>;
    expect(u.state).toBeUndefined();
    const known = new Set(Object.keys(s.state.players.p2.knownMines));
    for (const m of s.seatUpdate('p2').view.known_mines) expect(known.has(m.id)).toBe(true);
    expect(JSON.stringify(u)).not.toContain('"mines"');
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

describe('helpers', () => {
  it('eventsFor hides opponent positional events, keeps contests and public bookkeeping', () => {
    const ev = [
      { type: 'move', player: 'p2' as PlayerId, workerId: 'w1', from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
      { type: 'discover', player: 'p2' as PlayerId, mineId: 'm9' },
      { type: 'cost', player: 'p2' as PlayerId, amount: 3 },
      { type: 'income', player: 'p2' as PlayerId, amount: 4 },
      { type: 'delete', player: 'p2' as PlayerId, workerId: 'w5' },
      { type: 'collect', mineId: 'm1', payout: 3, workers: { p1: 1, p2: 1 }, gained: { p1: 1.5, p2: 1.5 } },
      { type: 'collect', mineId: 'm2', payout: 3, workers: { p1: 0, p2: 1 }, gained: { p1: 0, p2: 3 } },
    ] as const;
    expect(eventsFor([...ev], 'p1').map((e) => e.type)).toEqual(['cost', 'income', 'delete', 'collect']);
  });

  it('sanitizeMessages respects table talk toggle and limits', () => {
    expect(sanitizeMessages(['a'], false)).toEqual([]);
    expect(sanitizeMessages(['a', '', 'b', 'c', 'd', 5], true)).toEqual(['a', 'b', 'c']);
  });

  it('parseAiResponse accepts fenced JSON and rejects junk', () => {
    const r = parseAiResponse('Sure!\n```json\n{"actions":[{"worker_id":"w1","action":"STAY"}],"notes":"n"}\n```');
    expect(r.actions).toHaveLength(1);
    expect(r.thinking).toBe('');
    expect(() => parseAiResponse('no json here')).toThrow(/invalid AI response/);
    expect(() => parseAiResponse('{"actions": "nope"}')).toThrow(/actions/);
  });
});
