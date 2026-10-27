import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PLAYERS,
  SIZE_DEFAULTS,
  validateSettings,
  type ClientMessage,
  type CreateGameRequest,
  type AgentOption,
  type CreateGameResponse,
  type PlayerId,
  type ServerMessage,
} from '@gold-war/engine';
import { BotPlayer } from './ai/bot.js';
import { AGENT_PRESETS, HerdrAgentPlayer, findPreset, herdrAvailable, installedKinds, presetIsolation } from './ai/herdr.js';
import { GameSession, type AiFactory } from './session.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = Number(process.env.PORT ?? 8787);
// Loopback by default; HOST=0.0.0.0 exposes the game to the LAN.
const HOST = process.env.HOST ?? '127.0.0.1';
const WEB_DIST = join(ROOT, 'packages/web/dist');
/** Public hosting: only human and player-with-AI seats (no AI agents run on this server). */
const HUMAN_SEATS_ONLY = process.env.GOLDWAR_HUMAN_SEATS_ONLY === '1';
/** If set, creating a game requires this password (starting a game ends the one in progress). */
const CREATE_PASSWORD = process.env.GOLDWAR_CREATE_PASSWORD || null;

function passwordOk(given: unknown): boolean {
  if (!CREATE_PASSWORD) return true;
  if (typeof given !== 'string') return false;
  const h = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(h(given), h(CREATE_PASSWORD));
}

const makeAi: AiFactory = (agent, ctx) => (agent === 'bot' ? new BotPlayer(ctx) : new HerdrAgentPlayer(agent, ctx));

let session: GameSession | null = null;

async function agentList(): Promise<AgentOption[]> {
  const installed = await installedKinds();
  return [
    { id: 'bot', label: 'bot (built-in scripted)', installed: true },
    ...AGENT_PRESETS.map((p) => ({ id: p.id, label: p.label, installed: installed.has(p.kind), isolation: presetIsolation(p.id) })),
  ];
}

const app = Fastify({ logger: { level: 'info' } });

app.get('/api/meta', async () => ({
  agents: HUMAN_SEATS_ONLY ? [] : await agentList(),
  herdrAvailable: HUMAN_SEATS_ONLY ? false : await herdrAvailable(),
  aiSeats: !HUMAN_SEATS_ONLY,
  passwordRequired: !!CREATE_PASSWORD,
  sizeDefaults: SIZE_DEFAULTS,
}));

app.get('/api/game', async () =>
  session ? { gameId: session.id, phase: session.phase, seats: session.seats, round: session.state.round } : null,
);

app.post<{ Body: CreateGameRequest }>('/api/games', async (req, reply) => {
  const body = req.body;
  if (!passwordOk(body?.password)) return reply.code(403).send({ error: 'wrong game password' });
  const errs = body?.settings ? validateSettings(body.settings) : ['settings missing'];
  for (const p of PLAYERS) {
    const seat = body?.seats?.[p];
    if (!seat || (seat.type !== 'human' && seat.type !== 'relay' && seat.type !== 'ai')) errs.push(`seat ${p} invalid`);
    else if (seat.type === 'ai' && HUMAN_SEATS_ONLY) errs.push(`seat ${p}: AI seats are disabled on this server`);
    else if (seat.type === 'ai' && seat.agent !== 'bot' && !findPreset(seat.agent)) errs.push(`unknown agent ${seat.agent}`);
  }
  if (errs.length) return reply.code(400).send({ error: errs.join('; ') });

  if (session) await session.stop();
  // Attach display names (e.g. "Claude Opus") so every view can show which model plays which seat.
  for (const p of PLAYERS) {
    const seat = body.seats[p];
    if (seat.type === 'ai') seat.label = seat.agent === 'bot' ? 'bot' : (findPreset(seat.agent)?.label ?? seat.agent);
  }
  // aiPaceMs: pause between AI-only rounds, long enough for the GOD view to play each round's animation.
  const s = launch(new GameSession({ settings: body.settings, seats: body.seats, seed: body.seed }, { makeAi, logDir: join(ROOT, 'games'), aiPaceMs: 3500 }));

  const res: CreateGameResponse = { gameId: s.id, links: { god: `/god?k=${s.keys.god}` } };
  if (s.keys.p1) res.links.p1 = `/player1?k=${s.keys.p1}`;
  if (s.keys.p2) res.links.p2 = `/player2?k=${s.keys.p2}`;
  return res;
});

