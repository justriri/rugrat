// The run verdict: how well did the player time their exit against the real historical wallet
// timeline and the collapse? Pure and deterministic: it looks only at the replay data and at the
// player's recorded trade (timestamps and prices that came from the replay clock). It never
// reads a timer, and it is computed from the player's ORIGINAL exit timestamp, not from when the
// post-sale replay finishes.

import type { PlayerState } from './player';
import { currentValueSol } from './player';
import { rugTickIndex } from './timeline';
import type { Replay, ReplayEvent } from './types';

export type Verdict = 'CLEAN_EXIT' | 'LATE_EXIT' | 'RUGGED';

/** USD size of an event: its USD amount, or the estimated value of a token-denominated one. */
export function eventUsd(e: ReplayEvent): number | undefined {
  return e.amountUnit === 'USD' ? e.amount : e.valueUsd;
}

/**
 * The first relevant warning for THIS replay: the earliest event matching the replay's own signal
 * rule (tag, action, minimum USD). Ties keep dataset order. Derived from the event data only; no
 * token, wallet or timestamp is known here.
 */
export function signalEvent(replay: Replay): ReplayEvent | null {
  const rule = replay.signal;
  let best: ReplayEvent | null = null;
  for (const e of replay.events) {
    if (e.tag !== rule.tag || e.action !== rule.action) continue;
    if ((eventUsd(e) ?? 0) < rule.minUsd) continue;
    if (best === null || e.timestamp < best.timestamp) best = e;
  }
  return best;
}

/** Kept for readability at call sites that mean "the verdict's signal". */
export const firstSmartExit = signalEvent;

/** Plain-language name of the signalling group, for copy ("smart wallets", "dev wallet"...). */
export function signalGroupLabel(rule: Replay['signal']): string {
  switch (rule.tag) {
    case 'SMART': return 'smart wallets';
    case 'DEV': return 'dev wallet';
    case 'INSIDER': return 'insiders';
    case 'WHALE': return 'whales';
    case 'LIQUIDITY': return 'liquidity pull';
  }
}

/** Banner shown on the signal wallet in the Reveal. */
export function signalBanner(rule: Replay['signal']): string {
  switch (rule.tag) {
    case 'LIQUIDITY': return 'LIQUIDITY PULL';
    default: return `${rule.tag} WALLET ${rule.action === 'SELL' ? 'EXIT' : rule.action}`;
  }
}

export interface VerdictResult {
  /** The replay this verdict was judged against. */
  rugId: string;
  verdict: Verdict;
  entryPrice: number;
  /** The player's real sell price, or null if they never sold (no sale is invented). */
  exitPrice: number | null;
  exitTimestamp: number | null;
  /** The first qualifying SMART SELL, or null if the replay has none. */
  signalTimestamp: number | null;
  signalEventId: string | null;
  /** Which group the signal comes from (SMART, DEV, ...), for copy. */
  signalTag: Replay['signal']['tag'];
  signalGroup: string;
  /** Seconds the exit was ahead of the signal (+) or behind it (-). Null without an exit or signal. */
  aheadOfSignalSeconds: number | null;
  collapseTimestamp: number;
  collapsePrice: number;
  /** Realised P/L if the player sold; otherwise marked at the collapse price. */
  pnlSol: number;
  pnlPct: number;
  /** Paper SOL the player ends with: cash if they sold, else the holding valued at the collapse price. */
  balanceSol: number;
  /** True when the player was still holding when the collapse happened. */
  heldThroughCollapse: boolean;
}

/** The verdict rule, on its own: the single place it is written down. */
export function verdictForExit(replay: Replay, exitTimestamp: number | null): Verdict {
  if (exitTimestamp === null || exitTimestamp >= replay.rugTimestamp) return 'RUGGED';
  const signal = signalEvent(replay);
  return signal !== null && exitTimestamp >= signal.timestamp ? 'LATE_EXIT' : 'CLEAN_EXIT';
}

/**
 * playerExit <  firstSmartExit                      -> CLEAN_EXIT
 * firstSmartExit <= playerExit < collapse           -> LATE_EXIT   (an exact tie is LATE)
 * playerExit >= collapse, or never exited           -> RUGGED
 *
 * Returns null when the player never bought: there is no position to judge.
 */
export function computeVerdict(replay: Replay, player: PlayerState): VerdictResult | null {
  if (player.buyTimestamp === null || player.buyPrice === null) return null;

  const signal = signalEvent(replay);
  const collapseTimestamp = replay.rugTimestamp;
  const collapsePrice = replay.ticks[rugTickIndex(replay)].price;
  const exited = player.exited && player.sellTimestamp !== null;

  const verdict = verdictForExit(replay, exited ? (player.sellTimestamp as number) : null);

  let pnlSol: number;
  let pnlPct: number;
  let balanceSol: number;
  if (exited) {
    pnlSol = player.realizedPnlSol;
    pnlPct = player.realizedPnlPct ?? 0;
    balanceSol = player.paperSol;
  } else {
    balanceSol = player.paperSol + currentValueSol(player, collapsePrice, replay.paperSolUsd);
    pnlSol = balanceSol - player.solSpent;
    pnlPct = (balanceSol / player.solSpent - 1) * 100;
  }

  return {
    rugId: replay.id,
    verdict,
    entryPrice: player.buyPrice,
    exitPrice: exited ? player.sellPrice : null,
    exitTimestamp: exited ? player.sellTimestamp : null,
    signalTimestamp: signal ? signal.timestamp : null,
    signalEventId: signal ? signal.id : null,
    signalTag: replay.signal.tag,
    signalGroup: signalGroupLabel(replay.signal),
    aheadOfSignalSeconds: exited && signal ? signal.timestamp - (player.sellTimestamp as number) : null,
    collapseTimestamp,
    collapsePrice,
    pnlSol,
    pnlPct,
    balanceSol,
    heldThroughCollapse: !exited,
  };
}
