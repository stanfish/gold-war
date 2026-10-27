/** Canvas sprites for the GOD arena, all drawn in code (no image assets). Sizes are in CSS px. */

type G = CanvasRenderingContext2D;

/** Deterministic 0..1 hash of a cell (stable terrain per game seed). */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, used for dirt patches. */
function noise(x: number, y: number, seed: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const sx = fx - x0;
  const sy = fy - y0;
  const s = (u: number) => u * u * (3 - 2 * u);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * s(sx) + (c - a) * s(sy) + (a - b - c + d) * s(sx) * s(sy);
}

const GRASS = ['#1d3622', '#203b25', '#1a3220', '#223f27'];
const DIRT = ['#3a3123', '#352c20', '#3f3526'];

export interface TerrainCell {
  fill: string;
  deco: 'tuft' | 'rock' | 'flower' | null;
  r: number;
}

/** Precompute terrain for an n×n map (cheap; redraw cost is just fills). */
export function buildTerrain(n: number, seed: number): TerrainCell[] {
  const out: TerrainCell[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = hash(x, y, seed);
      const dirt = noise(x, y, seed + 7, 6) > 0.68;
      const fill = dirt ? DIRT[Math.floor(r * DIRT.length)]! : GRASS[Math.floor(r * GRASS.length)]!;
      const k = hash(y, x, seed + 3);
      const deco = k < 0.07 ? 'tuft' : k < 0.1 ? 'rock' : k < 0.115 && !dirt ? 'flower' : null;
      out.push({ fill, deco, r });
    }
  }
  return out;
}

export function drawTerrainCell(g: G, t: TerrainCell, px: number, py: number, cell: number): void {
  g.fillStyle = t.fill;
  g.fillRect(px, py, cell + 0.5, cell + 0.5);
  if (!t.deco || cell < 9) return;
  const cx = px + cell * (0.3 + t.r * 0.4);
  const cy = py + cell * (0.35 + ((t.r * 7) % 1) * 0.35);
  if (t.deco === 'tuft') {
    g.strokeStyle = '#3b6b3f';
    g.lineWidth = Math.max(1, cell * 0.06);
    g.beginPath();
    for (const dx of [-0.12, 0, 0.12]) {
      g.moveTo(cx + dx * cell, cy + cell * 0.12);
      g.lineTo(cx + dx * cell * 1.6, cy - cell * 0.1);
    }
    g.stroke();
  } else if (t.deco === 'rock') {
    g.fillStyle = '#4a4f57';
    g.beginPath();
    g.ellipse(cx, cy, cell * 0.14, cell * 0.09, 0, 0, Math.PI * 2);
    g.fill();
  } else {
    g.fillStyle = t.r > 0.5 ? '#c9a3e8' : '#e8d27a';
    g.beginPath();
    g.arc(cx, cy, Math.max(1, cell * 0.05), 0, Math.PI * 2);
    g.fill();
  }
}