function launch(s: GameSession): GameSession {
  session = s;
  s.onChange(() => broadcast(s));
  void s.start();
  return s;
}

/** Rematch: same seats/settings/links. Open pages (seats and GOD) follow along to the new game. */
function rematch(old: GameSession): string | null {
  // Both players may click at once: the second click lands on the new game, which has not started yet.
  if (old.phase === 'starting' || old.phase === 'waiting') return null;
  if (old.phase !== 'finished') return 'the game is not over yet';
  const s = old.rematch();
  for (const c of clients.values()) if (c.gameId === old.id) c.gameId = s.id;
  launch(s);
  for (const c of clients.values()) if (c.gameId === s.id && c.role !== 'god') s.humanConnected(c.role);
  broadcast(s);
  return null;
}

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
  );
}

// --- WebSocket: one socket per seat or god view; each only ever receives its own filtered view. ---

type Role = PlayerId | 'god';
const clients = new Map<WebSocket, { role: Role; gameId: string }>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function updateFor(s: GameSession, role: Role): ServerMessage {
  return role === 'god' ? s.godUpdate() : s.seatUpdate(role);
}

function broadcast(s: GameSession): void {
  for (const [ws, c] of clients) if (c.gameId === s.id) send(ws, updateFor(s, c.role));
}

function authenticate(req: IncomingMessage): { role: Role; session: GameSession } | string {
  const url = new URL(req.url ?? '', 'http://x');
  const role = url.searchParams.get('seat') as Role | null;
  const key = url.searchParams.get('k');
  if (!session) return 'no game running';
  if (role !== 'p1' && role !== 'p2' && role !== 'god') return 'bad seat';
  const expected = session.keys[role];
  if (!expected || key !== expected) return 'invalid key for this seat';
  return { role, session };
}

const wss = new WebSocketServer({ noServer: true });
app.server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const auth = authenticate(req);
    if (typeof auth === 'string') {
      send(ws, { type: 'error', message: auth });
      ws.close();
      return;
    }
    const { role, session: s0 } = auth;
    clients.set(ws, { role, gameId: s0.id });
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (data) => {
      // The socket follows rematches, so act on the game it is attached to now (only if that is the live one).
      const s = session && clients.get(ws)?.gameId === session.id ? session : null;
      if (!s) return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return send(ws, { type: 'error', message: 'bad JSON' });
      }
      // GOD view only watches, except that it may start a rematch.
      if (role === 'god') {
        const err = msg.type === 'rematch' ? rematch(s) : null;
        if (err) send(ws, { type: 'error', message: err });
        return;
      }
      const err =
        msg.type === 'ping'
          ? null
          : msg.type === 'submit'
          ? s.submit(role, msg)
          : msg.type === 'chat'
            ? s.postChat(role, msg.text)
            : msg.type === 'relay'
              ? s.relaySubmit(role, msg.text)
              : msg.type === 'rematch'
                ? s.seats[role].type === 'ai'
                  ? 'AI seats cannot ask for a rematch'
                  : rematch(s)
                : 'unknown message';
      if (err) send(ws, { type: 'error', message: err });
    });
    send(ws, updateFor(s0, role));
    if (role !== 'god') s0.humanConnected(role);
  });
});

await app.listen({ port: PORT, host: HOST });
if (!HUMAN_SEATS_ONLY && !(await herdrAvailable())) app.log.warn('herdr server not reachable: herdr-backed AI players will fail. Built-in "bot" works.');

// Close agent panes/workspaces on shutdown so no orphaned agents keep running.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void (session?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
