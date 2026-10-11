import type { RunResult } from './result';
import { bestPerRug, PlayerRecord } from './stats';

export type Comparison =
  | { ok: true; rugId: string; startingPaperSol: number; you: RunResult; friend: RunResult; winner: 'you' | 'friend' | 'tie' }
  | { ok: false; reason: 'NO_YOU' | 'NO_FRIEND' | 'DIFFERENT_START' };

/**
 * Two players compared on the SAME historical rug. Both results must be for that rug and both
 * must have started from the same paper balance; otherwise there is no comparison at all.
 */
export function compareOnRug(you: PlayerRecord, friend: PlayerRecord, rugId: string): Comparison {
  const mine = bestPerRug(you.runs).find((r) => r.rugId === rugId);
  const theirs = bestPerRug(friend.runs).find((r) => r.rugId === rugId);
  if (!mine) return { ok: false, reason: 'NO_YOU' };
  if (!theirs) return { ok: false, reason: 'NO_FRIEND' };
  if (mine.startingPaperSol !== theirs.startingPaperSol) return { ok: false, reason: 'DIFFERENT_START' };
  return {
    ok: true,
    rugId,
    startingPaperSol: mine.startingPaperSol,
    you: mine,
    friend: theirs,
    winner: mine.score > theirs.score ? 'you' : mine.score < theirs.score ? 'friend' : 'tie',
  };
}
