import { useEffect, useRef, useState } from 'react';
import { PLAYERS, type PlayerId } from '@gold-war/engine';

/** Chart stroke colors: same hues as the seat colors, stepped into the dark-mode lightness band (validated). */
const LINE: Record<PlayerId, string> = { p1: '#3b8fe6', p2: '#ec5a5a' };
const M = { l: 34, r: 52, t: 10, b: 22 };
const H = 170;

function niceMax(v: number): number {
  if (v <= 10) return 10;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / (step / 2)) * (step / 2);
}

/** Gold over time for both seats; hover for values, click a round to jump the replay there. */
export function GoldChart(props: {
  series: { round: number; p1: number; p2: number }[];
  roundsTotal: number;
  selected: number | null;
  onPick: (round: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(220, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { series, roundsTotal } = props;
  const maxY = niceMax(Math.max(...series.flatMap((s) => [s.p1, s.p2]), 1));
  const iw = w - M.l - M.r;
  const ih = H - M.t - M.b;
  const x = (r: number) => M.l + (r / Math.max(1, roundsTotal)) * iw;
  const y = (v: number) => M.t + ih - (v / maxY) * ih;
  const ticks = [0, maxY / 2, maxY];
  const last = series.at(-1)!;
  const path = (p: PlayerId) => series.map((s, i) => `${i ? 'L' : 'M'}${x(s.round).toFixed(1)},${y(s[p]).toFixed(1)}`).join('');
  const hv = hover !== null ? series[hover] : null;

  // Keep the two end labels from colliding.
  let ly1 = y(last.p1);
  let ly2 = y(last.p2);
  if (Math.abs(ly1 - ly2) < 14) {
    const mid = (ly1 + ly2) / 2;
    const up = last.p1 >= last.p2 ? -7 : 7;
    ly1 = mid + up;
    ly2 = mid - up;
  }

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const r = Math.round(((e.clientX - box.left) / box.width) * Math.max(1, roundsTotal));
    setHover(Math.max(0, Math.min(series.length - 1, r)));
  };

  return (
    <div className="gold-chart" ref={ref}>
      <div className="legend small">
        {PLAYERS.map((p) => (
          <span key={p}>
            <i style={{ background: LINE[p] }} /> {p.toUpperCase()}
          </span>
        ))}
      </div>
      <svg width={w} height={H} role="img" aria-label="Gold per round for P1 and P2">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={M.l} x2={w - M.r} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.07)" />
            <text x={M.l - 6} y={y(t)} textAnchor="end" dominantBaseline="middle" className="axis">
              {t}
            </text>
          </g>
        ))}
        <text x={M.l} y={H - 6} className="axis">
          0
        </text>
        <text x={w - M.r} y={H - 6} textAnchor="end" className="axis">
          round {roundsTotal}
        </text>
        {props.selected !== null && (
          <line x1={x(props.selected)} x2={x(props.selected)} y1={M.t} y2={M.t + ih} stroke="#d4a017" strokeDasharray="3 3" />
        )}
        {PLAYERS.map((p) => (
          <path key={p} d={path(p)} fill="none" stroke={LINE[p]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {PLAYERS.map((p) => (
          <g key={p}>
            <circle cx={x(last.round)} cy={y(last[p])} r={4} fill={LINE[p]} stroke="#161b22" strokeWidth={2} />
            <text x={x(last.round) + 8} y={p === 'p1' ? ly1 : ly2} dominantBaseline="middle" className="end-label">
              {p.toUpperCase()} {last[p]}
            </text>
          </g>
        ))}
        {hv && (
          <g pointerEvents="none">
            <line x1={x(hv.round)} x2={x(hv.round)} y1={M.t} y2={M.t + ih} stroke="rgba(255,255,255,0.35)" />
            {PLAYERS.map((p) => (
              <circle key={p} cx={x(hv.round)} cy={y(hv[p])} r={4} fill={LINE[p]} stroke="#161b22" strokeWidth={2} />
            ))}
          </g>
        )}
        <rect
          x={M.l}
          y={M.t}
          width={iw}
          height={ih}
          fill="transparent"
          style={{ cursor: 'pointer' }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={() => hover !== null && props.onPick(series[hover]!.round)}
        />
      </svg>
      {hv && (
        <div className="chart-tip small" style={{ left: Math.min(w - 130, Math.max(0, x(hv.round) - 60)) }}>
          <div className="muted">{hv.round === 0 ? 'start' : `after round ${hv.round}`}</div>
          {PLAYERS.map((p) => (
            <div key={p}>
              <i style={{ background: LINE[p] }} /> {p.toUpperCase()} <b>{hv[p]}</b>
            </div>
          ))}
        </div>
      )}
      <details className="small">
        <summary className="muted">Show as table</summary>
        <table className="mines">
          <thead>
            <tr>
              <th>Round</th>
              <th>P1</th>
              <th>P2</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.round}>
                <td>{s.round === 0 ? 'start' : s.round}</td>
                <td>{s.p1}</td>
                <td>{s.p2}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
