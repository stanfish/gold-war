import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAiResponse, type AiResponse } from './parse.js';
import type { AiPlayer, AiPlayerContext, AiRoundInput } from './types.js';

/**
 * Locked-down launch args per agent kind. The goal is: the agent can read/write files in its own
 * workdir and nothing else (no shell, so no `herdr` socket access, no peeking at the other agent).
 * Override any kind with env GOLDWAR_AGENT_ARGS_<KIND>='["--flag","value"]'.
 */
const DEFAULT_AGENT_ARGS: Record<string, string[]> = {
  claude: ['--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Task'],
  codex: ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
};

/** Isolation status per kind, surfaced in the setup UI. */
const KIND_ISOLATION: Record<string, string> = {
  claude: 'no shell / no web tools; file edits auto-accepted',
  codex: 'workspace-write sandbox, never asks approval (sandbox may still allow reads outside workdir)',
};

/** A selectable AI: a herdr agent kind plus optional extra CLI args (e.g. the model). */
export interface AgentPreset {
  id: string;
  label: string;
  kind: string;
  extraArgs: string[];
}

const OTHER_KINDS = ['codex', 'grok', 'gemini', 'qwen', 'kimi', 'opencode', 'cursor', 'copilot', 'amp'];

export const AGENT_PRESETS: AgentPreset[] = [
  { id: 'claude-opus', label: 'Claude Opus', kind: 'claude', extraArgs: ['--model', 'opus'] },
  { id: 'claude-sonnet', label: 'Claude Sonnet', kind: 'claude', extraArgs: ['--model', 'sonnet'] },
  ...OTHER_KINDS.map((k) => ({ id: k, label: k, kind: k, extraArgs: [] })),
];

export function findPreset(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id);
}

export function presetIsolation(id: string): string | undefined {
  const p = findPreset(id);
  return p && KIND_ISOLATION[p.kind];
}

/** Agent CLIs found on PATH (by kind). */
export async function installedKinds(): Promise<Set<string>> {
  const kinds = [...new Set(AGENT_PRESETS.map((p) => p.kind))];
  const found = await Promise.all(
    kinds.map((k) => new Promise<boolean>((resolve) => execFile('which', [k], (err) => resolve(!err)))),
  );
  return new Set(kinds.filter((_, i) => found[i]));
}

export function agentArgs(kind: string): string[] {
  const override = process.env[`GOLDWAR_AGENT_ARGS_${kind.toUpperCase()}`];
  if (override) {
    const parsed: unknown = JSON.parse(override);
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string'))
      throw new Error(`GOLDWAR_AGENT_ARGS_${kind.toUpperCase()} must be a JSON string array`);
    return parsed;
  }
  return DEFAULT_AGENT_ARGS[kind] ?? [];
}

interface HerdrResult {
  result?: Record<string, unknown>;
  [k: string]: unknown;
}

function herdr(args: string[], timeoutMs = 60_000): Promise<HerdrResult> {
  return new Promise((resolve, reject) => {
    execFile('herdr', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message).trim().slice(0, 500);
        reject(new Error(`herdr ${args[0]} ${args[1] ?? ''} failed: ${detail}`));
        return;
      }
      try {
        resolve(stdout.trim() ? (JSON.parse(stdout) as HerdrResult) : {});
      } catch {
        resolve({ raw: stdout });
      }
    });
  });
}

/** True when the herdr CLI can reach a running herdr server. */
export async function herdrAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('herdr', ['status', 'server'], { timeout: 5000 }, (err, stdout) => resolve(!err && /status:\s*running/.test(stdout)));
  });
}

