import { useEffect, useMemo, useState } from 'react';
import { RULES_VERSION, moveError, visibleCells, type PlayerId, type SeatUpdate, type SubmittedAction } from '@gold-war/engine';
import { MapCanvas, type MapUnit } from './MapCanvas';
import { ChatLog, Countdown, PLAYER_COLORS, describeEvent, seatLabel, useGameSocket } from './common';
import type { RoundEvent } from '@gold-war/engine';

type Draft = { action: 'MOVE'; dx: number; dy: number } | { action: 'COLLECT'; mine_id: string } | { action: 'STAY' } | { action: 'DELETE' };

const COST: Record<Draft['action'], number> = { MOVE: 1, COLLECT: 1, STAY: 0.5, DELETE: 0 };

type Dir = 'up' | 'down' | 'left' | 'right';
const DIRS: Record<Dir, { dx: number; dy: number; arrow: string }> = {
  up: { dx: 0, dy: -1, arrow: '↑' },
  down: { dx: 0, dy: 1, arrow: '↓' },
  left: { dx: -1, dy: 0, arrow: '←' },
  right: { dx: 1, dy: 0, arrow: '→' },
};

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
    // Exactly the squares the engine accepts (same moveError the server uses).
    const r = view.settings.move_range;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (moveError(selWorker, dx, dy, n, r) === null) out.add((selWorker.y + dy) * n + selWorker.x + dx);
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
  const range = view.settings.move_range;
  const collectable = view.known_mines.filter((m) => m.collectable);
  // Validate every order with the engine's own rules; invalid orders block submission.
  const orderError = (w: { x: number; y: number }, d: Draft | undefined): string | null => {
    if (d?.action === 'MOVE') {
      if (d.dx === 0 && d.dy === 0) return 'add at least one step (or click a highlighted square)';
      return moveError(w, d.dx, d.dy, n, range);
    }
    if (d?.action === 'COLLECT' && !collectable.some((m) => m.id === d.mine_id)) return `${d.mine_id} is not collectable`;
    return null;
  };
  const invalidOrders = view.workers.filter((w) => orderError(w, drafts[w.id]) !== null);
  // Page and server built from different rules: submitting could silently turn orders into STAY.
  const staleServer = msg.rulesVersion !== RULES_VERSION;
  const opp: PlayerId = seat === 'p1' ? 'p2' : 'p1';
  const setDraft = (id: string, d: Draft) => setDrafts((all) => ({ ...all, [id]: d }));

  const units: MapUnit[] = [
    ...view.workers.map((w) => {
      const d = drafts[w.id];
      return { key: w.id, x: w.x, y: w.y, color: PLAYER_COLORS[seat], label: w.id.slice(1), title: `your ${w.id}`, selected: w.id === selected && !!d };
    }),
    ...view.visible_enemy_workers.map((w, i) => ({ key: `e${i}`, x: w.x, y: w.y, color: PLAYER_COLORS[opp], title: 'enemy worker' })),
    ...(view.visible_enemy_workers.length === 0
      ? view.enemy_last_seen.map((w, i) => ({
          key: `s${i}`,
          x: w.x,
          y: w.y,
          color: PLAYER_COLORS[opp],
          stale: true,
          title: `enemy worker, last seen round ${w.round}`,
        }))
      : []),
  ];

  // Planned MOVE destinations as ghost markers.
  for (const w of view.workers) {
    const d = drafts[w.id];
    if (d?.action === 'MOVE' && (d.dx !== 0 || d.dy !== 0))
      units.push({
        key: `g${w.id}`,
        x: w.x + d.dx,
        y: w.y + d.dy,
        color: PLAYER_COLORS[seat],
        stale: true,
        label: w.id.slice(1),
        title: `${w.id} planned destination`,
      });
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
          mines={view.known_mines.map((m) => ({ ...m, dim: !m.collectable, note: m.collectable ? undefined : 'collectable next round' }))}
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
                      else if (v === 'MOVE') {
                        setSelected(w.id);
                        if (d.action !== 'MOVE') setDraft(w.id, { action: 'MOVE', dx: 0, dy: 0 });
                      } else setDraft(w.id, { action: v as 'STAY' | 'DELETE' });
                    }}
                  >
                    <option value="STAY">STAY (0.5)</option>
                    <option value="MOVE">MOVE (1)</option>
                    {collectable.map((m) => (
                      <option key={m.id} value={`COLLECT:${m.id}`}>
                        COLLECT {m.id} +{m.payout} (1)
                      </option>
                    ))}
                    <option value="DELETE">DELETE (0)</option>
                  </select>
                  {d.action === 'MOVE' && (
                    <MoveControls
                      draft={d}
                      disabled={!playing}
                      canGo={(dx, dy) => (dx === 0 && dy === 0) || moveError(w, dx, dy, n, range) === null}
                      range={range}
                      onChange={(dx, dy) => setDraft(w.id, { action: 'MOVE', dx, dy })}
                    />
                  )}
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
            {invalidOrders.map((w) => (
              <p key={w.id} className="danger small">
                {w.id}: {orderError(w, drafts[w.id])}
              </p>
            ))}
            {staleServer && (
              <p className="danger small">
                Server runs different rules than this page (v{msg.rulesVersion ?? '?'} vs v{RULES_VERSION}). Restart the server and
                start a new game.
              </p>
            )}
            <button
              className="primary"
              disabled={!playing || !affordable || invalidOrders.length > 0 || staleServer}
              onClick={submit}
            >
              {msg.mySubmission ? 'Resubmit orders' : 'Submit orders'}
            </button>
            {msg.mySubmission && <p className="muted small">Submitted — you can change orders until both players are in.</p>}
            <p className="muted small">Select a worker, then click a highlighted square to MOVE (or use the step buttons). Wheel/drag to zoom/pan.</p>
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
            <LastRound events={msg.lastEvents} seat={seat} />
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

