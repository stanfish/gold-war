import { useEffect, useState } from 'react';
import { defaultSettings, type AgentOption, type CreateGameResponse, type PlayerId, type SeatConfig, type Settings } from '@gold-war/engine';

interface Meta {
  agents: AgentOption[];
  herdrAvailable: boolean;
  /** false on public hosting: only human and player-with-AI seats. */
  aiSeats: boolean;
  passwordRequired: boolean;
  sizeDefaults: Record<number, { mineCount: number; mineMin: number; mineMax: number; moveRange: number }>;
}

type Mode = 'pvp' | 'pva' | 'ava' | 'rva' | 'rvp' | 'rvr';

const MODES: { id: Mode; label: string; ai: boolean }[] = [
  { id: 'pvp', label: 'Player vs Player', ai: false },
  { id: 'pva', label: 'Player vs AI', ai: true },
  { id: 'ava', label: 'AI vs AI', ai: true },
  { id: 'rva', label: 'Player with AI vs AI', ai: true },
  { id: 'rvp', label: 'Player with AI vs Player', ai: false },
  { id: 'rvr', label: 'Player with AI vs Player with AI', ai: false },
];

const ROUND_COUNTS = [10, 20, 30, 40, 50];

export function SetupPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<Mode>('pva');
  const [agents, setAgents] = useState<Record<PlayerId, string>>({ p1: 'claude-opus', p2: 'claude-sonnet' });
  const [settings, setSettings] = useState<Settings>(defaultSettings(30));
  const [result, setResult] = useState<CreateGameResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    fetch('/api/meta')
      .then((r) => r.json())
      .then((m: Meta) => {
        setMeta(m);
        if (!m.aiSeats) setMode((cur) => (MODES.find((x) => x.id === cur)?.ai ? 'rvp' : cur));
      })
      .catch(() => setError('Server not reachable'));
  }, []);

  const sizeDef = meta?.sizeDefaults[settings.mapSize];
  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  const human: SeatConfig = { type: 'human' };
  const relay: SeatConfig = { type: 'relay' };
  const ai = (p: PlayerId): SeatConfig => ({ type: 'ai', agent: agents[p] });
  const seats: Record<PlayerId, SeatConfig> = {
    pvp: { p1: human, p2: human },
    pva: { p1: human, p2: ai('p2') },
    ava: { p1: ai('p1'), p2: ai('p2') },
    rva: { p1: relay, p2: ai('p2') },
    rvp: { p1: relay, p2: human },
    rvr: { p1: relay, p2: relay },
  }[mode];
  const hasRelay = Object.values(seats).some((s) => s.type === 'relay');

  const payoutInvalid = settings.payoutMin > settings.payoutMax;
  const usesHerdr = Object.values(seats).some((s) => s.type === 'ai' && s.agent !== 'bot');

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings, seats, ...(meta?.passwordRequired && { password }) }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? r.statusText);
      setResult(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const abs = (path: string) => `${location.origin}${path}`;

  const agentPicker = (p: PlayerId) => (
    <label>
      {p.toUpperCase()} agent
      <select value={agents[p]} onChange={(e) => setAgents({ ...agents, [p]: e.target.value })}>
        {(meta?.agents ?? []).map((a) => (
          <option key={a.id} value={a.id} disabled={!a.installed}>
            {a.label}
            {a.installed ? '' : ' (not installed)'}
          </option>
        ))}
      </select>
      {(() => {
        const iso = meta?.agents.find((a) => a.id === agents[p])?.isolation;
        return iso && <span className="muted small">{iso}</span>;
      })()}
    </label>
  );

  return (
    <div className="page setup">
      <h1>Gold War</h1>
      <p className="muted">Scout the fog, find gold, out-earn your opponent. 2 players, simultaneous rounds.</p>

      <div className="form">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {MODES.filter((m) => m.ai === false || meta?.aiSeats !== false).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {hasRelay && (
          <p className="muted small">
            Player with AI: each round the page shows one message to copy into any AI chat you like, then you paste the AI's reply
            back. Table talk is off in this mode; pick a long round timer.
          </p>
        )}
        {seats.p1.type === 'ai' && agentPicker('p1')}
        {seats.p2.type === 'ai' && agentPicker('p2')}

        <label>
          Map size
          <select
            value={settings.mapSize}
            onChange={(e) => {
              const size = Number(e.target.value);
              setSettings({ ...defaultSettings(size), roundSeconds: settings.roundSeconds, visionRadius: Math.min(settings.visionRadius, Math.floor(size / 2)), tableTalk: settings.tableTalk, fullRoundTimer: settings.fullRoundTimer, payoutMin: settings.payoutMin, payoutMax: settings.payoutMax, roundsTotal: settings.roundsTotal });
            }}
          >
            <option value={30}>30×30 (quick)</option>
            <option value={60}>60×60 (standard)</option>
          </select>
        </label>
        <label>
          Gold mines: <b>{settings.mineCount}</b>
          <input
            type="range"
            min={sizeDef?.mineMin ?? 1}
            max={sizeDef?.mineMax ?? 60}
            value={settings.mineCount}
            onChange={(e) => set({ mineCount: Number(e.target.value) })}
          />
        </label>
        <label>
          Move range: <b>{settings.moveRange}</b>
          <input type="range" min={1} max={Math.floor(settings.mapSize / 3)} value={settings.moveRange} onChange={(e) => set({ moveRange: Number(e.target.value) })} />
        </label>
        <label>
          Worker vision radius: <b>{settings.visionRadius}</b>{' '}
          <span className="muted small">
            (each worker sees {2 * settings.visionRadius + 1}×{2 * settings.visionRadius + 1} squares)
          </span>
          <input type="range" min={0} max={Math.min(10, Math.floor(settings.mapSize / 2))} value={settings.visionRadius} onChange={(e) => set({ visionRadius: Number(e.target.value) })} />
        </label>
        <div className="field">
          Gold mine payout (gold per round, random per mine)
          <div className="range-pair">
            <label className="row">
              min
              <input
                type="number"
                min={1}
                max={100}
                value={settings.payoutMin}
                onChange={(e) => {
                  set({ payoutMin: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))) });
                }}
              />
            </label>
            <label className="row">
              max
              <input
                type="number"
                min={1}
                max={100}
                value={settings.payoutMax}
                onChange={(e) => {
                  set({ payoutMax: Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))) });
                }}
              />
            </label>
          </div>
          {payoutInvalid && <span className="danger small">min must not be greater than max</span>}
        </div>
        <label>
          Rounds
          <select value={settings.roundsTotal} onChange={(e) => set({ roundsTotal: Number(e.target.value) })}>
            {ROUND_COUNTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Round timer
          <select value={settings.roundSeconds} onChange={(e) => set({ roundSeconds: Number(e.target.value) })}>
            <option value={60}>1 min</option>
            <option value={120}>2 min</option>
            <option value={180}>3 min</option>
            <option value={300}>5 min</option>
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.tableTalk && !hasRelay} disabled={hasRelay} onChange={(e) => set({ tableTalk: e.target.checked })} /> Table talk
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.fullRoundTimer} onChange={(e) => set({ fullRoundTimer: e.target.checked })} /> Rounds
          always last the full timer
        </label>
        {!settings.fullRoundTimer && <p className="muted small">A round ends as soon as both players have submitted.</p>}
        <p className="muted small">
          {settings.roundsTotal} rounds · {settings.startWorkers} workers · {settings.startGold} gold each · mine payout {settings.payoutMin}–
          {settings.payoutMax}
        </p>

        {usesHerdr && meta && !meta.herdrAvailable && (
          <p className="danger small">herdr server not reachable — CLI agents cannot be launched. Start herdr (run `herdr` in a terminal), or pick “bot”.</p>
        )}
        {meta?.passwordRequired && (
          <label>
            Game password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="needed to start a game" />
            <span className="muted small">Starting a game ends the one in progress, so this server asks for a password.</span>
          </label>
        )}
        <button className="primary" disabled={busy || payoutInvalid || (meta?.passwordRequired && !password)} onClick={create}>
          {busy ? 'Creating…' : 'Start game'}
        </button>
        {error && <p className="danger">{error}</p>}
      </div>

      {result && (
        <div className="links">
          <h3>Game {result.gameId} created</h3>
          <p className="muted small">Each player opens their own link (separate device or window). Keep links private.</p>
          {result.links.p1 && (
            <p>
              Player 1: <a href={result.links.p1} target="_blank" rel="noreferrer">{abs(result.links.p1)}</a>
            </p>
          )}
          {result.links.p2 && (
            <p>
              Player 2: <a href={result.links.p2} target="_blank" rel="noreferrer">{abs(result.links.p2)}</a>
            </p>
          )}
          <p>
            GOD view: <a href={result.links.god} target="_blank" rel="noreferrer">{abs(result.links.god)}</a>
          </p>
        </div>
      )}
    </div>
  );
}
