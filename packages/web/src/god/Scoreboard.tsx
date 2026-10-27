import { useEffect, useRef, useState } from 'react';
import type { AiPanel, PlayerId, SeatConfig } from '@gold-war/engine';
import { Countdown, PLAYER_COLORS } from '../common';

/** Seat portrait: person (human), robot (AI), or person with a robot sidekick (player with AI). */
export function Avatar({ seat, color, size = 56 }: { seat: SeatConfig; color: string; size?: number }) {
  const person = (
    <g>
      <circle cx="32" cy="24" r="11" fill="#f1c27d" stroke="#0b0e12" strokeWidth="2" />
      <path d="M14 56c0-11 8-18 18-18s18 7 18 18z" fill={color} stroke="#0b0e12" strokeWidth="2" />
      <path d="M20 22a12 12 0 0 1 24 0z" fill="#f5c542" stroke="#0b0e12" strokeWidth="2" />
      <circle cx="35" cy="17" r="2.5" fill="#fffbe0" />
    </g>
  );
  const robot = (scale: number, dx: number, dy: number) => (
    <g transform={`translate(${dx} ${dy}) scale(${scale})`}>
      <line x1="32" y1="6" x2="32" y2="14" stroke="#c0c6cf" strokeWidth="3" />
      <circle cx="32" cy="6" r="4" fill={color} />
      <rect x="14" y="14" width="36" height="28" rx="8" fill="#c0c6cf" stroke="#0b0e12" strokeWidth="2" />
      <circle cx="25" cy="27" r="5" fill={color} />
      <circle cx="39" cy="27" r="5" fill={color} />
      <rect x="24" y="35" width="16" height="3" rx="1.5" fill="#0b0e12" />
      <rect x="20" y="44" width="24" height="14" rx="4" fill={color} stroke="#0b0e12" strokeWidth="2" />
    </g>
  );
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="31" fill="#0d1117" stroke={color} strokeWidth="2" />
      {seat.type === 'ai' ? robot(1, 0, 2) : person}
      {seat.type === 'relay' && robot(0.45, 36, 32)}
    </svg>
  );
}

/** Number that counts up/down to its new value. */
function useTween(value: number, ms = 900): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const u = Math.min(1, (now - start) / ms);
      const v = a + (value - a) * (1 - (1 - u) ** 3);
      setShown(v);
      from.current = v;
      if (u < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

function seatName(seat: SeatConfig): string {
  return seat.type === 'human' ? 'Human' : seat.type === 'relay' ? 'Player with AI' : (seat.label ?? seat.agent);
}

export interface SideInfo {
  gold: number;
  workers: number;
  startWorkers: number;
  submitted: boolean;
  /** Hide the submitted/thinking chip (replay). */
  hideStatus?: boolean;
  panel?: AiPanel;
  bubble: string | null;
  delta: number | null;
  leading: boolean;
}

function Side({ p, seat, info }: { p: PlayerId; seat: SeatConfig; info: SideInfo }) {
  const gold = useTween(info.gold);
  const [open, setOpen] = useState(false);
  const color = PLAYER_COLORS[p];
  const status = info.panel?.status ?? (info.submitted ? 'submitted' : 'deciding');
  return (
    <div className={`side-card ${p}${info.leading ? ' leading' : ''}`} style={{ borderColor: color }}>
      <Avatar seat={seat} color={color} />
      <div className="side-main">
        <div className="side-name">
          <b style={{ color }}>{p.toUpperCase()}</b> <span>{seatName(seat)}</span>
          {info.leading && <span className="crown" title="leading">👑</span>}
        </div>
        <div className="side-gold">
          <span className="coin" aria-hidden="true" />
          <b>{(Math.round(gold * 2) / 2).toFixed(1).replace(/\.0$/, '')}</b>
          {info.delta !== null && info.delta !== 0 && (
            <span key={`${info.delta}-${info.gold}`} className={`delta ${info.delta > 0 ? 'up' : 'down'}`}>
              {info.delta > 0 ? '+' : ''}
              {info.delta}
            </span>
          )}
        </div>
        <div className="side-workers" title={`${info.workers} workers`}>
          {Array.from({ length: Math.max(info.startWorkers, info.workers) }, (_, i) => (
            <span key={i} className={`worker-pip${i < info.workers ? '' : ' lost'}`} style={{ background: i < info.workers ? color : undefined }} />
          ))}
          {!info.hideStatus && <span className={`chip ${status}`}>{status === 'submitted' ? '✓ submitted' : status}</span>}
        </div>
      </div>
      {info.bubble && (
        <button className={`bubble${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title={open ? 'collapse' : 'expand'}>
          {info.bubble}
        </button>
      )}
    </div>
  );
}

export function Scoreboard(props: {
  seats: Record<PlayerId, SeatConfig>;
  sides: Record<PlayerId, SideInfo>;
  round: number;
  roundsTotal: number;
  deadline: number | null;
  phase: string;
  phaseDetail: string | null;
  gameNumber: number;
  replaying: boolean;
}) {
  return (
    <header className="scoreboard">
      <Side p="p1" seat={props.seats.p1} info={props.sides.p1} />
      <div className="vs">
        <div className="vs-round">
          {props.gameNumber > 1 && <span className="muted">Game {props.gameNumber} · </span>}
          Round <b>{props.round}</b>/{props.roundsTotal}
        </div>
        <div className="vs-badge">VS</div>
        <div className="vs-timer">
          {props.replaying ? <span className="muted">replay</span> : <>⏱ <Countdown deadline={props.deadline} /></>}
        </div>
        <div className="muted small vs-phase">
          {props.phase}
          {props.phaseDetail ? ` — ${props.phaseDetail}` : ''}
        </div>
      </div>
      <Side p="p2" seat={props.seats.p2} info={props.sides.p2} />
    </header>
  );
}

