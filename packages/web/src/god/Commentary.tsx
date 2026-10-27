import { PLAYERS, type GodUpdate, type Mine, type PlayerId } from '@gold-war/engine';
import { PLAYER_COLORS } from '../common';
import { snapshotBefore } from './replay';

export interface Line {
  icon: string;
  text: string;
  player?: PlayerId;
  big?: boolean;
}

const P = (p: PlayerId) => p.toUpperCase();

/** Play-by-play for one resolved round, written from its events. */
export function commentary(msg: GodUpdate, round: number): Line[] {
  const rec = msg.history[round - 1];
  if (!rec) return [];
  const mines = new Map<string, Mine>(msg.state.mines.map((m) => [m.id, m]));
  const { payoutMax } = msg.state.settings;
  const out: Line[] = [];
  const moved: Record<PlayerId, number> = { p1: 0, p2: 0 };

  for (const e of rec.events) {
    switch (e.type) {
      case 'move':
        moved[e.player]++;
        break;
      case 'collect': {
        const both = e.workers.p1 > 0 && e.workers.p2 > 0;
        if (!both) {
          const p: PlayerId = e.workers.p1 > 0 ? 'p1' : 'p2';
          out.push({ icon: '⛏️', player: p, text: `${P(p)} mines ${e.mineId} for +${e.gained[p]}${e.workers[p] > 1 ? ` (${e.workers[p]} workers, wasted extras)` : ''}` });
        } else if (e.workers.p1 === e.workers.p2) {
          out.push({ icon: '⚔️', text: `Standoff at ${e.mineId}: ${e.workers.p1} vs ${e.workers.p2}, payout split +${e.gained.p1} each` });
        } else {
          const w: PlayerId = e.workers.p1 > e.workers.p2 ? 'p1' : 'p2';
          const l: PlayerId = w === 'p1' ? 'p2' : 'p1';
          out.push({ icon: '⚔️', player: w, big: true, text: `${P(w)} steals ${e.mineId} from ${P(l)}, ${e.workers[w]} workers vs ${e.workers[l]}: +${e.gained[w]}` });
        }
        break;
      }
      case 'discover': {
        const m = mines.get(e.mineId);
        const jackpot = m && m.payout === payoutMax;
        out.push({ icon: jackpot ? '💎' : '🔍', player: e.player, big: !!jackpot, text: `${P(e.player)} discovers ${e.mineId}${m ? ` (pays ${m.payout})` : ''}${jackpot ? ', a jackpot!' : ''}` });
        break;
      }
      case 'delete':
        out.push({ icon: '💨', player: e.player, text: `${P(e.player)} retires worker ${e.workerId}` });
        break;
      case 'downgrade':
        out.push({ icon: '💸', player: e.player, text: `${P(e.player)} can't afford ${e.workerId}'s ${e.from}: ${e.to} instead` });
        break;
      case 'invalid':
        out.push({ icon: '❌', player: e.player, text: `${P(e.player)} ${e.workerId}: ${e.reason}` });
        break;
      case 'end':
        out.push({ icon: '🏆', big: true, player: e.result.winner ?? undefined, text: e.result.winner ? `${P(e.result.winner)} wins! ${e.result.reason}` : `Draw: ${e.result.reason}` });
        break;
    }
  }
  for (const p of PLAYERS) if (moved[p]) out.unshift({ icon: '🚶', player: p, text: `${P(p)} moves ${moved[p]} worker${moved[p] > 1 ? 's' : ''}` });

  // Lead changes.
  const before = snapshotBefore(msg, round).players;
  const after = rec.snapshot.players;
  const lead = (s: typeof after) => (s.p1.gold > s.p2.gold ? 'p1' : s.p2.gold > s.p1.gold ? 'p2' : null);
  const lb = lead(before);
  const la = lead(after);
  if (la && la !== lb) out.push({ icon: '📈', player: la, big: true, text: `${P(la)} takes the lead, ${after[la].gold} vs ${after[la === 'p1' ? 'p2' : 'p1'].gold}` });
  else if (!la && lb) out.push({ icon: '🤝', text: `All square at ${after.p1.gold} gold each` });
  return out;
}

/** Newest round first; rounds after `upTo` (replay position) stay hidden. */
export function CommentaryFeed({ msg, upTo, onPick }: { msg: GodUpdate; upTo: number; onPick: (r: number) => void }) {
  const rounds = Array.from({ length: upTo }, (_, i) => upTo - i);
  if (!rounds.length) return <p className="muted small">The first round has not resolved yet.</p>;
  return (
    <div className="feed">
      {rounds.map((r) => {
        const lines = commentary(msg, r);
        return (
          <div key={r} className="feed-round">
            <button className="feed-head" onClick={() => onPick(r)} title="replay this round">
              Round {r} ▸
            </button>
            {lines.length === 0 && <div className="feed-line muted">Quiet round.</div>}
            {lines.map((l, i) => (
              <div key={i} className={`feed-line${l.big ? ' big' : ''}`}>
                <span className="feed-icon" aria-hidden="true">
                  {l.icon}
                </span>
                <span style={{ borderLeftColor: l.player ? PLAYER_COLORS[l.player] : 'transparent' }} className="feed-text">
                  {l.text}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
