// Reads score records back from the chain and verifies them. Structural types are used so a
// fetched @solana/web3.js transaction or a test fixture are treated identically.
import type { Replay } from '../game/types';
import { MEMO_PROGRAM_ID } from './config';
import { MEMO_PREFIX, OnchainScoreRecord, parseMemo, verifyRecord } from './memo';

type Addr = { toString(): string } | string;

export interface ParsedTxLike {
  meta: { err: unknown } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: Addr; signer: boolean }[];
      instructions: { programId: Addr; parsed?: unknown }[];
    };
  };
}

declare const verifiedBrand: unique symbol;
/** A run that was read back from the chain and checked. Only this module creates one. */
export interface VerifiedChainRun {
  readonly [verifiedBrand]: true;
  readonly signature: string;
  readonly record: OnchainScoreRecord;
  readonly wallet: string;
}

const str = (a: Addr) => (typeof a === 'string' ? a : a.toString());

export type TxVerification = { ok: true; run: VerifiedChainRun } | { ok: false; reason: string };

/**
 * A transaction is a valid score record when: it succeeded; its fee payer (the wallet that
 * signed) is the wallet named in the record; it contains a Memo-program instruction whose text is
 * a well-formed record; and the record verifies against the replay catalogue and game rules.
 */
export function verifyTransaction(tx: ParsedTxLike | null, signature: string, replays: readonly Replay[], expectedWallet?: string): TxVerification {
  if (!tx) return { ok: false, reason: 'transaction not found' };
  if (tx.meta === null || tx.meta.err) return { ok: false, reason: 'transaction failed or is unconfirmed' };
  const msg = tx.transaction.message;
  const payer = msg.accountKeys[0];
  if (!payer || !payer.signer) return { ok: false, reason: 'no signing wallet' };
  const wallet = str(payer.pubkey);
  if (expectedWallet !== undefined && wallet !== expectedWallet) return { ok: false, reason: 'signed by a different wallet' };
  const memos = msg.instructions.filter((i) => str(i.programId) === MEMO_PROGRAM_ID && typeof i.parsed === 'string');
  if (memos.length !== 1) return { ok: false, reason: memos.length === 0 ? 'no memo instruction' : 'more than one memo instruction' };
  const parsed = parseMemo(memos[0].parsed as string);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.record.wallet !== wallet) return { ok: false, reason: 'record wallet is not the signer' };
  const v = verifyRecord(parsed.record, { replays, expectedWallet: wallet });
  if (!v.ok) return { ok: false, reason: v.problems.join('; ') };
  return { ok: true, run: { signature, record: parsed.record, wallet } as VerifiedChainRun };
}

/** The slice of a web3.js Connection the scan needs (also easy to fake in tests). */
export interface ScanConnection {
  getSignaturesForAddress(address: any, opts: { limit: number; before?: string }): Promise<{ signature: string; err: unknown; memo: string | null }[]>;
  getParsedTransaction(signature: string, opts: any): Promise<ParsedTxLike | null>;
}

/**
 * Every verified score record the wallet has signed, read from the chain (not from local storage).
 * One entry per run id (the first transaction wins). Pages through at most `maxPages` of history.
 */
export async function fetchVerifiedRuns(conn: ScanConnection, walletAddress: any, wallet: string, replays: readonly Replay[], maxPages = 5): Promise<VerifiedChainRun[]> {
  const found = new Map<string, VerifiedChainRun>();
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(walletAddress, before ? { limit: 100, before } : { limit: 100 });
    if (sigs.length === 0) break;
    for (const s of [...sigs].reverse()) {
      if (s.err || !s.memo || !s.memo.includes(MEMO_PREFIX)) continue;
      const tx = await conn.getParsedTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const v = verifyTransaction(tx, s.signature, replays, wallet);
      if (v.ok && !found.has(v.run.record.runId)) found.set(v.run.record.runId, v.run);
    }
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 100) break;
  }
  return [...found.values()];
}

/** Cheap duplicate check straight from the chain: has this wallet already signed a record for this run? */
export async function findRecordedSignature(conn: ScanConnection, walletAddress: any, runId: string, maxPages = 2): Promise<string | null> {
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await conn.getSignaturesForAddress(walletAddress, before ? { limit: 100, before } : { limit: 100 });
    for (const s of sigs) if (!s.err && s.memo && s.memo.includes(MEMO_PREFIX) && s.memo.includes(JSON.stringify(runId))) return s.signature;
    if (sigs.length < 100) break;
    before = sigs[sigs.length - 1].signature;
  }
  return null;
}