/** Step buttons: each click adds one step; steps may mix directions up to the move range. */
function MoveControls(props: {
  draft: { dx: number; dy: number };
  disabled: boolean;
  range: number;
  canGo: (dx: number, dy: number) => boolean;
  onChange: (dx: number, dy: number) => void;
}) {
  const { dx, dy } = props.draft;
  const used = Math.abs(dx) + Math.abs(dy);
  const parts = [dy < 0 && `${-dy}↑`, dy > 0 && `${dy}↓`, dx < 0 && `${-dx}←`, dx > 0 && `${dx}→`].filter(Boolean);
  return (
    <div className="move-controls" onClick={(e) => e.stopPropagation()}>
      <span className="muted small">
        {parts.length ? parts.join(' ') : 'no steps'} · {used}/{props.range}
      </span>
      {(Object.keys(DIRS) as Dir[]).map((d) => {
        const nx = dx + DIRS[d].dx;
        const ny = dy + DIRS[d].dy;
        return (
          <button key={d} disabled={props.disabled || !props.canGo(nx, ny)} title={`step ${d}`} onClick={() => props.onChange(nx, ny)}>
            {DIRS[d].arrow}
          </button>
        );
      })}
      <button disabled={props.disabled || used === 0} title="clear steps" onClick={() => props.onChange(0, 0)}>
        ✕
      </button>
    </div>
  );
}

/** Last round, split into you / opponent / contests. Opponent side only has fog-safe totals. */
function LastRound({ events, seat }: { events: RoundEvent[]; seat: PlayerId }) {
  if (!events.length) return <div className="muted small">Nothing yet.</div>;
  const opp: PlayerId = seat === 'p1' ? 'p2' : 'p1';
  const sum = (p: PlayerId, type: 'cost' | 'income') =>
    events.reduce((s, e) => s + (e.type === type && e.player === p ? e.amount : 0), 0);
  const side = (p: PlayerId) => {
    const paid = sum(p, 'cost');
    const earned = sum(p, 'income');
    const net = earned - paid;
    return { paid, earned, net: `${net >= 0 ? '+' : ''}${net}` };
  };
  const mine = side(seat);
  const theirs = side(opp);
  const ownDetail = events.filter((e) => 'player' in e && e.player === seat && !['cost', 'income', 'move'].includes(e.type));
  const oppDeleted = events.filter((e) => e.type === 'delete' && e.player === opp).length;
  const contests = events.filter((e) => e.type === 'collect');
  const end = events.find((e) => e.type === 'end');
  return (
    <div className="events small">
      <div style={{ color: PLAYER_COLORS[seat] }}>
        <b>You</b>: paid {mine.paid}, earned {mine.earned} → <b>{mine.net}</b>
      </div>
      {ownDetail.map((e, i) => (
        <div key={i} className="indent">
          {describeEvent(e, seat)}
        </div>
      ))}
      <div style={{ color: PLAYER_COLORS[opp], marginTop: 6 }}>
        <b>Opponent</b>: paid {theirs.paid}, earned {theirs.earned} → <b>{theirs.net}</b>
        {oppDeleted > 0 && `, deleted ${oppDeleted} worker${oppDeleted > 1 ? 's' : ''}`}
      </div>
      {contests.length > 0 && <div style={{ marginTop: 6 }} className="muted">Your collects</div>}
      {contests.map((e, i) => (
        <div key={i} className="indent">
          {describeEvent(e, seat)}
        </div>
      ))}
      {end && <div style={{ marginTop: 6 }}>{describeEvent(end, seat)}</div>}
    </div>
  );
}
