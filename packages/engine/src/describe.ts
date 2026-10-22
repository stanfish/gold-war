import type { PlayerId, RoundEvent } from './types.js';

/** One-line, human-readable description of a round event ("you" = `me`). */
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
