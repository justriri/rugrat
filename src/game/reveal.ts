// The Historical Reveal: after the run, the same replay plays again with everything visible.
// This module is pure. The Reveal is explanatory only: it reads the player's recorded trade and
// the replay data, and never changes either.

import type { PlayerState } from './player';
import { rugTickIndex, tickIndexAt, TimelineMarker } from './timeline';
import type { Replay, ReplayEvent, WalletTag } from './types';
import { signalEvent } from './verdict';

/**
 * Markers the Reveal replays on the shared timeline, in chronological order:
 * the player's entry, the player's exit (if any), and the collapse. A player who is still in when
 * the collapse happens gets a HELD marker at that moment instead of an exit.
 */
export function revealMarkers(replay: Replay, player: PlayerState): TimelineMarker[] {
  const out: TimelineMarker[] = [];
  if (player.buyTimestamp !== null && player.buyTickIndex !== null) {
    out.push({ timestamp: player.buyTimestamp, kind: 'BUY', tickIndex: player.buyTickIndex });
  }
  if (player.exited && player.sellTimestamp !== null && player.sellTickIndex !== null) {
    out.push({ timestamp: player.sellTimestamp, kind: 'SELL', tickIndex: player.sellTickIndex });
  }
  const rugIndex = rugTickIndex(replay);
  if (player.buyTimestamp !== null && !player.exited) {
    out.push({ timestamp: replay.rugTimestamp, kind: 'HELD', tickIndex: rugIndex });
  }
  out.push({ timestamp: replay.rugTimestamp, kind: 'COLLAPSE', tickIndex: rugIndex });
  // stable chronological order (equal timestamps keep the order above)
  return out.map((m, i) => ({ m, i })).sort((a, b) => a.m.timestamp - b.m.timestamp || a.i - b.i).map((x) => x.m);
}

const PRIORITY: Record<WalletTag, number> = { SMART: 40, LIQUIDITY: 35, DEV: 30, INSIDER: 20, WHALE: 10 };

/**
 * Who stays on screen when the character cap is hit: the verdict signal first, then SMART, DEV,
 * INSIDER, WHALE. Untagged events rank lowest. Used only during the Reveal.
 */
export function eventPriority(event: ReplayEvent, isSignal: boolean): number {
  if (isSignal) return 100;
  return event.tag ? PRIORITY[event.tag] : 0;
}

export interface RevealSummary {
  /** The replay this reveal explains. */
  rugId: string;
  entry: { price: number; timestamp: number } | null;
  /** The player's real exit, or null when they never sold. */
  exit: { price: number; timestamp: number } | null;
  heldThroughCollapse: boolean;
  /** The first major smart-wallet exit: the same event the verdict uses. */
  signal: { timestamp: number; price: number; wallet: string; amountUsd: number; eventId: string } | null;
  collapse: { price: number; timestamp: number };
}

export function buildRevealSummary(replay: Replay, player: PlayerState): RevealSummary {
  const sig = signalEvent(replay);
  const priceAt = (t: number) => replay.ticks[Math.max(0, tickIndexAt(replay, t))].price;
  const traded = player.buyTimestamp !== null && player.buyPrice !== null;
  return {
    rugId: replay.id,
    entry: traded ? { price: player.buyPrice as number, timestamp: player.buyTimestamp as number } : null,
    exit:
      player.exited && player.sellPrice !== null && player.sellTimestamp !== null
        ? { price: player.sellPrice, timestamp: player.sellTimestamp }
        : null,
    heldThroughCollapse: traded && !player.exited,
    signal: sig
      ? { timestamp: sig.timestamp, price: priceAt(sig.timestamp), wallet: sig.wallet, amountUsd: sig.amount ?? 0, eventId: sig.id }
      : null,
    collapse: { price: replay.ticks[rugTickIndex(replay)].price, timestamp: replay.rugTimestamp },
  };
}
