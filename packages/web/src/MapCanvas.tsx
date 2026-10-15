import { useEffect, useRef, useState } from 'react';

export interface MapMine {
  id: string;
  x: number;
  y: number;
  payout: number;
  /** Dim mines are known but not yet collectable, or (god view) undiscovered by anyone. */
  dim?: boolean;
  label?: string;
}

export interface MapUnit {
  key: string;
  x: number;
  y: number;
  color: string;
  label?: string;
  /** Stale sightings render hollow. */
  stale?: boolean;
  selected?: boolean;
}

export interface MapCanvasProps {
  n: number;
  base: { x: number; y: number };
  /** Row-major explored mask; omit for a fully revealed map (god view). */
  explored?: number[];
  /** Currently visible cell indices; omit for fully visible. */
  visible?: Set<number>;
  mines: MapMine[];
  units: MapUnit[];
  /** Cells to highlight as valid targets (e.g. MOVE destinations). */
  highlight?: Set<number>;
  onCellClick?: (x: number, y: number) => void;
}

const COLORS = {
  unseen: '#07090c',
  explored: '#1b222b',
  visible: '#2d3a48',
  grid: 'rgba(255,255,255,0.05)',
  base: '#d4a017',
  mine: '#f5c542',
  highlight: 'rgba(120, 200, 255, 0.35)',
};

/** Canvas grid map with wheel zoom and drag pan. Scales to 60x60 and beyond. */
export function MapCanvas(props: MapCanvasProps) {
  const { n } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 600, h: 600 });
  const [view, setView] = useState({ zoom: 1, ox: 0, oy: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(200, e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reset view when the map size changes.
  useEffect(() => setView({ zoom: 1, ox: 0, oy: 0 }), [n]);

  const baseCell = Math.min(size.w, size.h) / n;
  const cell = baseCell * view.zoom;
  // Center the fitted map inside the (possibly non-square) canvas.
  const padX = (size.w - n * baseCell) / 2;
  const padY = (size.h - n * baseCell) / 2;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, size.w, size.h);
    g.translate(view.ox + padX, view.oy + padY);

    const { explored, visible, highlight } = props;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const vis = !visible || visible.has(i);
        const exp = !explored || explored[i];
        g.fillStyle = vis ? COLORS.visible : exp ? COLORS.explored : COLORS.unseen;
        g.fillRect(x * cell, y * cell, cell, cell);
        if (highlight?.has(i)) {
          g.fillStyle = COLORS.highlight;
          g.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    if (cell >= 6) {
      g.strokeStyle = COLORS.grid;
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

    // Base
    g.strokeStyle = COLORS.base;
    g.lineWidth = Math.max(1.5, cell * 0.12);
    g.strokeRect(props.base.x * cell + 1, props.base.y * cell + 1, cell - 2, cell - 2);

    // Mines
    for (const m of props.mines) {
      const cx = (m.x + 0.5) * cell;
      const cy = (m.y + 0.5) * cell;
      g.globalAlpha = m.dim ? 0.45 : 1;
      g.fillStyle = COLORS.mine;
      g.beginPath();
      g.moveTo(cx, cy - cell * 0.42);
      g.lineTo(cx + cell * 0.42, cy);
      g.lineTo(cx, cy + cell * 0.42);
      g.lineTo(cx - cell * 0.42, cy);
      g.closePath();
      g.fill();
      if (cell >= 14) {
        g.fillStyle = '#111';
        g.font = `bold ${Math.floor(cell * 0.45)}px system-ui`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(m.payout), cx, cy + 1);
      }
      g.globalAlpha = 1;
    }

    // Units: group per cell so stacked workers stay readable.
    const groups = new Map<number, typeof props.units>();
    for (const u of props.units) {
      const k = u.y * n + u.x;
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    for (const [, us] of groups) {
      us.forEach((u, idx) => {
        const r = cell * (us.length > 1 ? 0.22 : 0.3);
        const angle = (idx / us.length) * Math.PI * 2;
        const spread = us.length > 1 ? cell * 0.22 : 0;
        const cx = (u.x + 0.5) * cell + Math.cos(angle) * spread;
        const cy = (u.y + 0.5) * cell + Math.sin(angle) * spread;
        g.beginPath();
        g.arc(cx, cy, Math.max(2, r), 0, Math.PI * 2);
        if (u.stale) {
          g.strokeStyle = u.color;
          g.lineWidth = 1.5;
          g.setLineDash([3, 2]);
          g.stroke();
          g.setLineDash([]);
        } else {
          g.fillStyle = u.color;
          g.fill();
        }
        if (u.selected) {
          g.strokeStyle = '#fff';
          g.lineWidth = 2;
          g.stroke();
        }
        if (u.label && cell >= 18 && us.length === 1) {
          g.fillStyle = '#fff';
          g.font = `${Math.floor(r * 0.9)}px system-ui`;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillText(u.label, cx, cy + 1);
        }
      });
    }
  }, [props, size, view, cell, n, padX, padY]);

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
    <div className="map-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, cursor: props.onCellClick ? 'crosshair' : 'grab' }}
        onWheel={onWheel}
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, moved: false })}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          if (d.moved) {
            setView((v) => ({ ...v, ox: v.ox + dx, oy: v.oy + dy }));
            drag.current = { x: e.clientX, y: e.clientY, moved: true };
          }
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved && props.onCellClick) {
            const c = toCell(e.clientX, e.clientY);
            if (c) props.onCellClick(c.x, c.y);
          }
        }}
        onMouseLeave={() => (drag.current = null)}
      />
      <div className="map-controls">
        <button onClick={() => setView((v) => ({ ...v, zoom: Math.min(8, v.zoom * 1.3) }))}>+</button>
        <button onClick={() => setView((v) => ({ ...v, zoom: Math.max(1, v.zoom / 1.3) }))}>−</button>
        <button onClick={() => setView({ zoom: 1, ox: 0, oy: 0 })}>fit</button>
      </div>
    </div>
  );
}
