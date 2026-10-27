import { useEffect, useRef } from 'react';
import { PLAYERS, type GameResult, type PlayerId, type SeatConfig } from '@gold-war/engine';
import { PLAYER_COLORS, seatLabel } from '../common';
import type { PlayerStats } from './replay';
import { Avatar } from './Scoreboard';

/** "ROUND 7" splash when a new round opens (keyed by round so it replays each time). */
export function RoundBanner({ round, total }: { round: number; total: number }) {
  const final = round === total;
  return (
    <div key={round} className={`round-banner${final ? ' final' : ''}`}>
      {final ? 'FINAL ROUND' : `ROUND ${round}`}
    </div>
  );
}

function Confetti({ colors }: { colors: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const w = (c.width = c.offsetWidth);
    const h = (c.height = c.offsetHeight);
    const g = c.getContext('2d')!;
    const bits = Array.from({ length: 140 }, (_, i) => ({
      x: Math.random() * w,
      y: -Math.random() * h * 0.6,
      vx: (Math.random() - 0.5) * 1.6,
      vy: 1.5 + Math.random() * 2.5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.25,
      s: 4 + Math.random() * 5,
      c: colors[i % colors.length]!,
    }));
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const el = now - start;
      g.clearRect(0, 0, w, h);
      g.globalAlpha = el > 4000 ? Math.max(0, 1 - (el - 4000) / 1000) : 1;
      for (const b of bits) {
        b.x += b.vx;
        b.y += b.vy;
        b.r += b.vr;
        g.save();
        g.translate(b.x, b.y);
        g.rotate(b.r);
        g.fillStyle = b.c;
        g.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
        g.restore();
      }
      if (el < 5000) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [colors]);
  return <canvas ref={ref} className="confetti" />;
}

export function GameOverCard(props: {
  result: GameResult;
  seats: Record<PlayerId, SeatConfig>;
  gold: Record<PlayerId, number>;
  stats: Record<PlayerId, PlayerStats>;
  rounds: number;
  onClose: () => void;
  rematch?: React.ReactNode;
}) {
  const { result, seats, stats } = props;
  const w = result.winner;
  const rows: [string, (p: PlayerId) => string | number][] = [
    ['Final gold', (p) => props.gold[p]],
    ['Mines found', (p) => stats[p].minesFound],
    ['Gold mined', (p) => stats[p].goldMined],
    ['Contests won', (p) => stats[p].contestsWon],
    ['Workers lost', (p) => stats[p].workersLost],
    ['Best mine', (p) => (stats[p].bestMine ? `${stats[p].bestMine!.id} (+${stats[p].bestMine!.gold})` : '—')],
  ];
  return (
    <div className="gameover">
      <Confetti colors={w ? [PLAYER_COLORS[w], '#f5c542', '#ffffff'] : ['#f5c542', PLAYER_COLORS.p1, PLAYER_COLORS.p2]} />
      <div className="gameover-card">
        <button className="close" onClick={props.onClose} aria-label="close">
          ×
        </button>
        <div className="trophy">{w ? '🏆' : '🤝'}</div>
        {w ? (
          <>
            <Avatar seat={seats[w]} color={PLAYER_COLORS[w]} size={84} />
            <h2 style={{ color: PLAYER_COLORS[w] }}>{seatLabel(w, seats[w])} wins!</h2>
          </>
        ) : (
          <h2>Draw</h2>
        )}
        <p className="muted">
          {result.reason} · {props.rounds} rounds
        </p>
        <table className="mines stats">
          <thead>
            <tr>
              <th />
              {PLAYERS.map((p) => (
                <th key={p} style={{ color: PLAYER_COLORS[p] }}>
                  {p.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <td className="muted">{label}</td>
                {PLAYERS.map((p) => (
                  <td key={p}>
                    <b>{f(p)}</b>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {props.rematch}
      </div>
    </div>
  );
}
