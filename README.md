# Gold War (v0.1)

2-player simultaneous-turn strategy game on a fog-of-war grid. Scout, find gold mines, out-earn your opponent.
Modes: Player vs Player, Player vs AI, AI vs AI. AI players are CLI coding agents (claude, codex, grok, …) run in
[herdr](https://herdr.dev) panes, or the built-in scripted `bot`.

## Run

```bash
pnpm install
pnpm build        # build the web UI
pnpm start        # server on http://127.0.0.1:8787 (serves the UI)
```

Open http://127.0.0.1:8787, pick settings, **Start game**, then open the generated links:
`/player1?k=…`, `/player2?k=…` (one per human, separate windows/devices) and `/god?k=…` (spectator / debug).

Dev mode with hot reload: `pnpm -C packages/server dev` and `pnpm -C packages/web dev` (Vite on :5173 proxies to :8787).

**Player with AI** modes: that seat's link shows one message per round (round 1 includes the rules) to copy into any AI chat outside the game; paste the AI's JSON reply back and it becomes your orders. Table talk is forced off when any seat uses this mode.

Play from other machines on your LAN: prefix with `HOST=0.0.0.0` (e.g. `HOST=0.0.0.0 pnpm start`), then open the links via this machine's IP, e.g. `http://<lan-ip>:8787/player1?k=…`. Default binds loopback only. Note: game creation has no auth, so anyone on the network can start a new game.

### CLI agents (herdr)

Start the server **from inside a herdr pane** (`HERDR_ENV=1`). For each AI seat the server:
1. creates a private temp workdir + its own herdr workspace,
2. `herdr agent start --kind <kind>` with locked-down args (claude: no Bash/web tools; codex: workspace-write sandbox).
   Presets live in `AGENT_PRESETS` (`packages/server/src/ai/herdr.ts`): **Claude Opus** / **Claude Sonnet** = `claude --model opus|sonnet`,
3. writes `briefing.md`, then each round `state-N.json`, and prompts the agent to write `response-N.json`.

All agents of a game share one herdr workspace (`gold-war <id>`, p1 left, p2 right), focused automatically when the game starts (`GOLDWAR_HERDR_FOCUS=0` disables). Watch it by running `herdr` in another terminal.

Override launch args per kind: `GOLDWAR_AGENT_ARGS_CLAUDE='["--model","opus","--permission-mode","acceptEdits","--disallowedTools","Bash"]'`.

Isolation is enforced by each agent's own tool restrictions; agents given shell access could read outside their workdir.

## Layout

- `packages/engine` — pure, deterministic rules (`createGame`, `resolveRound`, `aiState`/`playerView`, briefing, scripted bot). Gold stored in half-units.
- `packages/server` — Fastify + WebSocket. `GameSession` runs the round loop/timer, relays chat, writes `games/<id>.json`. Each socket only gets its own filtered view.
- `packages/web` — React + canvas map (zoom/pan). Setup, player and GOD views.

## Test

```bash
pnpm test                          # engine rules + server session tests
pnpm sim 200 30                    # 200 bot-vs-bot games on 30x30, checks invariants
pnpm typecheck
```

## Rule decisions beyond spec v0.1

- No LLM orchestrator: the server orchestrates deterministically.
- Missing/failed actions (human timeout or AI failure) → STAY (DELETE if STAY unaffordable).
- 0 workers loses unless both players have 0 workers (then more gold wins).
- Table talk is real-time (separate from orders); an AI gets up to 2 extra turns per round to answer messages.
- Invalid actions are converted to STAY *before* the affordability check.
- MOVE = up to N orthogonal steps in any mix of directions (destination within Manhattan distance N).
- Vision uses final positions only; squares passed through during a MOVE are not revealed.
