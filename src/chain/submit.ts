// "Record score onchain" as a pure orchestration over injected dependencies, so every outcome
// (success, rejection, duplicate, RPC failure, interruption) is testable without a device.
// Nothing in here can touch the saved RunResult: it only reads it and writes ChainRecords.
import type { RunResult } from '../competition/result';
import type { Replay } from '../game/types';
import { ChainError, ChainFailure, classifyError } from './errors';
import { canSubmit, ChainRecord, upsertChainRecord } from './chainState';
import { Cluster } from './config';
import { MAX_MEMO_BYTES, memoFromRunResult, parseMemo, recordFromRunResult, verifyRecord } from './memo';
import { ParsedTxLike, verifyTransaction } from './verifyTx';

export interface SubmitDeps {
  cluster: Cluster;
  replays: readonly Replay[];
  now: () => number;
  /** Builds, has the WALLET sign, and sends the memo transaction. Returns its signature. */
  sendMemo: (memo: string, wallet: string) => Promise<string>;
  /** Reads a transaction back after it is sent. May fail (RPC): the record then stays SUBMITTED. */
  fetchTx: (signature: string) => Promise<ParsedTxLike | null>;
  /** Optional chain-side duplicate check (covers a reinstall / second device). */
  findRecorded?: (runId: string, wallet: string) => Promise<string | null>;
  /** Called with the new record list every time it changes (persist it). */
  save: (records: ChainRecord[]) => void;
}

export type SubmitOutcome =
  | { ok: true; record: ChainRecord; memo: string }
  | { ok: false; error: ChainError; existing?: ChainRecord };

export async function recordScoreOnchain(run: RunResult, wallet: string, getRecords: () => ChainRecord[], deps: SubmitDeps): Promise<SubmitOutcome> {
  // 1. never twice for the same run
  const gate = canSubmit(getRecords(), run.runId, deps.cluster);
  if (!gate.ok) return { ok: false, error: classifyError(new ChainFailure('ALREADY_RECORDED')), existing: gate.existing };

  // 2. the payload is built once, from the RunResult, and checked before the wallet is asked
  const memo = memoFromRunResult(run, wallet);
  const parsed = parseMemo(memo);
  const bytes = new TextEncoder().encode(memo).length;
  if (!parsed.ok || bytes > MAX_MEMO_BYTES || !verifyRecord(parsed.record, { replays: deps.replays, expectedWallet: wallet }).ok || parsed.record.score !== run.score) {
    return { ok: false, error: classifyError(new ChainFailure('MALFORMED_MEMO')) };
  }
  void recordFromRunResult;

  try {
    if (deps.findRecorded) {
      const sig = await deps.findRecorded(run.runId, wallet).catch(() => null);
      if (sig) {
        const rec: ChainRecord = { runId: run.runId, wallet, signature: sig, network: deps.cluster, status: 'SUBMITTED', recordedAt: deps.now() };
        deps.save(upsertChainRecord(getRecords(), rec));
        return { ok: false, error: classifyError(new ChainFailure('ALREADY_RECORDED')), existing: rec };
      }
    }
    // 3. the wallet signs and sends
    const signature = await deps.sendMemo(memo, wallet);
    let record: ChainRecord = { runId: run.runId, wallet, signature, network: deps.cluster, status: 'SUBMITTED', recordedAt: deps.now() };
    deps.save(upsertChainRecord(getRecords(), record));
    // 4. read it back; only a transaction that checks out becomes ONCHAIN_VERIFIED
    try {
      const v = verifyTransaction(await deps.fetchTx(signature), signature, deps.replays, wallet);
      if (v.ok && v.run.record.runId === run.runId && v.run.record.score === run.score) {
        record = { ...record, status: 'ONCHAIN_VERIFIED' };
        deps.save(upsertChainRecord(getRecords(), record));
      }
    } catch {
      // the signature is saved; verification can be retried later
    }
    return { ok: true, record, memo };
  } catch (e) {
    return { ok: false, error: classifyError(e) };
  }
}
