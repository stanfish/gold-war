import { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYERS, type GameState, type GodUpdate, type Orders, type PlayerId, type RoundEvent, type SubmittedAction } from '@gold-war/engine';
import { ChatLog, PLAYER_COLORS, RematchButton, describeEvent, useGameSocket } from './common';
import { Arena } from './god/Arena';
import { CommentaryFeed } from './god/Commentary';
import { GoldChart } from './god/GoldChart';
import { GameOverCard, RoundBanner } from './god/Overlays';
import { ROUND_MS, buildTransition, gameStats, goldSeries, snapshotAfter, snapshotBefore, trails } from './god/replay';
import { Scoreboard, type SideInfo } from './god/Scoreboard';

export function GodPage({ k }: { k: string | null }) {
  const { msg, error, connected, send } = useGameSocket<GodUpdate>('god', k);
  const [thinkRound, setThinkRound] = useState<Partial<Record<PlayerId, number>>>({});
  /** null = live orders of the open round. */
  const [ordersRound, setOrdersRound] = useState<number | null>(null);
  /** Replay position: the resolved round whose result is shown. null = live (latest). */
  const [pos, setPos] = useState<number | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  /** Round currently animating on the arena (key restarts the animation). */
  const [anim, setAnim] = useState<{ round: number; key: string } | null>(null);
  const [vision, setVision] = useState<Record<PlayerId, boolean>>({ p1: false, p2: false });
  const [overOpen, setOverOpen] = useState(true);
  const [overReady, setOverReady] = useState(false);
  /** Mine hovered in the mines table, spotlighted on the map. */
  const [hoverMine, setHoverMine] = useState<string | null>(null);

  const gameId = msg?.gameId;
  const resolved = msg?.history.length ?? 0;
  const shown = pos ?? resolved;

  // New game (or rematch): back to live.
  useEffect(() => {
    setPos(null);
    setAutoplay(false);
    setAnim(null);
    setOverOpen(true);
    setOrdersRound(null);
  }, [gameId]);

  // Live: animate each round as it resolves.
  const seen = useRef<{ game?: string; n: number }>({ n: 0 });
  useEffect(() => {
    if (!gameId) return;
    const prev = seen.current;
    seen.current = { game: gameId, n: resolved };
    if (prev.game === gameId && resolved > prev.n && pos === null) setAnim({ round: resolved, key: `${gameId}:${resolved}:live` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, resolved]);

  // Game-over card waits for the final round's animation.
  const finished = msg?.phase === 'finished';
  useEffect(() => {
    setOverReady(false);
    if (!finished) return;
    const t = setTimeout(() => setOverReady(true), ROUND_MS + 300);
    return () => clearTimeout(t);
  }, [finished, gameId]);

  const jump = (r: number, animate = true) => {
    const target = Math.max(0, Math.min(resolved, r));
    setPos(target === resolved && !autoplay ? null : target);
    setAnim(animate && target > 0 ? { round: target, key: `${gameId}:${target}:${Date.now()}` } : null);
  };

  const onAnimDone = () => {
    if (!autoplay) return;
    if (shown >= resolved) {
      setAutoplay(false);
      setPos(null);
      return;
    }
    const next = shown + 1;
    setPos(next);
    setAnim({ round: next, key: `${gameId}:${next}:${Date.now()}` });
  };

  const transition = useMemo(
    () => (msg && anim && anim.round === shown ? buildTransition(msg, shown) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anim?.key, shown, resolved],
  );

  if (!msg) {
    return (
      <div className="page center">
        {error ? <p className="danger">{error}</p> : <p className="muted">{connected ? 'Loading…' : 'Connecting…'}</p>}
      </div>
    );
  }
  const { state } = msg;
  const n = state.settings.mapSize;
  const replaying = pos !== null;
  const snap = snapshotAfter(msg, shown);
  const before = snapshotBefore(msg, shown);
  const series = goldSeries(msg);
  const stats = gameStats(msg);

  const sides = {} as Record<PlayerId, SideInfo>;
  for (const p of PLAYERS) {
    const q: PlayerId = p === 'p1' ? 'p2' : 'p1';
    const gold = replaying ? snap.players[p].gold : state.players[p].gold2 / 2;
    const oppGold = replaying ? snap.players[q].gold : state.players[q].gold2 / 2;
    const panel = msg.ai[p];
    const thinkingRounds = panel ? Object.keys(panel.thinking).map(Number) : [];
    const bubbleRound = replaying ? shown : thinkingRounds.length ? Math.max(...thinkingRounds) : null;
    sides[p] = {
      gold,
      workers: replaying ? snap.players[p].workers.length : state.players[p].workers.length,
      startWorkers: state.settings.startWorkers,
      submitted: !replaying && msg.submitted[p],
      hideStatus: replaying,
      panel: replaying ? undefined : panel,
      bubble: (bubbleRound !== null && panel?.thinking[bubbleRound]) || null,
      delta: shown > 0 ? Math.round((snap.players[p].gold - before.players[p].gold) * 2) / 2 : null,
      leading: gold > oppGold,
    };
  }

  const lastEvents = msg.history.at(-1)?.events ?? [];

  return (
    <div className="page game god">
      <Scoreboard
        seats={msg.seats}
        sides={sides}
        round={replaying ? shown : state.round}
        roundsTotal={state.settings.roundsTotal}
        deadline={msg.deadline}
        phase={replaying ? `showing round ${shown} of ${resolved}` : msg.phase}
        phaseDetail={replaying ? null : msg.phaseDetail}
        gameNumber={msg.gameNumber}
        replaying={replaying}
      />
      {msg.phase === 'error' && <div className="banner danger">{msg.phaseDetail}</div>}

      <main className="layout god-layout">
        <div className="arena-col">
          <Arena
            n={n}
            seed={state.seed}
            base={state.base}
            mines={state.mines}
            payoutRange={[state.settings.payoutMin, state.settings.payoutMax]}
            snap={snap}
            transition={transition}
            animKey={anim?.key ?? `static:${shown}`}
            trails={trails(msg, shown)}
            vision={vision}
            visionRadius={state.settings.visionRadius}
            highlightMine={hoverMine}
            onAnimDone={onAnimDone}
          >
            {!replaying && msg.phase === 'playing' && <RoundBanner key={`${gameId}:${state.round}`} round={state.round} total={state.settings.roundsTotal} />}
            {!replaying && finished && state.result && overOpen && overReady && (
              <GameOverCard
                result={state.result}
                seats={msg.seats}
                gold={{ p1: state.players.p1.gold2 / 2, p2: state.players.p2.gold2 / 2 }}
                stats={stats}
                rounds={state.round}
                onClose={() => setOverOpen(false)}
                rematch={<RematchButton key={msg.gameId} send={send} />}
              />
            )}
          </Arena>

          <div className="replay-bar">
            <button title="start" onClick={() => jump(0, false)} disabled={shown === 0}>
              ⏮
            </button>
            <button title="previous round" onClick={() => jump(shown - 1)} disabled={shown <= 1}>
              ◀
            </button>
            <button
              title={autoplay ? 'pause' : 'play from here'}
              className={autoplay ? 'on' : ''}
              disabled={resolved === 0}
              onClick={() => {
                if (autoplay) return setAutoplay(false);
                const from = shown >= resolved ? 1 : shown + 1;
                setAutoplay(true);
                setPos(from);
                setAnim({ round: from, key: `${gameId}:${from}:${Date.now()}` });
              }}
            >
              {autoplay ? '⏸' : '▶'}
            </button>
            <button title="next round" onClick={() => jump(shown + 1)} disabled={shown >= resolved}>
              ▶|
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(1, resolved)}
              value={shown}
              disabled={resolved === 0}
              onChange={(e) => {
                setAutoplay(false);
                jump(Number(e.target.value), false);
              }}
            />
            <span className="small replay-label">{shown === 0 ? 'start' : `round ${shown}`}</span>
            <button className={replaying ? 'live-btn' : 'live-btn on'} onClick={() => (setAutoplay(false), setPos(null), setAnim(null))}>
              ● LIVE
            </button>
            <span className="vision-toggles small">
              Vision:
              {PLAYERS.map((p) => (
                <label key={p} style={{ color: PLAYER_COLORS[p] }}>
                  <input type="checkbox" checked={vision[p]} onChange={(e) => setVision({ ...vision, [p]: e.target.checked })} /> {p.toUpperCase()}
                </label>
              ))}
            </span>
            {finished && !overOpen && (
              <button className="small" onClick={() => setOverOpen(true)}>
                Show result
              </button>
            )}
            {finished && <RematchButton key={msg.gameId} send={send} />}
          </div>
        </div>

        <aside className="side">
          <section>
            <h3>Play-by-play</h3>
            <CommentaryFeed msg={msg} upTo={shown} onPick={(r) => (setAutoplay(false), jump(r))} />
          </section>

          <section>
            <h3>Gold over time</h3>
            <GoldChart series={series} roundsTotal={state.settings.roundsTotal} selected={replaying ? shown : null} onPick={(r) => (setAutoplay(false), jump(r))} />
          </section>

          <section>
            <h3>Mines &amp; payouts</h3>
            <GodMinesPayout state={state} lastRound={msg.history.at(-1)?.round ?? null} events={lastEvents} onHover={setHoverMine} />
          </section>

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

          {state.settings.tableTalk && (
            <section>
              <h3>Table talk</h3>
              <ChatLog chat={msg.chat} />
            </section>
          )}

          {PLAYERS.map((p) => {
            const ai = msg.ai[p];
            if (!ai) return null;
            const rounds = Object.keys(ai.thinking).map(Number).sort((a, b) => b - a);
            const r = thinkRound[p] ?? rounds[0];
            return (
              <details key={p} className="side-details">
                <summary>
                  <b style={{ color: PLAYER_COLORS[p] }}>{p.toUpperCase()} AI details</b> <span className="muted small">({ai.status})</span>
                </summary>
                {ai.lastError && <p className="danger small">{ai.lastError}</p>}
                <h4>Notes</h4>
                <pre className="mono">{ai.notes || '—'}</pre>
                <h4>
                  Rationale{' '}
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
              </details>
            );
          })}

          <details className="side-details">
            <summary>
              <b>Raw events</b> <span className="muted small">(round {shown || '—'})</span>
            </summary>
            <div className="events small">
              {(msg.history[shown - 1]?.events ?? []).map((e, i) => (
                <div key={i} style={{ color: 'player' in e ? PLAYER_COLORS[e.player] : undefined }}>
                  {describeEvent(e)}
                </div>
              ))}
            </div>
          </details>
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
function GodMinesPayout({
  state,
  events,
  lastRound,
  onHover,
}: {
  state: GameState;
  events: RoundEvent[];
  lastRound: number | null;
  onHover?: (mineId: string | null) => void;
}) {
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
              <tr key={m.id} className="hoverable" onMouseEnter={() => onHover?.(m.id)} onMouseLeave={() => onHover?.(null)}>
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
