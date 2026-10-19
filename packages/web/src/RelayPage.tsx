import { useEffect, useState } from 'react';
import { opponentOf, type ClientMessage, type SeatUpdate } from '@gold-war/engine';
import { Countdown, PLAYER_COLORS, seatLabel } from './common';

/**
 * "Player with AI" seat: shows the exact message an AI seat would get this round (one per round), for the
 * player to copy into any AI outside the game, and takes the AI's reply back.
 */
export function RelayPage({ msg, send, error }: { msg: SeatUpdate; send: (m: ClientMessage) => void; error: string | null }) {
  const { seat, view } = msg;
  const relay = msg.relay!;
  const opp = opponentOf(seat);
  const [withBriefing, setWithBriefing] = useState(relay.round === 1);
  const [reply, setReply] = useState('');
  const [copied, setCopied] = useState(false);

  // New round: fresh paste box; the rules only go along on round 1 (the AI chat already has them after that).
  useEffect(() => {
    setReply('');
    setCopied(false);
    setWithBriefing(relay.round === 1);
  }, [relay.round, msg.gameId]);

  const text = withBriefing ? `${relay.briefing}\n\n---\n\n${relay.turn}` : relay.turn;
  const playing = msg.phase === 'playing' && view.status === 'active' && msg.deadline !== null;

  const copy = async () => {
    setCopied(await copyText(text));
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="page game">
      <header className="topbar">
        <b style={{ color: PLAYER_COLORS[seat] }}>{seatLabel(seat, msg.seats[seat])}</b>
        <span>
          Round <b>{view.round}</b>/{view.rounds_total}
        </span>
        <span>
          ⏱ <Countdown deadline={msg.deadline} />
        </span>
        <span>
          You: <b>{view.gold}</b> gold · {view.workers.length} workers
        </span>
        <span style={{ color: PLAYER_COLORS[opp] }}>
          {seatLabel(opp, msg.seats[opp])}: <b>{view.opponent.gold}</b> gold · {view.opponent.workers} workers
        </span>
        <span className="muted">{msg.submitted[opp] ? 'opponent submitted' : 'opponent deciding'}</span>
      </header>

      {view.result && (
        <div className="banner">
          {view.result.winner ? (view.result.winner === seat ? '🏆 You win' : 'You lose') : 'Draw'} — {view.result.reason}
        </div>
      )}
      {msg.phase === 'waiting' || msg.phase === 'starting' ? <div className="banner muted">{msg.phaseDetail}</div> : null}
      {msg.phase === 'error' && <div className="banner danger">{msg.phaseDetail}</div>}

      <main className="relay">
        <section>
          <h3>1. Copy this message to your AI</h3>
          <div className="relay-bar">
            <button className="primary" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy message'}
            </button>
            <label className="row small">
              <input type="checkbox" checked={withBriefing} onChange={(e) => setWithBriefing(e.target.checked)} /> Include game rules (needed
              when starting a new AI chat)
            </label>
            <span className="muted small">{text.length.toLocaleString()} chars</span>
          </div>
          <textarea className="mono relay-text" readOnly value={text} onFocus={(e) => e.target.select()} />
        </section>

        <section>
          <h3>2. Paste the AI's reply</h3>
          <textarea
            className="mono relay-text reply"
            placeholder='{"actions": [...], "notes": "...", "rationale": "..."}'
            value={reply}
            disabled={!playing}
            onChange={(e) => setReply(e.target.value)}
          />
          <div className="relay-bar">
            <button className="primary" disabled={!playing || !reply.trim()} onClick={() => send({ type: 'relay', text: reply })}>
              {msg.mySubmission ? 'Resend orders' : 'Send orders'}
            </button>
            {msg.mySubmission && !relay.lastError && <span className="small">✓ orders submitted for round {view.round}</span>}
          </div>
          {(relay.lastError || error) && <p className="danger small">{relay.lastError ?? error}</p>}
          {msg.mySubmission && (
            <div className="small">
              {msg.mySubmission.actions.map((a, i) => (
                <div key={i} className="indent">
                  {a.worker_id}: {String(a.action).toUpperCase()}
                  {a.dx !== undefined || a.dy !== undefined ? ` dx=${a.dx ?? 0} dy=${a.dy ?? 0}` : ''}
                  {a.x !== undefined ? ` to (${a.x},${a.y})` : ''}
                  {a.mine_id ? ` ${a.mine_id}` : ''}
                </div>
              ))}
            </div>
          )}
          <p className="muted small">Workers without a valid action STAY. No reply before the timer runs out = every worker STAYs.</p>
        </section>
      </main>
    </div>
  );
}

/** Clipboard API needs a secure context (https/localhost); fall back to execCommand for LAN http links. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } finally {
    ta.remove();
  }
}