/** Castle on the shared base square, a bit larger than one cell. */
export function drawBase(g: G, cx: number, cy: number, cell: number): void {
  const w = cell * 1.5;
  const h = cell * 1.1;
  const x = cx - w / 2;
  const y = cy - h / 2 + cell * 0.1;
  // glow
  const grad = g.createRadialGradient(cx, cy, cell * 0.2, cx, cy, cell * 1.6);
  grad.addColorStop(0, 'rgba(245,197,66,0.25)');
  grad.addColorStop(1, 'rgba(245,197,66,0)');
  g.fillStyle = grad;
  g.fillRect(cx - cell * 1.6, cy - cell * 1.6, cell * 3.2, cell * 3.2);
  if (cell < 6) {
    g.fillStyle = '#d4a017';
    g.fillRect(cx - cell / 2, cy - cell / 2, cell, cell);
    return;
  }
  g.fillStyle = '#8b8f99';
  g.strokeStyle = '#3d4048';
  g.lineWidth = Math.max(1, cell * 0.05);
  // towers
  const tw = w * 0.28;
  for (const tx of [x, x + w - tw]) {
    g.fillRect(tx, y - h * 0.25, tw, h * 1.25);
    g.strokeRect(tx, y - h * 0.25, tw, h * 1.25);
    for (let i = 0; i < 2; i++) g.fillRect(tx + i * tw * 0.6, y - h * 0.4, tw * 0.4, h * 0.15);
  }
  // wall
  g.fillRect(x + tw, y, w - 2 * tw, h);
  g.strokeRect(x + tw, y, w - 2 * tw, h);
  for (let i = 0; i < 3; i++) g.fillRect(x + tw + i * ((w - 2 * tw) / 3), y - h * 0.14, (w - 2 * tw) / 6, h * 0.14);
  // gate
  g.fillStyle = '#2a2016';
  g.beginPath();
  g.moveTo(cx - w * 0.12, y + h);
  g.lineTo(cx - w * 0.12, y + h * 0.5);
  g.arc(cx, y + h * 0.5, w * 0.12, Math.PI, 0);
  g.lineTo(cx + w * 0.12, y + h);
  g.fill();
  // flag
  g.strokeStyle = '#ddd';
  g.lineWidth = Math.max(1, cell * 0.04);
  g.beginPath();
  g.moveTo(cx, y - h * 0.15);
  g.lineTo(cx, y - h * 0.75);
  g.stroke();
  g.fillStyle = '#d4a017';
  g.beginPath();
  g.moveTo(cx, y - h * 0.75);
  g.lineTo(cx + w * 0.3, y - h * 0.62);
  g.lineTo(cx, y - h * 0.5);
  g.fill();
}

