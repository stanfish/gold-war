import { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYERS, visibleCells, type Mine, type PlayerId, type Pos, type Snapshot } from '@gold-war/engine';
import { PLAYER_COLORS } from '../common';
import { PHASE, ROUND_MS, ease, knownAt, phaseT, workersAt, type AnimWorker, type Transition } from './replay';
import {
  buildTerrain,
  drawBase,
  drawCallout,
  drawCoin,
  drawCross,
  drawFloatText,
  drawMine,
  drawMiner,
  drawPing,
  drawSmoke,
  drawSpark,
  drawTerrainCell,
} from './sprites';

const VISION_TINT: Record<PlayerId, string> = { p1: 'rgba(59,143,230,0.20)', p2: 'rgba(236,90,90,0.20)' };

export interface ArenaProps {
  n: number;
  seed: number;
  base: Pos;
  mines: Mine[];
  payoutRange: [number, number];
  /** Board to show when nothing is animating (and at the end of a transition). */
  snap: Snapshot;
  /** Round being animated; null = static. Changing `animKey` restarts the animation. */
  transition: Transition | null;
  animKey: string;
  trails: { player: PlayerId; from: Pos; to: Pos; age: number }[];
  vision: Record<PlayerId, boolean>;
  visionRadius: number;
  /** Mine to spotlight (e.g. hovered in the mines table): drawn enlarged with a ring and its name. */
  highlightMine?: string | null;
  onAnimDone?: () => void;
  /** Overlay content (round banner, game-over card). */
  children?: React.ReactNode;
}

