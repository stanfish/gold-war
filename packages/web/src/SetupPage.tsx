import { useEffect, useState } from 'react';
import { defaultSettings, type CreateGameResponse, type PlayerId, type SeatConfig, type Settings } from '@gold-war/engine';

interface Meta {
  agents: string[];
  isolation: Record<string, string>;
  herdrAvailable: boolean;
  sizeDefaults: Record<number, { mineCount: number; mineMin: number; mineMax: number; moveRange: number }>;
}

type Mode = 'pvp' | 'pva' | 'ava';

export function SetupPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [mode, setMode] = useState<Mode>('pva');
  const [agents, setAgents] = useState<Record<PlayerId, string>>({ p1: 'claude', p2: 'bot' });
  const [settings, setSettings] = useState<Settings>(defaultSettings(30));
  const [result, setResult] = useState<CreateGameResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/meta')
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setError('Server not reachable'));
  }, []);

  const sizeDef = meta?.sizeDefaults[settings.mapSize];
  const set = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  const seats: Record<PlayerId, SeatConfig> =
    mode === 'pvp'
      ? { p1: { type: 'human' }, p2: { type: 'human' } }
      : mode === 'pva'
        ? { p1: { type: 'human' }, p2: { type: 'ai', agent: agents.p2 } }
        : { p1: { type: 'ai', agent: agents.p1 }, p2: { type: 'ai', agent: agents.p2 } };

  const usesHerdr = Object.values(seats).some((s) => s.type === 'ai' && s.agent !== 'bot');

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings, seats }),
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
        {(meta?.agents ?? ['bot']).map((a) => (
          <option key={a} value={a}>
            {a === 'bot' ? 'bot (built-in scripted)' : a}
          </option>
        ))}
      </select>
      {meta?.isolation[agents[p]] && <span className="muted small">{meta.isolation[agents[p]]}</span>}
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
            <option value="pvp">Player vs Player</option>
            <option value="pva">Player vs AI</option>
            <option value="ava">AI vs AI</option>
          </select>
        </label>
        {mode === 'ava' && agentPicker('p1')}
        {mode !== 'pvp' && agentPicker('p2')}

        <label>
          Map size
          <select
            value={settings.mapSize}
            onChange={(e) => {
              const size = Number(e.target.value);
              setSettings({ ...defaultSettings(size), roundSeconds: settings.roundSeconds, tableTalk: settings.tableTalk });
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
          Round timer
          <select value={settings.roundSeconds} onChange={(e) => set({ roundSeconds: Number(e.target.value) })}>
            <option value={60}>1 min</option>
            <option value={120}>2 min</option>
            <option value={180}>3 min</option>
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={settings.tableTalk} onChange={(e) => set({ tableTalk: e.target.checked })} /> Table talk
        </label>
        <p className="muted small">
          {settings.roundsTotal} rounds · {settings.startWorkers} workers · {settings.startGold} gold each · mine payout {settings.payoutMin}–
          {settings.payoutMax}
        </p>

        {usesHerdr && meta && !meta.herdrAvailable && (
          <p className="danger small">herdr server not reachable — CLI agents cannot be launched. Start herdr (run `herdr` in a terminal), or pick “bot”.</p>
        )}
        <button className="primary" disabled={busy} onClick={create}>
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