/** Gold-ore rock; bigger and richer the higher the payout (`rich` 0..1). */
export function drawMine(g: G, cx: number, cy: number, cell: number, rich: number, alpha: number, seedR: number): void {
  const s = cell * (0.32 + 0.16 * rich);
  g.globalAlpha = alpha;
  if (cell < 6) {
    g.fillStyle = '#f5c542';
    g.fillRect(cx - cell * 0.35, cy - cell * 0.35, cell * 0.7, cell * 0.7);
    g.globalAlpha = 1;
    return;
  }
  // rock body
  g.fillStyle = '#6b6f78';
  g.strokeStyle = '#2f3238';
  g.lineWidth = Math.max(1, cell * 0.05);
  g.beginPath();
  const pts = 7;
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2 - Math.PI / 2;
    const rr = s * (0.82 + 0.18 * Math.sin(seedR * 13 + i * 2.3));
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr * 0.85;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.stroke();
  // shade
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.beginPath();
  g.ellipse(cx + s * 0.25, cy + s * 0.3, s * 0.55, s * 0.3, -0.3, 0, Math.PI * 2);
  g.fill();
  // nuggets
  const count = 2 + Math.round(rich * 3);
  for (let i = 0; i < count; i++) {
    const a = seedR * 6 + i * 2.1;
    const d = s * 0.45 * ((i * 0.37 + seedR) % 1);
    const nx = cx + Math.cos(a) * d;
    const ny = cy + Math.sin(a) * d * 0.8;
    const nr = Math.max(1.2, s * (0.16 + 0.06 * ((i * 0.61) % 1)));
    g.fillStyle = '#f5c542';
    g.beginPath();
    g.arc(nx, ny, nr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff6c9';
    g.beginPath();
    g.arc(nx - nr * 0.35, ny - nr * 0.35, nr * 0.35, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

/** Little miner: helmet with lamp, body in the player's color, pickaxe. Tiny cells fall back to a dot. */
export function drawMiner(g: G, cx: number, cy: number, size: number, color: string, alpha: number, facing: 1 | -1): void {
  g.globalAlpha = alpha;
  if (size < 10) {
    g.fillStyle = color;
    g.strokeStyle = '#0b0e12';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, Math.max(2, size * 0.35), 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.globalAlpha = 1;
    return;
  }
  const u = size / 10;
  // shadow
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.ellipse(cx, cy + u * 4.2, u * 3, u * 1, 0, 0, Math.PI * 2);
  g.fill();
  // pickaxe (behind body)
  g.strokeStyle = '#8a5a2b';
  g.lineWidth = u * 0.8;
  g.beginPath();
  g.moveTo(cx - facing * u * 1.5, cy + u * 2.5);
  g.lineTo(cx + facing * u * 3, cy - u * 3);
  g.stroke();
  g.strokeStyle = '#c0c6cf';
  g.lineWidth = u * 0.9;
  g.beginPath();
  g.arc(cx + facing * u * 3, cy - u * 3, u * 1.8, Math.PI * (facing > 0 ? 0.6 : -0.4), Math.PI * (facing > 0 ? 1.4 : 0.4));
  g.stroke();
  // body
  g.fillStyle = color;
  g.strokeStyle = '#0b0e12';
  g.lineWidth = Math.max(1, u * 0.5);
  g.beginPath();
  g.ellipse(cx, cy + u * 1.6, u * 2.6, u * 2.6, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // head
  g.fillStyle = '#f1c27d';
  g.beginPath();
  g.arc(cx, cy - u * 1.6, u * 1.9, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // helmet + lamp
  g.fillStyle = '#f5c542';
  g.beginPath();
  g.arc(cx, cy - u * 2, u * 2.1, Math.PI, 0);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#fffbe0';
  g.beginPath();
  g.arc(cx + facing * u * 0.9, cy - u * 2.6, u * 0.6, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
}

// --- Effects ---

export function drawCoin(g: G, x: number, y: number, r: number, alpha: number): void {
  g.globalAlpha = alpha;
  g.fillStyle = '#f5c542';
  g.strokeStyle = '#a07a12';
  g.lineWidth = Math.max(1, r * 0.3);
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.globalAlpha = 1;
}

export function drawFloatText(g: G, text: string, x: number, y: number, size: number, color: string, alpha: number): void {
  g.globalAlpha = alpha;
  g.font = `800 ${size}px system-ui`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = Math.max(2, size * 0.22);
  g.strokeStyle = '#0b0e12';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.globalAlpha = 1;
}

export function drawSpark(g: G, x: number, y: number, r: number, u: number): void {
  const n = 10;
  g.globalAlpha = 1 - u;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + u;
    const r0 = r * (0.3 + u * 0.6);
    const r1 = r * (0.6 + u * 1.1);
    g.strokeStyle = i % 2 ? '#ffffff' : '#f5c542';
    g.lineWidth = Math.max(1.5, r * 0.12);
    g.beginPath();
    g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    g.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    g.stroke();
  }
  g.globalAlpha = 1;
}

export function drawSmoke(g: G, x: number, y: number, r: number, u: number): void {
  for (let i = 0; i < 4; i++) {
    const a = i * 1.7;
    g.globalAlpha = (1 - u) * 0.6;
    g.fillStyle = '#9aa0a8';
    g.beginPath();
    g.arc(x + Math.cos(a) * r * u, y - r * u * 1.2 + Math.sin(a) * r * 0.3, r * (0.3 + u * 0.5), 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
}

export function drawPing(g: G, x: number, y: number, r: number, u: number, color: string): void {
  for (const k of [0, 0.3]) {
    const v = Math.max(0, Math.min(1, (u - k) / 0.7));
    if (v <= 0 || v >= 1) continue;
    g.globalAlpha = 1 - v;
    g.strokeStyle = color;
    g.lineWidth = Math.max(2, r * 0.12);
    g.beginPath();
    g.arc(x, y, r * (0.4 + v * 1.6), 0, Math.PI * 2);
    g.stroke();
  }
  g.globalAlpha = 1;
}

export function drawCallout(g: G, text: string, x: number, y: number, color: string, alpha: number): void {
  g.globalAlpha = alpha;
  g.font = '700 12px system-ui';
  const w = g.measureText(text).width + 12;
  const h = 20;
  g.fillStyle = 'rgba(11,14,18,0.92)';
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.beginPath();
  g.roundRect(x - w / 2, y - h, w, h, 6);
  g.fill();
  g.stroke();
  g.fillStyle = '#e6edf3';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y - h / 2 + 0.5);
  g.globalAlpha = 1;
}

export function drawCross(g: G, x: number, y: number, r: number, alpha: number): void {
  g.globalAlpha = alpha;
  g.strokeStyle = '#ff5c5c';
  g.lineWidth = Math.max(2, r * 0.3);
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x - r, y - r);
  g.lineTo(x + r, y + r);
  g.moveTo(x + r, y - r);
  g.lineTo(x - r, y + r);
  g.stroke();
  g.lineCap = 'butt';
  g.globalAlpha = 1;
}