/** Find the first string value at any of the given dotted paths. */
function pick(obj: unknown, ...paths: string[]): string | undefined {
  for (const p of paths) {
    let cur: unknown = obj;
    for (const key of p.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined;
    if (typeof cur === 'string') return cur;
  }
  return undefined;
}

/**
 * One herdr workspace per game, with every AI agent in its own pane, side by side (p1 left, p2 right).
 * Pane claims are chained so they happen in seat order. The workspace's initial root pane is closed after the
 * first split, so only agent panes remain.
 */
interface Table {
  workspaceId: string;
  /** Pane the next agent pane splits from. */
  anchor: string;
  rootPane: string | null;
}
const tables = new Map<string, Promise<Table>>();

function claimPane(gameId: string, cwd: string): Promise<{ workspaceId: string; paneId: string }> {
  const prev =
    tables.get(gameId) ??
    herdr(['workspace', 'create', '--cwd', tmpdir(), '--label', `gold-war ${gameId.slice(0, 8)}`, '--no-focus']).then((ws) => {
      const workspaceId = pick(ws, 'result.workspace.workspace_id', 'result.workspace.id');
      const root = pick(ws, 'result.root_pane.pane_id', 'result.root_pane.id');
      if (!workspaceId || !root) throw new Error(`herdr workspace create returned no pane: ${JSON.stringify(ws).slice(0, 300)}`);
      return { workspaceId, anchor: root, rootPane: root };
    });
  const next = prev.then(async (t) => {
    const res = await herdr(['pane', 'split', '--pane', t.anchor, '--direction', 'right', '--cwd', cwd, '--no-focus']);
    const paneId = pick(res, 'result.pane.pane_id', 'result.pane.id');
    if (!paneId) throw new Error(`herdr pane split returned no pane: ${JSON.stringify(res).slice(0, 300)}`);
    if (t.rootPane) await herdr(['pane', 'close', t.rootPane]).catch(() => {});
    return { workspaceId: t.workspaceId, anchor: paneId, rootPane: null, paneId };
  });
  tables.set(gameId, next);
  return next;
}

async function closeTable(gameId: string): Promise<void> {
  const t = tables.get(gameId);
  if (!t) return;
  tables.delete(gameId);
  const { workspaceId } = await t.catch(() => ({ workspaceId: '' }));
  if (workspaceId) await herdr(['workspace', 'close', workspaceId], 10_000).catch(() => {});
}

/**
 * AI player backed by an interactive CLI agent (claude, codex, grok, ...) running in its own herdr workspace.
 * I/O is file-based: the server writes state-N.json into the agent's private workdir and asks the agent to
 * write response-N.json. The terminal output is never parsed.
 */
export class HerdrAgentPlayer implements AiPlayer {
  private workdir = '';
  private readonly name: string;

  private readonly preset: AgentPreset;

  constructor(
    readonly agent: string,
    private ctx: AiPlayerContext,
  ) {
    const preset = findPreset(agent);
    if (!preset) throw new Error(`unknown agent ${agent}`);
    this.preset = preset;
    this.name = `gw-${ctx.gameId.slice(0, 8)}-${ctx.player}`;
  }

  async start(briefing: string): Promise<void> {
    // Separate random temp dirs per player: no shared parent the agents could browse.
    // Sync on purpose: the session starts p1 then p2, so pane claims happen in seat order (p1 left).
    this.workdir = mkdtempSync(join(tmpdir(), 'gw-'));
    writeFileSync(join(this.workdir, 'briefing.md'), briefing);

    const { paneId: pane } = await claimPane(this.ctx.gameId, this.workdir);
    await herdr(['pane', 'rename', pane, `${this.ctx.player} · ${this.preset.label}`]).catch(() => {});

    const startArgs = ['agent', 'start', this.name, '--kind', this.preset.kind, '--pane', pane, '--timeout', '120000', '--', ...this.preset.extraArgs, ...agentArgs(this.preset.kind)];
    for (let attempt = 0; ; attempt++) {
      try {
        await herdr(startArgs, 130_000);
        break;
      } catch (e) {
        const msg = (e as Error).message;
        // Fresh pane whose shell is still loading its rc files: wait and retry (up to ~30s).
        if (/agent_pane_busy/.test(msg) && attempt < 30) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        // Blocked during startup: usually the "trust this folder?" dialog for the fresh workdir.
        if (/agent_not_ready|blocked/.test(msg)) break;
        throw e;
      }
    }
    await this.passStartupDialogs();
    await this.prompt(
      'You are about to play a game. Read briefing.md in your current directory now; it has the full rules and the ' +
        'file-based protocol you must follow every round. Do not read anything else. Reply with just: READY',
      180_000,
    );
  }

  /**
   * Accept the workspace-trust dialog some agents show for a new folder. The folder is a temp dir this server
   * just created containing only briefing.md, so trusting it is safe. Any other blocking prompt is an error.
   */
  private async passStartupDialogs(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const res = await herdr(['agent', 'wait', this.name, '--timeout', '60000'], 65_000);
      if (pick(res, 'result.agent.agent_status', 'result.agent_status', 'result.agent.status', 'result.status') !== 'blocked') return;
      const screen = JSON.stringify(await herdr(['agent', 'read', this.name, '--source', 'visible']));
      if (/trust (this|the) (folder|directory|files)/i.test(screen)) {
        await herdr(['agent', 'send-keys', this.name, 'down', 'enter']);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw new Error(`agent blocked at startup: ${screen.slice(-300)}`);
    }
    throw new Error('agent still blocked after startup dialogs');
  }

  async decide(input: AiRoundInput, deadline: number): Promise<AiResponse> {
    const r = input.round;
    const stateFile = `state-${r}.json`;
    const responseFile = `response-${r}.json`;
    await writeFile(join(this.workdir, stateFile), JSON.stringify(input, null, 2));
    await rm(join(this.workdir, responseFile), { force: true });

    let lastErr: Error = new Error('no attempt made');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const remaining = deadline - Date.now() - 1500;
      if (remaining < 10_000) break;
      try {
        await this.prompt(
          attempt === 1
            ? `Round ${r}: read ${stateFile}, decide, then write ONLY the response JSON to ${responseFile} (format in briefing.md). Every worker needs one action; keep the set affordable.`
            : `Your previous answer for round ${r} was rejected: ${lastErr.message}. Rewrite ${responseFile} with valid JSON exactly in the briefing.md format.`,
          remaining,
        );
        const raw = await readFile(join(this.workdir, responseFile), 'utf8').catch(() => {
          throw new Error(`${responseFile} was not written`);
        });
        return parseAiResponse(raw);
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr;
  }

  async cancel(): Promise<void> {
    await herdr(['agent', 'send-keys', this.name, 'esc'], 10_000).catch(() => {});
  }

  async stop(): Promise<void> {
    await closeTable(this.ctx.gameId);
  }

  private async prompt(text: string, timeoutMs: number): Promise<void> {
    const res = await herdr(['agent', 'prompt', this.name, text, '--wait', '--timeout', String(Math.floor(timeoutMs))], timeoutMs + 5000);
    const status = pick(res, 'result.agent.agent_status', 'result.agent_status', 'result.agent.status', 'result.status');
    if (status === 'blocked') throw new Error('agent is blocked on an approval/question prompt');
  }
}
