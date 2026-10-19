import { useState } from 'react';
import { PLAYERS, type GameState, type GodUpdate, type Orders, type PlayerId, type RoundEvent, type SubmittedAction } from '@gold-war/engine';
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
          {state.result.winner
            ? `🏆 ${seatLabel(state.result.winner, msg.seats[state.result.winner])} wins`
            : `Draw: ${seatLabel('p1', msg.seats.p1)} vs ${seatLabel('p2', msg.seats.p2)}`}{' '}
          — {state.result.reason}
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
                  {seatLabel(p, msg.seats[p])} <span className="muted small">({ai.status})</span>
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
            <h3>Mines &amp; payouts</h3>
            <GodMinesPayout state={state} lastRound={msg.history.at(-1)?.round ?? null} events={msg.history.at(-1)?.events ?? []} />
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
    </div>
  );
}

/** All mines (god sees through fog) + last round's collects per seat, like the player view's table. */
function GodMinesPayout({ state, events, lastRound }: { state: GameState; events: RoundEvent[]; lastRound: number | null }) {
  const sum = (p: PlayerId, type: 'cost' | 'income') =>
    events.reduce((s, e) => s + (e.type === type && e.player === p ? e.amount : 0), 0);
  const collects = new Map<string, Extract<RoundEvent, { type: 'collect' }>>();
  for (const e of events) if (e.type === 'collect') collects.set(e.mineId, e);
  const knownBy = (id: string) => PLAYERS.filter((p) => state.players[p].knownMines[id] !== undefined);
  // Discovered by most seats first, then best payout.
  const mines = [...state.mines].sort(
    (a, b) => knownBy(b.id).length - knownBy(a.id).length || b.payout - a.payout || a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
  const cell = (c: Extract<RoundEvent, { type: 'collect' }> | undefined, p: PlayerId) =>
    c && c.workers[p] > 0 ? (
      <>
        <b className={c.gained[p] > 0 ? 'gold' : ''}>+{c.gained[p]}</b> <span className="muted">({c.workers[p]}w)</span>
      </>
    ) : (
      <span className="muted">—</span>
    );

  return (
    <div className="small">
      {lastRound !== null && (
        <div className="summary">
          {PLAYERS.map((p) => {
            const paid = sum(p, 'cost');
            const earned = sum(p, 'income');
            const net = earned - paid;
            const deleted = events.filter((e) => e.type === 'delete' && e.player === p).length;
            return (
              <div key={p} style={{ color: PLAYER_COLORS[p] }}>
                <b>{p.toUpperCase()}</b> (round {lastRound}): paid {paid}, earned {earned} → {net >= 0 ? '+' : ''}
                {net}
                {deleted > 0 && `, deleted ${deleted} worker${deleted > 1 ? 's' : ''}`}
              </div>
            );
          })}
        </div>
      )}
      <table className="mines">
        <thead>
          <tr>
            <th>Mine</th>
            <th>Pays</th>
            <th>Where</th>
            <th>Known by</th>
            {PLAYERS.map((p) => (
              <th key={p} style={{ color: PLAYER_COLORS[p] }}>
                {p.toUpperCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {mines.map((m) => {
            const c = collects.get(m.id);
            const by = knownBy(m.id);
            return (
              <tr key={m.id}>
                <td className="gold">{m.id}</td>
                <td>{m.payout}</td>
                <td>
                  ({m.x},{m.y})
                </td>
                <td>
                  {by.length ? (
                    by.map((p, i) => (
                      <span key={p} style={{ color: PLAYER_COLORS[p] }}>
                        {i > 0 && ', '}
                        {p.toUpperCase()} <span className="muted">r{state.players[p].knownMines[m.id]}</span>
                      </span>
                    ))
                  ) : (
                    <span className="muted">nobody</span>
                  )}
                </td>
                {PLAYERS.map((p) => (
                  <td key={p}>{cell(c, p)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {lastRound !== null && <p className="muted">P1 / P2 = gold from that mine last round (workers sent). rN = round discovered.</p>}
    </div>
  );
}