/** GOD view battlefield: terrain, castle, ore mines and miners, with animated round resolution. */
export function Arena(props: ArenaProps) {
  const { n } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [view, setView] = useState({ zoom: 1, ox: 0, oy: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; px: number; py: number } | null>(null);
  const terrain = useMemo(() => buildTerrain(n, props.seed), [n, props.seed]);
  const mineR = useMemo(() => new Map(props.mines.map((m, i) => [m.id, ((i * 0.618) % 1) as number])), [props.mines]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setView({ zoom: 1, ox: 0, oy: 0 }), [n]);

  const baseCell = Math.min(size.w, size.h) / n;
  const cell = baseCell * view.zoom;
  const padX = (size.w - n * baseCell) / 2;
  const padY = (size.h - n * baseCell) / 2;

  // Latest props for the animation loop without restarting it on every render.
  const live = useRef(props);
  live.current = props;
  const geo = useRef({ cell, padX, padY, view, size });
  geo.current = { cell, padX, padY, view, size };

  const draw = (t: number) => {
    const c = canvasRef.current;
    if (!c) return;
    const p = live.current;
    const { cell, padX, padY, view, size } = geo.current;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== size.w * dpr || c.height !== size.h * dpr) {
      c.width = size.w * dpr;
      c.height = size.h * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#05070a';
    g.fillRect(0, 0, size.w, size.h);
    const offX = view.ox + padX;
    const offY = view.oy + padY;
    g.translate(offX, offY);

    // Terrain, culled to the viewport.
    const x0 = Math.max(0, Math.floor(-offX / cell));
    const y0 = Math.max(0, Math.floor(-offY / cell));
    const x1 = Math.min(n - 1, Math.ceil((size.w - offX) / cell));
    const y1 = Math.min(n - 1, Math.ceil((size.h - offY) / cell));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) drawTerrainCell(g, terrain[y * n + x]!, x * cell, y * cell, cell);
    if (cell >= 10) {
      g.strokeStyle = 'rgba(255,255,255,0.035)';
      g.lineWidth = 1;
      g.beginPath();
      for (let k = 0; k <= n; k++) {
        g.moveTo(k * cell, 0);
        g.lineTo(k * cell, n * cell);
        g.moveTo(0, k * cell);
        g.lineTo(n * cell, k * cell);
      }
      g.stroke();
    }

    const tr = p.transition && t < 1 ? p.transition : null;
    const workers = workersAt(p.snap, tr, t, p.base);
    const final = tr ? null : p.snap;

    // Vision overlays (current board).
    for (const pl of PLAYERS) {
      if (!p.vision[pl]) continue;
      const ws = (final ?? p.snap).players[pl].workers;
      g.fillStyle = VISION_TINT[pl];
      for (const i of visibleCells(n, ws, p.visionRadius)) g.fillRect((i % n) * cell, Math.floor(i / n) * cell, cell, cell);
    }

    // Trails: L-shaped walk paths of recent rounds, fading with age.
    const cx = (v: number) => (v + 0.5) * cell;
    g.lineCap = 'round';
    for (const tr0 of p.trails) {
      const fade = tr0.age === 0 && tr ? ease(phaseT(t, PHASE.move)) : 1;
      g.globalAlpha = (0.55 - tr0.age * 0.15) * fade;
      g.strokeStyle = PLAYER_COLORS[tr0.player];
      g.lineWidth = Math.max(1.5, cell * 0.1);
      g.setLineDash([Math.max(2, cell * 0.2), Math.max(2, cell * 0.2)]);
      g.beginPath();
      g.moveTo(cx(tr0.from.x), cx(tr0.from.y));
      g.lineTo(cx(tr0.to.x), cx(tr0.from.y));
      g.lineTo(cx(tr0.to.x), cx(tr0.to.y));
      g.stroke();
    }
    g.setLineDash([]);
    g.lineCap = 'butt';
    g.globalAlpha = 1;

    drawBase(g, cx(p.base.x), cx(p.base.y), cell);

    // Mines.
    const known = knownAt(p.snap, tr, t);
    const [pmin, pmax] = p.payoutRange;
    for (const m of p.mines) {
      const by = PLAYERS.filter((pl) => known[pl].has(m.id));
      const rich = pmax > pmin ? (m.payout - pmin) / (pmax - pmin) : 0.5;
      drawMine(g, cx(m.x), cx(m.y), cell, rich, by.length ? 1 : 0.38, mineR.get(m.id) ?? 0);
      if (cell >= 12) {
        by.forEach((pl, i) => {
          g.fillStyle = PLAYER_COLORS[pl];
          g.strokeStyle = '#0b0e12';
          g.lineWidth = 1;
          g.beginPath();
          g.arc(cx(m.x) + (i - (by.length - 1) / 2) * cell * 0.26, (m.y + 0.92) * cell, Math.max(2, cell * 0.09), 0, Math.PI * 2);
          g.fill();
          g.stroke();
        });
      }
    }

    // Workers, spread when several share a square.
    const groups = new Map<string, AnimWorker[]>();
    for (const w of workers) {
      const k = `${Math.round(w.pos.x)},${Math.round(w.pos.y)}`;
      groups.set(k, [...(groups.get(k) ?? []), w]);
    }
    for (const ws of groups.values()) {
      ws.forEach((w, i) => {
        const spread = ws.length > 1 ? cell * 0.24 : 0;
        const a = (i / ws.length) * Math.PI * 2 - Math.PI / 2;
        const px = cx(w.pos.x) + Math.cos(a) * spread;
        const py = cx(w.pos.y) + Math.sin(a) * spread;
        const mv = tr?.moves.get(w.key);
        const facing: 1 | -1 = mv && mv.to.x < mv.from.x ? -1 : 1;
        drawMiner(g, px, py, cell * (ws.length > 1 ? 0.72 : 0.95), PLAYER_COLORS[w.player], w.alpha, facing);
        if (w.flagged) drawCross(g, px, py - cell * 0.1, cell * 0.25, 1 - phaseT(t, PHASE.invalid) * 0.6);
      });
    }

    // Mine name tags above workers (only when zoomed in enough to fit); effects draw on top of everything.
    if (cell >= 22) {
      const fs = Math.max(9, Math.min(13, Math.floor(cell * 0.38)));
      g.font = `600 ${fs}px system-ui`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const m of p.mines) {
        const text = `${m.id} · ${m.payout}`;
        const w = g.measureText(text).width + 6;
        const h = fs + 3;
        const top = m.y === 0 ? (m.y + 1) * cell + 2 : m.y * cell - h - 1;
        g.globalAlpha = 0.85;
        g.fillStyle = '#000';
        g.fillRect(cx(m.x) - w / 2, top, w, h);
        g.fillStyle = '#f5c542';
        g.fillText(text, cx(m.x), top + h / 2 + 0.5);
        g.globalAlpha = 1;
      }
    }
    // Effects for the animating round.
    if (tr) {
      const mineById = new Map(p.mines.map((m) => [m.id, m]));
      const calloutsAt = new Map<string, number>();
      for (const e of tr.events) {
        if (e.type === 'collect') {
          const m = mineById.get(e.mineId);
          if (!m) continue;
          const mx = cx(m.x);
          const my = cx(m.y);
          if (e.workers.p1 > 0 && e.workers.p2 > 0) {
            const u = phaseT(t, PHASE.spark);
            if (u > 0 && u < 1) drawSpark(g, mx, my, cell * 0.9, u);
          }
          const cu = phaseT(t, PHASE.coins);
          for (const pl of PLAYERS) {
            if (e.gained[pl] <= 0) continue;
            if (cu > 0 && cu < 1) {
              for (let k = 0; k < 3; k++) {
                const v = Math.max(0, Math.min(1, cu * 1.3 - k * 0.15));
                if (v <= 0 || v >= 1) continue;
                const bx = cx(p.base.x);
                const by0 = cx(p.base.y);
                const x = mx + (bx - mx) * v;
                const y = my + (by0 - my) * v - Math.sin(v * Math.PI) * cell * 2;
                drawCoin(g, x, y, Math.max(2.5, cell * 0.16), 1);
              }
            }
            const fu = phaseT(t, PHASE.float);
            if (fu > 0) {
              const off = pl === 'p1' ? -0.35 : 0.35;
              drawFloatText(g, `+${e.gained[pl]}`, mx + off * cell * (e.gained.p1 > 0 && e.gained.p2 > 0 ? 1 : 0), my - cell * (0.6 + fu * 1.2), Math.max(13, cell * 0.6), PLAYER_COLORS[pl], 1 - fu * fu);
            }
          }
        } else if (e.type === 'delete') {
          const w = tr.before.players[e.player].workers.find((x) => x.id === e.workerId);
          const u = phaseT(t, PHASE.del);
          if (w && u > 0 && u < 1) drawSmoke(g, cx(w.x), cx(w.y), cell * 0.6, u);
        } else if (e.type === 'discover') {
          const m = mineById.get(e.mineId);
          const u = phaseT(t, PHASE.discover);
          if (m && u > 0) {
            // Both players can find the same mine in one round: stack their callouts.
            const stack = calloutsAt.get(m.id) ?? 0;
            calloutsAt.set(m.id, stack + 1);
            drawPing(g, cx(m.x), cx(m.y), cell, u, PLAYER_COLORS[e.player]);
            drawCallout(g, `${e.player.toUpperCase()} found ${m.id} (${m.payout})`, cx(m.x), m.y * cell - cell * 0.3 - stack * 24, PLAYER_COLORS[e.player], Math.min(1, u * 4) * (u > 0.85 ? (1 - u) / 0.15 : 1));
          }
        }
      }
    }


    // Spotlighted mine, drawn last: enlarged over everything on the board, with a ring and its name.
    const hl = p.highlightMine ? p.mines.find((m) => m.id === p.highlightMine) : undefined;
    if (hl) {
      const r = Math.max(cell * 1.6, 22);
      const big = Math.max(cell * 2.4, 34);
      g.fillStyle = 'rgba(5,7,10,0.55)';
      g.beginPath();
      g.arc(cx(hl.x), cx(hl.y), r, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#f5c542';
      g.lineWidth = 3;
      g.shadowColor = '#f5c542';
      g.shadowBlur = 16;
      g.stroke();
      g.shadowBlur = 0;
      drawMine(g, cx(hl.x), cx(hl.y), big, pmax > pmin ? (hl.payout - pmin) / (pmax - pmin) : 0.5, 1, mineR.get(hl.id) ?? 0);
      drawCallout(g, `${hl.id} · pays ${hl.payout}`, cx(hl.x), cx(hl.y) - r - 4, '#f5c542', 1);
    }
  };

  // Animation loop: runs while a transition plays, then settles on the static board.
  const doneRef = useRef(props.onAnimDone);
  doneRef.current = props.onAnimDone;
  const animating = useRef(false);
  useEffect(() => {
    if (!props.transition) {
      draw(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    animating.current = true;
    const tick = (now: number) => {
      const t = (now - start) / ROUND_MS;
      draw(Math.min(1, t));
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        animating.current = false;
        doneRef.current?.();
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      animating.current = false;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.animKey]);

  // Static redraws (pan/zoom/resize/toggles) when not animating; the loop picks these up itself.
  useEffect(() => {
    if (!animating.current) draw(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, view, props.vision, props.snap, props.trails, props.highlightMine, terrain]);

  const toCell = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - padX - view.ox) / cell);
    const y = Math.floor((clientY - rect.top - padY - view.oy) / cell);
    return x >= 0 && y >= 0 && x < n && y < n ? { x, y } : null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left - padX;
    const my = e.clientY - rect.top - padY;
    const zoom = Math.min(8, Math.max(1, view.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const k = zoom / view.zoom;
    setView({ zoom, ox: mx - (mx - view.ox) * k, oy: my - (my - view.oy) * k });
  };

  return (
    <div className="map-wrap arena" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: 'grab' }}
        onWheel={onWheel}
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, moved: false })}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) {
            const c = toCell(e.clientX, e.clientY);
            const rect = canvasRef.current!.getBoundingClientRect();
            setHover(c ? { ...c, px: e.clientX - rect.left, py: e.clientY - rect.top } : null);
            return;
          }
          setHover(null);
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          if (d.moved) {
            setView((v) => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
            drag.current = { x: e.clientX, y: e.clientY, moved: true };
          }
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => {
          drag.current = null;
          setHover(null);
        }}
      />
      {hover && <ArenaTooltip {...hover} mines={props.mines} snap={props.snap} wrapW={size.w} />}
      <div className="map-controls">
        <button onClick={() => setView((v) => ({ ...v, zoom: Math.min(8, v.zoom * 1.3) }))}>+</button>
        <button onClick={() => setView((v) => ({ ...v, zoom: Math.max(1, v.zoom / 1.3) }))}>−</button>
        <button onClick={() => setView({ zoom: 1, ox: 0, oy: 0 })}>fit</button>
      </div>
      {props.children}
    </div>
  );
}

