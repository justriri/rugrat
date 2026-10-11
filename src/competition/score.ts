// The skill score. Simple, explainable, and independent of money.
//
//   RUGGED (still in at the collapse, or sold into it)  ->   0
//   survived (sold before the collapse)                  -> 500
//   + CLEAN EXIT (sold before the important signal)      -> +300
//   + staying in: up to +200 for how much of the time between your entry and the
//     collapse you stayed in before selling (later exits while still surviving score more)
//
//   LATE EXIT: 500..700     CLEAN EXIT: 800..1000     RUGGED: 0
//
// Every CLEAN EXIT therefore scores above every LATE EXIT, and every LATE EXIT above RUGGED.
// The input has no amount, balance, token quantity or P/L, and no rug is special-cased: the same
// formula applies to every replay. It reads only the verdict and historical timestamps, so it
// cannot depend on frame rate or playback speed.
import type { Verdict } from '../game/verdict';

export const SCORE_VERSION = 1;
export const SCORE_WEIGHTS = { survive: 500, clean: 300, stay: 200 } as const;

export interface ScoreInput {
  verdict: Verdict;
  entryTimestamp: number;
  exitTimestamp: number | null;
  collapseTimestamp: number;
}

export interface ScoreBreakdown {
  survive: number;
  clean: number;
  stay: number;
  total: number;
}

export function scoreRun(i: ScoreInput): ScoreBreakdown {
  if (i.verdict === 'RUGGED' || i.exitTimestamp === null) return { survive: 0, clean: 0, stay: 0, total: 0 };
  const window = i.collapseTimestamp - i.entryTimestamp;
  const stayFraction = window > 0 ? Math.min(1, Math.max(0, (i.exitTimestamp - i.entryTimestamp) / window)) : 0;
  const survive = SCORE_WEIGHTS.survive;
  const clean = i.verdict === 'CLEAN_EXIT' ? SCORE_WEIGHTS.clean : 0;
  const stay = Math.round(SCORE_WEIGHTS.stay * stayFraction);
  return { survive, clean, stay, total: survive + clean + stay };
}
