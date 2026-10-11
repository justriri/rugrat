// SKR weekly prize pool: ACCOUNTING AND PLANNING ONLY. This module never moves funds and there is
// no code anywhere that sends a payout. Real payouts are locked behind PAYOUT_GATE until the legal
// and platform review is confirmed by the business owner.
//
// Principles (they are enforced by the shape of the functions, and by tests):
//  - FREE TO PLAY: nobody pays to enter; nothing here reads a payment or an SKR balance. The money
//    in the pool comes from cosmetic badge upgrades, which have no effect on eligibility or rank.
//  - SKILL RANKED: ranking uses only verified onchain skill scores (the existing score formula),
//    never money, P/L, SKR holdings or purchases.
//  - VERIFIED ONLY: demo players, local-only results and unverified records cannot appear.
import { uniqueVerifiedSurvivingRugs } from '../badge/achievement';
import type { VerifiedChainRun } from '../chain/verifyTx';

/** Percent split of incoming SKR. Operations and reserve are rounded down; the pool takes the remainder. */
export const POOL_SPLIT = Object.freeze({ pool: 70n, operations: 20n, reserve: 10n });
/** Share of the weekly pool for ranks 1..3, in percent. */
export const PAYOUT_SHARES: readonly bigint[] = Object.freeze([50n, 30n, 20n]);

export interface FundSplit {
  pool: bigint;
  operations: bigint;
  reserve: bigint;
}

/** Exact integer split of `total` base units: the three parts always sum to `total`. */
export function splitFunds(total: bigint): FundSplit {
  if (total < 0n) throw new Error('negative amount');
  const operations = (total * POOL_SPLIT.operations) / 100n;
  const reserve = (total * POOL_SPLIT.reserve) / 100n;
  return { pool: total - operations - reserve, operations, reserve };
}

// ---------------------------------------------------------------- weeks (UTC, Monday 00:00 start)
export interface Week {
  /** e.g. "2026-W41" (ISO 8601 week). */
  id: string;
  start: number;
  /** Exclusive. */
  end: number;
}
const DAY = 86400;
export function weekOf(unixSeconds: number): Week {
  const d = new Date(unixSeconds * 1000);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const start = dayStart - dow * DAY;
  // ISO week-year: the year of the week's Thursday
  const thursday = new Date((start + 3 * DAY) * 1000);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1) / 1000;
  const week = Math.floor((Math.floor((start + 3 * DAY - jan1) / DAY)) / 7) + 1;
  return { id: `${isoYear}-W${String(week).padStart(2, '0')}`, start, end: start + 7 * DAY };
}

// ---------------------------------------------------------------- ranking
/** A verified onchain record plus WHEN the chain recorded it (the transaction's block time). */
export interface TimedVerifiedRun {
  run: VerifiedChainRun;
  blockTime: number;
}

export interface RankedPlayer {
  rank: number;
  wallet: string;
  /** Sum of the best score on each rug recorded in the week. */
  score: number;
  rugsSurvived: number;
  cleanExits: number;
}

/**
 * Weekly ranking from verified records whose block time falls in the week. One result per rug per
 * wallet (the best), exactly like the in-game leaderboard. Ties: more clean exits, more rugs
 * survived, then wallet address, so the order is deterministic.
 */
export function rankWeek(runs: readonly TimedVerifiedRun[], week: Week): RankedPlayer[] {
  const best = new Map<string, Map<string, VerifiedChainRun['record']>>();
  for (const { run, blockTime } of runs) {
    if (blockTime < week.start || blockTime >= week.end) continue;
    const rec = run.record;
    if (rec.wallet !== run.wallet) continue;
    const perRug = best.get(rec.wallet) ?? new Map();
    const cur = perRug.get(rec.rugId);
    if (!cur || rec.score > cur.score || (rec.score === cur.score && rec.runId < cur.runId)) perRug.set(rec.rugId, rec);
    best.set(rec.wallet, perRug);
  }
  const rows = [...best.entries()].map(([wallet, perRug]) => {
    const recs = [...perRug.values()];
    return {
      wallet,
      score: recs.reduce((s, r) => s + r.score, 0),
      rugsSurvived: recs.filter((r) => r.verdict !== 'RUGGED').length,
      cleanExits: recs.filter((r) => r.verdict === 'CLEAN_EXIT').length,
    };
  });
  rows.sort((a, b) => b.score - a.score || b.cleanExits - a.cleanExits || b.rugsSurvived - a.rugsSurvived || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  // a week with no surviving rug scores 0 and wins nothing
  return rows.filter((r) => r.score > 0).map((r, i) => ({ rank: i + 1, ...r }));
}

export interface PayoutLine {
  rank: number;
  wallet: string;
  /** Base units of the payment token. */
  amount: bigint;
}

/** Who WOULD be paid what. Pure arithmetic: the plan's total never exceeds the pool. */
export function planPayouts(pool: bigint, ranked: readonly RankedPlayer[]): PayoutLine[] {
  const winners = ranked.slice(0, PAYOUT_SHARES.length);
  if (winners.length === 0 || pool <= 0n) return [];
  // shares of the places actually filled are re-normalised, so a pool is never left unclaimed because rank 3 is empty
  const totalShare = PAYOUT_SHARES.slice(0, winners.length).reduce((s, x) => s + x, 0n);
  const lines = winners.map((w, i) => ({ rank: w.rank, wallet: w.wallet, amount: (pool * PAYOUT_SHARES[i]) / totalShare }));
  lines[0].amount += pool - lines.reduce((s, l) => s + l.amount, 0n); // rounding dust goes to rank 1
  return lines;
}

// ---------------------------------------------------------------- the gate
export interface PayoutGate {
  /** Operator switch. */
  enabled: boolean;
  /** Must be set to true by the business owner ONLY after the legal / platform review. */
  legalReviewConfirmed: boolean;
}
/** Locked. Nothing in the app or backend flips this. */
export const PAYOUT_GATE: PayoutGate = Object.freeze({ enabled: false, legalReviewConfirmed: false });

export class PayoutsLocked extends Error {
  constructor() {
    super('Prize payouts are locked until the legal and platform review is confirmed.');
  }
}
/** Any future payout code must call this first. */
export function assertPayoutsAllowed(gate: PayoutGate = PAYOUT_GATE): void {
  if (!gate.enabled || !gate.legalReviewConfirmed) throw new PayoutsLocked();
}

/** A prize needs verified, non-demo play only; paying for anything is never a condition. */
export function isPrizeEligible(runs: readonly VerifiedChainRun[], wallet: string, replays: Parameters<typeof uniqueVerifiedSurvivingRugs>[2]): boolean {
  return uniqueVerifiedSurvivingRugs(runs, wallet, replays).count > 0;
}
