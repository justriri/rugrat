// Rug Hunter: survive 3 unique real rugs. THE single source of truth for that requirement.
//
// The only input is a list of VerifiedChainRun values: score records that were read back from the
// chain and checked (src/chain/verifyTx.ts). A local counter, a local run list, a DEMO player or an
// unverified record cannot be passed in, so none of them can unlock the badge.
import type { Replay } from '../game/types';
import type { VerifiedChainRun } from '../chain/verifyTx';

export const RUG_HUNTER_REQUIRED = 3;
export const ACHIEVEMENT_ID = 'rug-hunter';
export const ACHIEVEMENT_VERSION = 1;

export interface CountedRug {
  rugId: string;
  rugSymbol: string;
  rugName: string;
  /** The verdict of the counted run: CLEAN_EXIT or LATE_EXIT. */
  verdict: 'CLEAN_EXIT' | 'LATE_EXIT';
  score: number;
  runId: string;
  /** The memo transaction that proves it. */
  signature: string;
}

export interface AchievementProgress {
  required: number;
  /** One entry per unique rug survived, in catalogue order. */
  counted: CountedRug[];
  /** Unique verified surviving rugs. */
  count: number;
  unlocked: boolean;
}

/**
 * Unique verified surviving rugs for one wallet. A run counts only if all of these hold:
 *  - it was verified from the chain and signed by `wallet`;
 *  - it is one of the real catalogue rugs (DEMO / unknown rugs never match);
 *  - its verdict is CLEAN_EXIT or LATE_EXIT (RUGGED never counts).
 * Each rug counts once; when a rug was survived several times, its best-scoring run represents it
 * (ties go to the lower run id), so the result does not depend on input order.
 */
export function uniqueVerifiedSurvivingRugs(runs: readonly VerifiedChainRun[], wallet: string, replays: readonly Replay[]): AchievementProgress {
  const best = new Map<string, VerifiedChainRun>();
  for (const run of runs) {
    const rec = run.record;
    if (run.wallet !== wallet || rec.wallet !== wallet) continue;
    if (rec.verdict === 'RUGGED') continue;
    if (!replays.some((r) => r.id === rec.rugId)) continue;
    const cur = best.get(rec.rugId);
    if (!cur || rec.score > cur.record.score || (rec.score === cur.record.score && rec.runId < cur.record.runId)) best.set(rec.rugId, run);
  }
  const counted: CountedRug[] = [];
  for (const replay of replays) {
    const run = best.get(replay.id);
    if (!run) continue;
    counted.push({
      rugId: replay.id,
      rugSymbol: replay.symbol,
      rugName: replay.name,
      verdict: run.record.verdict as 'CLEAN_EXIT' | 'LATE_EXIT',
      score: run.record.score,
      runId: run.record.runId,
      signature: run.signature,
    });
  }
  return { required: RUG_HUNTER_REQUIRED, counted, count: counted.length, unlocked: counted.length >= RUG_HUNTER_REQUIRED };
}

export type BadgeStatus = 'LOCKED' | 'UNLOCKED' | 'CLAIMED';

/** CLAIMED once a claim exists for this wallet; otherwise UNLOCKED/LOCKED by verified progress. */
export function badgeStatus(progress: AchievementProgress, claimed: boolean): BadgeStatus {
  if (claimed) return 'CLAIMED';
  return progress.unlocked ? 'UNLOCKED' : 'LOCKED';
}
