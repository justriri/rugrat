// What the app remembers about a run's onchain record, kept SEPARATE from the RunResult (which is
// never altered). Pure functions over a list, so the rules are testable without a wallet.
import type { Cluster } from './config';

/** SUBMITTED: a signature exists but the transaction was not (yet) read back and checked. */
export type ChainStatus = 'SUBMITTED' | 'ONCHAIN_VERIFIED';
/** What a run shows in the UI. LOCAL = never recorded. */
export type RunBadge = 'LOCAL' | 'SUBMITTED' | 'ONCHAIN_VERIFIED';

export interface ChainRecord {
  runId: string;
  /** The wallet address used. */
  wallet: string;
  signature: string;
  network: Cluster;
  status: ChainStatus;
  recordedAt: number;
}

/** The badge-progress DISPLAY cache is per cluster: devnet progress must never show on mainnet. Older entries had no cluster and were all devnet. */
export function progressCacheApplies(entry: { cluster?: Cluster } | null, cluster: Cluster): boolean {
  return !!entry && (entry.cluster ?? 'devnet') === cluster;
}

export function recordFor(records: readonly ChainRecord[], runId: string, network?: Cluster): ChainRecord | null {
  const mine = records.filter((r) => r.runId === runId && (network === undefined || r.network === network));
  return mine.find((r) => r.status === 'ONCHAIN_VERIFIED') ?? mine[0] ?? null;
}

export function badgeFor(records: readonly ChainRecord[], runId: string, network?: Cluster): RunBadge {
  return recordFor(records, runId, network)?.status ?? 'LOCAL';
}

/** One onchain record per completed run (per network). A different run is never blocked. */
export function canSubmit(records: readonly ChainRecord[], runId: string, network: Cluster): { ok: true } | { ok: false; existing: ChainRecord } {
  const existing = recordFor(records, runId, network);
  return existing ? { ok: false, existing } : { ok: true };
}

/** Adds or upgrades a record for a run; never lets a verified record be downgraded. */
export function upsertChainRecord(records: readonly ChainRecord[], rec: ChainRecord): ChainRecord[] {
  const i = records.findIndex((r) => r.runId === rec.runId && r.network === rec.network);
  if (i < 0) return [...records, rec];
  if (records[i].status === 'ONCHAIN_VERIFIED' && rec.status !== 'ONCHAIN_VERIFIED') return [...records];
  const out = [...records];
  out[i] = rec;
  return out;
}
