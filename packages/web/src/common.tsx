import { useEffect, useRef, useState } from 'react';
import type { ChatEntry, ClientMessage, PlayerId, RoundEvent, SeatConfig, ServerMessage } from '@gold-war/engine';

export const PLAYER_COLORS: Record<PlayerId, string> = { p1: '#4da3ff', p2: '#ff6b6b' };

export function useGameSocket<T extends ServerMessage>(seat: PlayerId | 'god', key: string | null) {
  const [msg, setMsg] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!key) {
      setError('missing ?k= key in the URL');
      return;
    }
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws?seat=${seat}&k=${encodeURIComponent(key)}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerMessage;
        if (m.type === 'error') setError(m.message);
        else {
          setError(null);
          setMsg(m as T);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [seat, key]);

  const send = (m: ClientMessage) => wsRef.current?.send(JSON.stringify(m));
  return { msg, error, connected, send };
}

export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Countdown({ deadline }: { deadline: number | null }) {
  const now = useNow();
  if (!deadline) return <span className="muted">—</span>;
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span className={s <= 15 ? 'danger' : ''}>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</span>;
}

export function seatLabel(p: PlayerId, seat: SeatConfig): string {
  return `${p.toUpperCase()} · ${seat.type === 'human' ? 'human' : seat.type === 'relay' ? 'player with AI' : (seat.label ?? seat.agent)}`;
}

export function ChatLog({ chat, me }: { chat: ChatEntry[]; me?: PlayerId }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, ref.current.scrollHeight);
  }, [chat.length]);
  if (!chat.length) return <div className="muted small">No messages yet.</div>;
  return (
    <div className="chat" ref={ref}>
      {chat.map((c, i) => (
        <div key={i} className="chat-line">
          <span className="muted">R{c.round}</span>{' '}
          <b style={{ color: PLAYER_COLORS[c.sender] }}>{c.sender === me ? 'you' : c.sender}</b>: {c.text}
        </div>
      ))}
    </div>
  );
}

export function describeEvent(e: RoundEvent, me?: PlayerId): string {
  const who = (p: PlayerId) => (p === me ? 'you' : p);
  switch (e.type) {
    case 'missing':
      return `${who(e.player)} ${e.workerId}: no action → STAY`;
    case 'invalid':
      return `${who(e.player)} ${e.workerId}: invalid (${e.reason}) → STAY`;
    case 'downgrade':
      return `${who(e.player)} ${e.workerId}: unaffordable ${e.from} → ${e.to}`;
    case 'move':
      return `${who(e.player)} ${e.workerId}: (${e.from.x},${e.from.y}) → (${e.to.x},${e.to.y})`;
    case 'collect':
      return `${e.mineId} (${e.payout}): p1×${e.workers.p1} vs p2×${e.workers.p2} → p1 +${e.gained.p1}, p2 +${e.gained.p2}`;
    case 'delete':
      return `${who(e.player)} ${e.workerId}: deleted`;
    case 'discover':
      return `${who(e.player)} discovered ${e.mineId}`;
    case 'cost':
      return `${who(e.player)} paid ${e.amount} gold`;
    case 'income':
      return `${who(e.player)} earned ${e.amount} gold`;
    case 'end':
      return `GAME OVER: ${e.result.winner ? `${who(e.result.winner)} wins` : 'draw'} (${e.result.reason})`;
  }
}
