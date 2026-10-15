import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
export const AGENT_ISOLATION: Record<string, string> = {
  claude: 'no shell / no web tools; file edits auto-accepted',
  codex: 'workspace-write sandbox, never asks approval (sandbox may still allow reads outside workdir)',
};

export const HERDR_AGENT_KINDS = ['claude', 'codex', 'grok', 'gemini', 'qwen', 'kimi', 'opencode', 'cursor', 'copilot', 'amp'];

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
 * AI player backed by an interactive CLI agent (claude, codex, grok, ...) running in its own herdr workspace.
 * I/O is file-based: the server writes state-N.json into the agent's private workdir and asks the agent to
 * write response-N.json. The terminal output is never parsed.
 */
export class HerdrAgentPlayer implements AiPlayer {
  private workdir = '';
  private workspaceId = '';
  private readonly name: string;

  constructor(
    readonly agent: string,
    private ctx: AiPlayerContext,
  ) {
    this.name = `gw-${ctx.gameId.slice(0, 8)}-${ctx.player}`;
  }

  async start(briefing: string): Promise<void> {
    // Separate random temp dirs per player: no shared parent the agents could browse.
    this.workdir = await mkdtemp(join(tmpdir(), 'gw-'));
    await writeFile(join(this.workdir, 'briefing.md'), briefing);

    const ws = await herdr(['workspace', 'create', '--cwd', this.workdir, '--label', `gold-war ${this.ctx.player} (${this.agent})`, '--no-focus']);
    this.workspaceId = pick(ws, 'result.workspace.workspace_id', 'result.workspace.id') ?? '';
    const pane = pick(ws, 'result.root_pane.pane_id', 'result.root_pane.id');
    if (!pane) throw new Error(`herdr workspace create returned no pane: ${JSON.stringify(ws).slice(0, 300)}`);

    await herdr(['agent', 'start', this.name, '--kind', this.agent, '--pane', pane, '--timeout', '120000', '--', ...agentArgs(this.agent)], 130_000);
    await this.prompt(
      'You are about to play a game. Read briefing.md in your current directory now; it has the full rules and the ' +
        'file-based protocol you must follow every round. Do not read anything else. Reply with just: READY',
      180_000,
    );
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
    if (this.workspaceId) await herdr(['workspace', 'close', this.workspaceId], 10_000).catch(() => {});
  }

  private async prompt(text: string, timeoutMs: number): Promise<void> {
    const res = await herdr(['agent', 'prompt', this.name, text, '--wait', '--timeout', String(Math.floor(timeoutMs))], timeoutMs + 5000);
    const status = pick(res, 'result.agent.status', 'result.status', 'result.state', 'result.agent.state');
    if (status === 'blocked') throw new Error('agent is blocked on an approval/question prompt');
  }
}
