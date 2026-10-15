import { useEffect, useMemo, useState } from 'react';
import { visibleCells, type PlayerId, type SeatUpdate, type SubmittedAction } from '@gold-war/engine';
import { MapCanvas, type MapUnit } from './MapCanvas';
import { ChatLog, Countdown, PLAYER_COLORS, describeEvent, seatLabel, useGameSocket } from './common';

type Draft = { action: 'MOVE'; dx: number; dy: number } | { action: 'COLLECT'; mine_id: string } | { action: 'STAY' } | { action: 'DELETE' };

const COST: Record<Draft['action'], number> = { MOVE: 1, COLLECT: 1, STAY: 0.5, DELETE: 0 };

export function PlayerPage({ seat, k }: { seat: PlayerId; k: string | null }) {
  const { msg, error, connected, send } = useGameSocket<SeatUpdate>(seat, k);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>(['']);
  const round = msg?.view.round;

  // New round: reset drafts to STAY.
  useEffect(() => {
    if (!msg) return;
    setDrafts(Object.fromEntries(msg.view.workers.map((w) => [w.id, { action: 'STAY' } as Draft])));
    setSelected(msg.view.workers[0]?.id ?? null);
    setMessages(['']);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, msg?.gameId]);

  const view = msg?.view;
  const n = view?.settings.map_size ?? 30;
  const visible = useMemo(() => (view ? visibleCells(n, view.workers) : new Set<number>()), [view, n]);
  const selWorker = view?.workers.find((w) => w.id === selected);

  const moveTargets = useMemo(() => {
    const out = new Set<number>();
    if (!selWorker || !view) return out;
    const r = view.settings.move_range;
    for (let d = 1; d <= r; d++) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]] as const) {
        const x = selWorker.x + dx;
        const y = selWorker.y + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) out.add(y * n + x);
      }
    }
    return out;
  }, [selWorker, view, n]);

  if (!msg || !view) {
    return (
      <div className="page center">
        {error ? <p className="danger">{error}</p> : <p className="muted">{connected ? 'Loading…' : 'Connecting…'}</p>}
      </div>
    );
  }

  const playing = msg.phase === 'playing' && view.status === 'active' && msg.deadline !== null;
  const total = view.workers.reduce((s, w) => s + COST[drafts[w.id]?.action ?? 'STAY'], 0);
  const affordable = total <= view.gold;
  const collectable = view.known_mines.filter((m) => m.collectable);
  const opp: PlayerId = seat === 'p1' ? 'p2' : 'p1';
  const setDraft = (id: string, d: Draft) => setDrafts((all) => ({ ...all, [id]: d }));

  const units: MapUnit[] = [
    ...view.workers.map((w) => {
      const d = drafts[w.id];
      return { key: w.id, x: w.x, y: w.y, color: PLAYER_COLORS[seat], label: w.id.slice(1), selected: w.id === selected && !!d };
    }),
    ...view.visible_enemy_workers.map((w, i) => ({ key: `e${i}`, x: w.x, y: w.y, color: PLAYER_COLORS[opp] })),
    ...(view.visible_enemy_workers.length === 0
      ? view.enemy_last_seen.map((w, i) => ({ key: `s${i}`, x: w.x, y: w.y, color: PLAYER_COLORS[opp], stale: true }))
      : []),
  ];

  // Planned MOVE destinations as ghost markers.
  for (const w of view.workers) {
    const d = drafts[w.id];
    if (d?.action === 'MOVE')
      units.push({ key: `g${w.id}`, x: w.x + d.dx, y: w.y + d.dy, color: PLAYER_COLORS[seat], stale: true, label: w.id.slice(1) });
  }

  const onCellClick = (x: number, y: number) => {
    // Clicking own worker selects it; clicking a valid target plans a MOVE for the selected worker.
    const hit = view.workers.find((w) => w.x === x && w.y === y && w.id !== selected);
    if (playing && selWorker && moveTargets.has(y * n + x)) {
      setDraft(selWorker.id, { action: 'MOVE', dx: x - selWorker.x, dy: y - selWorker.y });
      return;
    }
    if (hit) setSelected(hit.id);
  };

  const submit = () => {
    const actions: SubmittedAction[] = view.workers.map((w) => ({ worker_id: w.id, ...(drafts[w.id] ?? { action: 'STAY' }) }));
    send({ type: 'submit', actions, messages: messages.filter((m) => m.trim()) });
  };

  return (
    <div className="page game">
      <header className="topbar">
        <b style={{ color: PLAYER_COLORS[seat] }}>{seatLabel(seat, msg.seats[seat])}</b>
        <span>
          Round <b>{view.round}</b>/{view.rounds_total}
        </span>
        <span>
          ⏱ <Countdown deadline={msg.deadline} />
        </span>
        <span>
          You: <b>{view.gold}</b> gold · {view.workers.length} workers
        </span>
        <span style={{ color: PLAYER_COLORS[opp] }}>
          {seatLabel(opp, msg.seats[opp])}: <b>{view.opponent.gold}</b> gold · {view.opponent.workers} workers
        </span>
        <span className="muted">{msg.submitted[opp] ? 'opponent submitted' : 'opponent deciding'}</span>
      </header>

      {view.result && (
        <div className="banner">
          {view.result.winner ? (view.result.winner === seat ? '🏆 You win' : 'You lose') : 'Draw'} — {view.result.reason}
        </div>
      )}
      {msg.phase === 'waiting' || msg.phase === 'starting' ? <div className="banner muted">{msg.phaseDetail}</div> : null}
      {msg.phase === 'error' && <div className="banner danger">{msg.phaseDetail}</div>}

      <main className="layout">
        <MapCanvas
          n={n}
          base={view.base}
          explored={view.explored}
          visible={visible}
          mines={view.known_mines.map((m) => ({ ...m, dim: !m.collectable }))}
          units={units}
          highlight={playing ? moveTargets : undefined}
          onCellClick={onCellClick}
        />

        <aside className="side">
          <section>
            <h3>Orders</h3>
            {view.workers.length === 0 && <p className="muted">No workers left.</p>}
            {view.workers.map((w) => {
              const d = drafts[w.id] ?? { action: 'STAY' };
              return (
                <div key={w.id} className={`worker-row ${w.id === selected ? 'sel' : ''}`} onClick={() => setSelected(w.id)}>
                  <span className="wid">
                    {w.id} <span className="muted">({w.x},{w.y})</span>
                  </span>
                  <select
                    disabled={!playing}
                    value={d.action === 'COLLECT' ? `COLLECT:${d.mine_id}` : d.action}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith('COLLECT:')) setDraft(w.id, { action: 'COLLECT', mine_id: v.slice(8) });
                      else if (v === 'MOVE') setSelected(w.id);
                      else setDraft(w.id, { action: v as 'STAY' | 'DELETE' });
                    }}
                  >
                    <option value="STAY">STAY (0.5)</option>
                    {d.action === 'MOVE' ? (
                      <option value="MOVE">
                        MOVE {d.dx !== 0 ? `dx ${d.dx}` : `dy ${d.dy}`} (1)
                      </option>
                    ) : (
                      <option value="MOVE">MOVE… click map (1)</option>
                    )}
                    {collectable.map((m) => (
                      <option key={m.id} value={`COLLECT:${m.id}`}>
                        COLLECT {m.id} +{m.payout} (1)
                      </option>
                    ))}
                    <option value="DELETE">DELETE (0)</option>
                  </select>
                </div>
              );
            })}
            <div className={`cost ${affordable ? '' : 'danger'}`}>
              Cost {total} / {view.gold} gold {affordable ? '' : '— not affordable'}
            </div>
            {view.settings.table_talk && (
              <div className="talk">
                {messages.map((m, i) => (
                  <input
                    key={i}
                    maxLength={200}
                    placeholder="Message to opponent (optional)"
                    value={m}
                    disabled={!playing}
                    onChange={(e) => {
                      const next = [...messages];
                      next[i] = e.target.value;
                      if (i === next.length - 1 && e.target.value && next.length < 3) next.push('');
                      setMessages(next);
                    }}
                  />
                ))}
              </div>
            )}
            <button className="primary" disabled={!playing || !affordable} onClick={submit}>
              {msg.mySubmission ? 'Resubmit orders' : 'Submit orders'}
            </button>
            {msg.mySubmission && <p className="muted small">Submitted — you can change orders until both players are in.</p>}
            <p className="muted small">Select a worker, then click a highlighted square to MOVE. Wheel/drag to zoom/pan.</p>
          </section>

          <section>
            <h3>Known mines</h3>
            {view.known_mines.length === 0 && <p className="muted small">None yet. Explore!</p>}
            <div className="small">
              {view.known_mines.map((m) => (
                <div key={m.id}>
                  {m.id} at ({m.x},{m.y}) pays <b>{m.payout}</b> {m.collectable ? '' : <span className="muted">(next round)</span>}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>Last round</h3>
            <div className="events small">
              {msg.lastEvents.filter((e) => e.type !== 'move').map((e, i) => (
                <div key={i}>{describeEvent(e, seat)}</div>
              ))}
            </div>
          </section>

          {view.settings.table_talk && (
            <section>
              <h3>Table talk</h3>
              <ChatLog chat={msg.chat} me={seat} />
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
