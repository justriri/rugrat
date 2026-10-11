// The standardized result of a completed run. Built from the existing player state and verdict:
// no trading or verdict logic is duplicated here. The shape is deliberately flat and JSON-safe so
// a later step can record it somewhere else (for example on-chain) without reshaping it.
import { newPlayer, PlayerState } from '../game/player';
import type { Replay } from '../game/types';
import { computeVerdict, Verdict } from '../game/verdict';
import { SCORE_VERSION, scoreRun } from './score';

/** The local player, until a real identity exists. */
export const LOCAL_PLAYER_ID = 'you';

export interface RunResult {
  /** Deterministic from the run itself, so the same run always has the same id. */
  runId: string;
  playerId: string;
  /** The replay id: every result belongs to exactly one rug. */
  rugId: string;
  rugSymbol: string;
  /** Everyone starts every replay with the same paper balance; compared runs must share it. */
  startingPaperSol: number;
  /** Sold before the collapse. */
  survived: boolean;
  verdict: Verdict;
  entryTimestamp: number;
  exitTimestamp: number | null;
  exitPrice: number | null;
  /** Realised P/L %, informational only (null when the player never sold). Never used for scoring. */
  realizedPnlPct: number | null;
  /** Seconds of historical time from entry until the exit (or the collapse, if not sold before it). */
  survivalSeconds: number;
  isClean: boolean;
  isLate: boolean;
  isRugged: boolean;
  signalTimestamp: number | null;
  collapseTimestamp: number;
  score: number;
  scoreVersion: number;
}

export function runIdFor(playerId: string, rugId: string, entryTimestamp: number, exitTimestamp: number | null): string {
  return `${playerId}|${rugId}|${entryTimestamp.toFixed(3)}|${exitTimestamp === null ? 'held' : exitTimestamp.toFixed(3)}`;
}

/** A player who never bought has no result: there is nothing to judge. */
export function buildRunResult(replay: Replay, player: PlayerState, playerId: string): RunResult | null {
  const v = computeVerdict(replay, player);
  if (!v || player.buyTimestamp === null) return null;
  const entry = player.buyTimestamp;
  const exit = v.exitTimestamp;
  const survivalSeconds = Math.max(0, Math.min(exit ?? v.collapseTimestamp, v.collapseTimestamp) - entry);
  return {
    runId: runIdFor(playerId, replay.id, entry, exit),
    playerId,
    rugId: replay.id,
    rugSymbol: replay.symbol,
    startingPaperSol: newPlayer().paperSol,
    survived: v.verdict !== 'RUGGED',
    verdict: v.verdict,
    entryTimestamp: entry,
    exitTimestamp: exit,
    exitPrice: v.exitPrice,
    realizedPnlPct: player.exited ? player.realizedPnlPct : null,
    survivalSeconds,
    isClean: v.verdict === 'CLEAN_EXIT',
    isLate: v.verdict === 'LATE_EXIT',
    isRugged: v.verdict === 'RUGGED',
    signalTimestamp: v.signalTimestamp,
    collapseTimestamp: v.collapseTimestamp,
    score: scoreRun({ verdict: v.verdict, entryTimestamp: entry, exitTimestamp: exit, collapseTimestamp: v.collapseTimestamp }).total,
    scoreVersion: SCORE_VERSION,
  };
}
