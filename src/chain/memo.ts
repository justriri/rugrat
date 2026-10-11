// The onchain score record: a plain representation of an existing RunResult, written into a Memo.
// It is NOT a second scoring system. The score in the memo is the score the game already produced;
// verification only checks that the record is internally consistent with the replay catalogue and
// with the game's own score and verdict rules.
//
// Memo text:  rugreplay/1 {"r":"<runId>","u":"<rugId>","w":"<wallet>","d":"CLEAN_EXIT",...}
import type { RunResult } from '../competition/result';
import { SCORE_VERSION, scoreRun } from '../competition/score';
import type { Replay } from '../game/types';
import { Verdict, verdictForExit } from '../game/verdict';

/** Game + record format identifier. Bump the number only when the record's shape changes. */
export const MEMO_PREFIX = 'rugreplay/1';
const GAME_FORMAT = /^rugreplay\/(\d+)$/;
/** A Solana memo is at most 566 bytes; stay under it. */
export const MAX_MEMO_BYTES = 566;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERDICTS: readonly Verdict[] = ['CLEAN_EXIT', 'LATE_EXIT', 'RUGGED'];

export interface OnchainScoreRecord {
  /** Run id from the RunResult. */
  runId: string;
  rugId: string;
  /** The wallet that signs the memo. */
  wallet: string;
  verdict: Verdict;
  score: number;
  scoreVersion: number;
  realizedPnlPct: number | null;
  entryTimestamp: number;
  exitTimestamp: number | null;
  survivalSeconds: number;
}

/** Field-for-field copy of the RunResult plus the wallet; nothing is recomputed. */
export function recordFromRunResult(run: RunResult, wallet: string): OnchainScoreRecord {
  return Object.freeze({
    runId: run.runId,
    rugId: run.rugId,
    wallet,
    verdict: run.verdict,
    score: run.score,
    scoreVersion: run.scoreVersion,
    realizedPnlPct: run.realizedPnlPct,
    entryTimestamp: run.entryTimestamp,
    exitTimestamp: run.exitTimestamp,
    survivalSeconds: run.survivalSeconds,
  });
}

/** Deterministic: fixed key order, so the same record is always the same text. */
export function serializeMemo(rec: OnchainScoreRecord): string {
  const body = JSON.stringify({
    r: rec.runId,
    u: rec.rugId,
    w: rec.wallet,
    d: rec.verdict,
    s: rec.score,
    v: rec.scoreVersion,
    p: rec.realizedPnlPct,
    e: rec.entryTimestamp,
    x: rec.exitTimestamp,
    t: rec.survivalSeconds,
  });
  return `${MEMO_PREFIX} ${body}`;
}

export const memoFromRunResult = (run: RunResult, wallet: string): string => serializeMemo(recordFromRunResult(run, wallet));

export type ParseResult = { ok: true; record: OnchainScoreRecord } | { ok: false; reason: string };

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** Strict parser: anything unexpected is a rejection, never a guess. */
export function parseMemo(text: string): ParseResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not text' };
  const sp = text.indexOf(' ');
  if (sp < 0) return { ok: false, reason: 'no game identifier' };
  const m = GAME_FORMAT.exec(text.slice(0, sp));
  if (!m) return { ok: false, reason: 'not a Rug Replay memo' };
  if (text.slice(0, sp) !== MEMO_PREFIX) return { ok: false, reason: `unsupported record version ${m[1]}` };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(sp + 1));
  } catch {
    return { ok: false, reason: 'malformed record' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'malformed record' };
  if (Object.keys(j).sort().join(',') !== 'd,e,p,r,s,t,u,v,w,x') return { ok: false, reason: 'unexpected or missing fields' };
  if (!isStr(j.r) || !isStr(j.u) || !isStr(j.w)) return { ok: false, reason: 'bad identifier fields' };
  if (!BASE58_ADDRESS.test(j.w)) return { ok: false, reason: 'bad wallet address' };
  if (!VERDICTS.includes(j.d as Verdict)) return { ok: false, reason: 'bad verdict' };
  if (!isNum(j.s) || !isNum(j.v) || !isNum(j.e) || !isNum(j.t)) return { ok: false, reason: 'bad numeric fields' };
  if (!(j.p === null || isNum(j.p)) || !(j.x === null || isNum(j.x))) return { ok: false, reason: 'bad numeric fields' };
  return {
    ok: true,
    record: {
      runId: j.r,
      rugId: j.u,
      wallet: j.w,
      verdict: j.d as Verdict,
      score: j.s,
      scoreVersion: j.v,
      realizedPnlPct: j.p as number | null,
      entryTimestamp: j.e,
      exitTimestamp: j.x as number | null,
      survivalSeconds: j.t,
    },
  };
}

export interface VerifyOptions {
  /** The catalogue to judge against (the app's real replays). */
  replays: readonly Replay[];
  /** If given, the record's wallet must be this one. */
  expectedWallet?: string;
}
export type VerifyResult = { ok: true; replay: Replay } | { ok: false; problems: string[] };

/**
 * Checks a record against the catalogue and the game's own rules: known rug, timestamps inside the
 * replay window, the verdict the game's rule gives for that exit, and the score the game's score
 * function gives for it. It uses the same functions the game used. It cannot prove the player
 * really played the run: that needs an authoritative issuer (see the report).
 */
export function verifyRecord(rec: OnchainScoreRecord, opts: VerifyOptions): VerifyResult {
  const problems: string[] = [];
  const replay = opts.replays.find((r) => r.id === rec.rugId);
  if (!replay) return { ok: false, problems: [`unknown rug "${rec.rugId}"`] };
  if (opts.expectedWallet !== undefined && rec.wallet !== opts.expectedWallet) problems.push('wallet does not match');
  if (!rec.runId.includes(`|${rec.rugId}|`)) problems.push('run id does not belong to this rug');
  if (rec.scoreVersion !== SCORE_VERSION) problems.push(`unknown score version ${rec.scoreVersion}`);
  const inWindow = (t: number) => t >= replay.replayStart && t <= replay.replayEnd;
  if (!inWindow(rec.entryTimestamp)) problems.push('entry is outside the replay');
  if (rec.entryTimestamp >= replay.rugTimestamp) problems.push('entry is at or after the collapse');
  if (rec.exitTimestamp !== null && (!inWindow(rec.exitTimestamp) || rec.exitTimestamp < rec.entryTimestamp)) problems.push('exit is outside the replay or before entry');
  if (rec.verdict !== verdictForExit(replay, rec.exitTimestamp)) problems.push('verdict does not match the exit time');
  const expectScore = scoreRun({
    verdict: rec.verdict,
    entryTimestamp: rec.entryTimestamp,
    exitTimestamp: rec.exitTimestamp,
    collapseTimestamp: replay.rugTimestamp,
  }).total;
  if (rec.score !== expectScore) problems.push('score does not match the game rules');
  const expectSurvival = Math.max(0, Math.min(rec.exitTimestamp ?? replay.rugTimestamp, replay.rugTimestamp) - rec.entryTimestamp);
  if (Math.abs(rec.survivalSeconds - expectSurvival) > 1e-6) problems.push('survival duration does not match');
  if ((rec.exitTimestamp === null) !== (rec.realizedPnlPct === null)) problems.push('P/L and exit disagree');
  return problems.length ? { ok: false, problems } : { ok: true, replay };
}

/** True when the record is the onchain form of exactly this RunResult. */
export function matchesRunResult(rec: OnchainScoreRecord, run: RunResult, wallet: string): boolean {
  return serializeMemo(rec) === memoFromRunResult(run, wallet);
}