function ArenaTooltip(p: { x: number; y: number; px: number; py: number; mines: Mine[]; snap: Snapshot; wrapW: number }) {
  const mines = p.mines.filter((m) => m.x === p.x && m.y === p.y);
  const workers = PLAYERS.flatMap((pl) => p.snap.players[pl].workers.filter((w) => w.x === p.x && w.y === p.y).map((w) => ({ pl, id: w.id })));
  const left = p.px + 14 + 220 > p.wrapW ? p.px - 14 - 220 : p.px + 14;
  return (
    <div className="map-tooltip" style={{ left, top: p.py + 12 }}>
      <div className="muted">
        ({p.x}, {p.y})
      </div>
      {mines.map((m) => {
        const by = PLAYERS.filter((pl) => p.snap.players[pl].knownMines.includes(m.id));
        return (
          <div key={m.id}>
            <b className="gold">{m.id}</b> pays <b>{m.payout}</b>/round · {by.length ? `known by ${by.join(', ')}` : 'undiscovered'}
          </div>
        );
      })}
      {workers.map((w) => (
        <div key={`${w.pl}${w.id}`} style={{ color: PLAYER_COLORS[w.pl] }}>
          {w.pl.toUpperCase()} {w.id}
        </div>
      ))}
    </div>
  );
}
