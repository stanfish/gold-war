import { useState } from 'react';
import { PLAYERS, type GameState, type GodUpdate, type Orders, type PlayerId, type SubmittedAction } from '@gold-war/engine';
import { MapCanvas, type MapUnit } from './MapCanvas';
import { ChatLog, Countdown, PLAYER_COLORS, describeEvent, seatLabel, useGameSocket } from './common';

export function GodPage({ k }: { k: string | null }) {
  const { msg, error, connected } = useGameSocket<GodUpdate>('god', k);
  const [historyRound, setHistoryRound] = useState<number | null>(null);
  const [thinkRound, setThinkRound] = useState<Partial<Record<PlayerId, number>>>({});
  /** null = live orders of the open round. */
  const [ordersRound, setOrdersRound] = useState<number | null>(null);

  if (!msg) {
    return (
      <div className="page center">
        {error ? <p className="danger">{error}</p> : <p className="muted">{connected ? 'Loading…' : 'Connecting…'}</p>}
      </div>
    );
  }
  const { state } = msg;
  const n = state.settings.mapSize;

  const units: MapUnit[] = PLAYERS.flatMap((p) =>
    state.players[p].workers.map((w) => ({ key: `${p}${w.id}`, x: w.x, y: w.y, color: PLAYER_COLORS[p], label: w.id.slice(1), title: `${p} ${w.id}` })),
  );
  const mines = state.mines.map((m) => {
    const by = PLAYERS.filter((p) => state.players[p].knownMines[m.id] !== undefined);
    return { ...m, dim: by.length === 0, note: by.length ? `known by ${by.join(', ')}` : 'undiscovered' };
  });

  const shownRound = historyRound ?? msg.history.at(-1)?.round ?? null;
  const shownEvents = msg.history.find((h) => h.round === shownRound)?.events ?? [];

  return (
    <div className="page game">
      <header className="topbar">
        <b>GOD VIEW</b>
        <span>
          Round <b>{state.round}</b>/{state.settings.roundsTotal}
        </span>
        <span>
          ⏱ <Countdown deadline={msg.deadline} />
        </span>
        <span className="muted">
          {msg.phase}
          {msg.phaseDetail ? ` — ${msg.phaseDetail}` : ''}
        </span>
        {PLAYERS.map((p) => (
          <span key={p} style={{ color: PLAYER_COLORS[p] }}>
            {seatLabel(p, msg.seats[p])}: <b>{state.players[p].gold2 / 2}</b> gold · {state.players[p].workers.length} workers ·{' '}
            {Object.keys(state.players[p].knownMines).length} mines known {msg.submitted[p] ? '✓' : ''}
          </span>
        ))}
      </header>

      {state.result && (
        <div className="banner">
          {state.result.winner ? `${state.result.winner.toUpperCase()} wins` : 'Draw'} — {state.result.reason}
        </div>
      )}
      {msg.phase === 'error' && <div className="banner danger">{msg.phaseDetail}</div>}

      <main className="layout">
        <MapCanvas n={n} base={state.base} mines={mines} units={units} />

        <aside className="side">
          {PLAYERS.map((p) => {
            const ai = msg.ai[p];
            if (!ai) return null;
            const rounds = Object.keys(ai.thinking).map(Number).sort((a, b) => b - a);
            const r = thinkRound[p] ?? rounds[0];
            return (
              <section key={p}>
                <h3 style={{ color: PLAYER_COLORS[p] }}>
                  {p.toUpperCase()} AI · {ai.agent} <span className="muted small">({ai.status})</span>
                </h3>
                {ai.lastError && <p className="danger small">{ai.lastError}</p>}
                <h4>Notes</h4>
                <pre className="mono">{ai.notes || '—'}</pre>
                <h4>
                  Thinking{' '}
                  {rounds.length > 0 && (
                    <select value={r} onChange={(e) => setThinkRound({ ...thinkRound, [p]: Number(e.target.value) })}>
                      {rounds.map((x) => (
                        <option key={x} value={x}>
                          round {x}
                        </option>
                      ))}
                    </select>
                  )}
                </h4>
                <pre className="mono">{(r !== undefined && ai.thinking[r]) || '—'}</pre>
              </section>
            );
          })}

          <section>
            <h3>
              Orders{' '}
              <select value={ordersRound ?? ''} onChange={(e) => setOrdersRound(e.target.value ? Number(e.target.value) : null)}>
                <option value="">round {state.round} (live)</option>
                {[...msg.history].reverse().map((h) => (
                  <option key={h.round} value={h.round}>
                    round {h.round}
                  </option>
                ))}
              </select>
            </h3>
            {PLAYERS.map((p) => {
              const live = ordersRound === null;
              const orders = live ? msg.pending[p] : msg.history.find((h) => h.round === ordersRound)?.submissions[p];
              return (
                <OrdersList
                  key={p}
                  player={p}
                  orders={orders}
                  // Destinations only make sense against current positions.
                  state={live ? state : null}
                  waiting={live && msg.phase === 'playing' && state.status === 'active'}
                />
              );
            })}
          </section>

          <section>
            <h3>Table talk</h3>
            <ChatLog chat={msg.chat} />
          </section>

          <section>
            <h3>
              Events{' '}
              {msg.history.length > 0 && (
                <select value={shownRound ?? ''} onChange={(e) => setHistoryRound(Number(e.target.value))}>
                  {[...msg.history].reverse().map((h) => (
                    <option key={h.round} value={h.round}>
                      round {h.round}
                    </option>
                  ))}
                </select>
              )}
            </h3>
            <div className="events small">
              {shownEvents.map((e, i) => (
                <div key={i} style={{ color: 'player' in e ? PLAYER_COLORS[e.player] : undefined }}>
                  {describeEvent(e)}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h3>Mines</h3>
            <div className="small">
              {state.mines.map((m) => (
                <div key={m.id}>
                  {m.id} ({m.x},{m.y}) pays {m.payout} · known by{' '}
                  {PLAYERS.filter((p) => state.players[p].knownMines[m.id] !== undefined).join(', ') || 'nobody'}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </main>
    </div>
  );
}

function describeOrder(a: SubmittedAction, p: PlayerId, state: GameState | null): string {
  const w = state?.players[p].workers.find((x) => x.id === a.worker_id);
  switch (String(a.action).toUpperCase()) {
    case 'MOVE': {
      const dx = a.dx ?? (a.x !== undefined && w ? a.x - w.x : 0);
      const dy = a.dy ?? (a.y !== undefined && w ? a.y - w.y : 0);
      const steps = [dy < 0 && `${-dy}↑`, dy > 0 && `${dy}↓`, dx < 0 && `${-dx}←`, dx > 0 && `${dx}→`].filter(Boolean).join(' ');
      return `MOVE ${steps || '(no steps)'}${w ? ` (${w.x},${w.y}) → (${w.x + dx},${w.y + dy})` : ''}`;
    }
    case 'COLLECT': {
      const m = state?.mines.find((x) => x.id === a.mine_id);
      return `COLLECT ${a.mine_id}${m ? ` (+${m.payout})` : ''}`;
    }
    default:
      return String(a.action).toUpperCase();
  }
}

function OrdersList(props: { player: PlayerId; orders: Orders | undefined; state: GameState | null; waiting: boolean }) {
  const { player, orders } = props;
  return (
    <div className="small" style={{ marginBottom: 8 }}>
      <b style={{ color: PLAYER_COLORS[player] }}>{player.toUpperCase()}</b>{' '}
      {!orders && <span className="muted">{props.waiting ? 'not submitted yet' : 'no orders (all STAY)'}</span>}
      {orders && orders.actions.length === 0 && <span className="muted">empty submission (all STAY)</span>}
      {orders?.actions.map((a, i) => (
        <div key={i} className="indent">
          {a.worker_id}: {describeOrder(a, player, props.state)}
        </div>
      ))}
      {orders?.messages.map((m, i) => (
        <div key={`m${i}`} className="indent muted">
          💬 {m}
        </div>
      ))}
    </div>
  );
}
