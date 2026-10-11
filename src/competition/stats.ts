// Per-player aggregation over run results. Nothing here looks at money: only survival, verdict,
// timing and the skill score.
import type { RunResult } from './result';

/** A player and the runs they have completed. `demo` marks mock records that are not real users. */
export interface PlayerRecord {
  playerId: string;
  name: string;
  demo: boolean;
  runs: RunResult[];
}

/**
 * One result per rug: the best one (highest score; ties go to the lower runId, so it is
 * deterministic). Replaying the same rug many times can therefore not inflate anyone's totals.
 */
export function bestPerRug(runs: readonly RunResult[]): RunResult[] {
  const best = new Map<string, RunResult>();
  for (const r of runs) {
    const cur = best.get(r.rugId);
    if (!cur || r.score > cur.score || (r.score === cur.score && r.runId < cur.runId)) best.set(r.rugId, r);
  }
  return [...best.values()].sort((a, b) => (a.rugId < b.rugId ? -1 : 1));
}

export interface PlayerStats {
  /** Sum of the best score on each rug played (the "ALL RUGS" leaderboard score). */
  totalScore: number;
  /** The single best score on any rug. */
  bestSurvivalScore: number;
  rugsPlayed: number;
  /** Rugs where the player's best result survived. */
  rugsSurvived: number;
  cleanExits: number;
  lateExits: number;
  rugsRugged: number;
  /** Best realised P/L % over all runs that sold (informational, never scored). */
  bestPnlPct: number | null;
  /** The shortest time in a position among runs that actually survived. */
  fastestSuccessfulExit: { seconds: number; rugId: string; rugSymbol: string } | null;
}

export function computeStats(runs: readonly RunResult[], rugId?: string): PlayerStats {
  const scoped = rugId ? runs.filter((r) => r.rugId === rugId) : runs;
  const best = bestPerRug(scoped);
  let fastest: PlayerStats['fastestSuccessfulExit'] = null;
  let bestPnl: number | null = null;
  for (const r of scoped) {
    if (r.realizedPnlPct !== null && (bestPnl === null || r.realizedPnlPct > bestPnl)) bestPnl = r.realizedPnlPct;
    // only a run that really survived (sold before the collapse) can be a "successful exit"
    if (r.survived && r.exitTimestamp !== null && (fastest === null || r.survivalSeconds < fastest.seconds)) {
      fastest = { seconds: r.survivalSeconds, rugId: r.rugId, rugSymbol: r.rugSymbol };
    }
  }
  return {
    totalScore: best.reduce((s, r) => s + r.score, 0),
    bestSurvivalScore: best.reduce((m, r) => Math.max(m, r.score), 0),
    rugsPlayed: best.length,
    rugsSurvived: best.filter((r) => r.survived).length,
    cleanExits: best.filter((r) => r.isClean).length,
    lateExits: best.filter((r) => r.isLate).length,
    rugsRugged: best.filter((r) => r.isRugged).length,
    bestPnlPct: bestPnl,
    fastestSuccessfulExit: fastest,
  };
}

/** Adds a run unless one with the same (deterministic) id is already there. */
export function addRunIfNew(runs: readonly RunResult[], run: RunResult): RunResult[] {
  return runs.some((r) => r.runId === run.runId) ? [...runs] : [...runs, run];
}
