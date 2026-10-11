// Local persistence for onchain bookkeeping. Separate from the run store: the RunResult is never
// modified. Everything here can be rebuilt from the chain; losing it loses nothing.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { AchievementProgress } from '../badge/achievement';
import type { BadgeClaim } from '../badge/claim';
import { progressCacheApplies, type ChainRecord } from './chainState';
import type { Cluster } from './config';

const RECORDS_KEY = 'rugreplay.chainRecords';
const CLAIMS_KEY = 'rugreplay.badgeClaims';

async function readList<T>(key: string, ok: (x: unknown) => boolean): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const doc = JSON.parse(raw) as { v?: number; items?: unknown[] };
    return doc.v === 1 && Array.isArray(doc.items) ? (doc.items.filter(ok) as T[]) : [];
  } catch {
    return [];
  }
}
async function writeList(key: string, items: readonly unknown[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ v: 1, items }));
  } catch {
    // a failed save must never break the game
  }
}

const isRecord = (x: unknown) => {
  const r = x as ChainRecord;
  return !!r && typeof r.runId === 'string' && typeof r.signature === 'string' && typeof r.wallet === 'string' && (r.status === 'SUBMITTED' || r.status === 'ONCHAIN_VERIFIED');
};
const isClaim = (x: unknown) => {
  const c = x as BadgeClaim;
  return !!c && typeof c.wallet === 'string' && typeof c.assetAddress === 'string' && typeof c.rugsSurvived === 'number';
};

const PROGRESS_KEY = 'rugreplay.badgeProgress';
/** DISPLAY CACHE ONLY: the last verified progress, so the badge screen is not blank offline or while
 * disconnected. Claiming never reads it; it always re-verifies from the chain. */
export async function loadProgressCache(cluster: Cluster): Promise<{ wallet: string; progress: AchievementProgress } | null> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    const d = raw ? (JSON.parse(raw) as { wallet?: string; cluster?: Cluster; progress?: AchievementProgress }) : null;
    return d && progressCacheApplies(d, cluster) && typeof d.wallet === 'string' && d.progress && Array.isArray(d.progress.counted) ? { wallet: d.wallet, progress: d.progress } : null;
  } catch {
    return null;
  }
}
export async function saveProgressCache(wallet: string, progress: AchievementProgress, cluster: Cluster): Promise<void> {
  try {
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify({ wallet, cluster, progress }));
  } catch {
    // cache only
  }
}

export const loadChainRecords = () => readList<ChainRecord>(RECORDS_KEY, isRecord);
export const saveChainRecords = (r: readonly ChainRecord[]) => writeList(RECORDS_KEY, r);
export const loadBadgeClaims = () => readList<BadgeClaim>(CLAIMS_KEY, isClaim);
export const saveBadgeClaims = (c: readonly BadgeClaim[]) => writeList(CLAIMS_KEY, c);
