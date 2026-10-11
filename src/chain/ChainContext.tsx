import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';

import { AchievementProgress, BadgeStatus, badgeStatus, uniqueVerifiedSurvivingRugs } from '../badge/achievement';
import { BadgeClaim, claimBadge, claimFor, ClaimOutcome } from '../badge/claim';
import { existingBadgeAddress, mintBadge } from '../badge/mint';
import { REPLAYS } from '../data/replays';
import type { RunResult } from '../competition/result';
import { badgeFor, ChainRecord, RunBadge } from './chainState';
import { CLUSTER } from './config';
import { ChainError, classifyError } from './errors';
import { loadBadgeClaims, loadChainRecords, loadProgressCache, saveBadgeClaims, saveChainRecords, saveProgressCache } from './store';
import { recordScoreOnchain, SubmitOutcome } from './submit';
import { fetchVerifiedRuns, findRecordedSignature, VerifiedChainRun } from './verifyTx';
import { connectWallet, disconnectWallet, fetchParsedTx, getConnection, loadSession, sendMemo, WalletSession } from './wallet';

interface ChainValue {
  /** The connected wallet, or null. The game never needs one. */
  session: WalletSession | null;
  connecting: boolean;
  records: ChainRecord[];
  claims: BadgeClaim[];
  connect: () => Promise<ChainError | null>;
  disconnect: () => Promise<void>;
  /** LOCAL / SUBMITTED / ONCHAIN_VERIFIED for a run. */
  badgeOf: (runId: string) => RunBadge;
  recordOf: (runId: string) => ChainRecord | null;
  recordScore: (run: RunResult) => Promise<SubmitOutcome>;
  /** Reads this wallet's verified score records from the chain and derives badge progress. */
  refreshProgress: () => Promise<{ progress: AchievementProgress; error: ChainError | null }>;
  progress: AchievementProgress | null;
  badge: BadgeStatus;
  claim: BadgeClaim | null;
  claimBadge: () => Promise<ClaimOutcome>;
}

const Ctx = createContext<ChainValue | null>(null);
const EMPTY = uniqueVerifiedSurvivingRugs([], '', REPLAYS);

export function ChainProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WalletSession | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [records, setRecords] = useState<ChainRecord[]>([]);
  const [claims, setClaims] = useState<BadgeClaim[]>([]);
  const [progress, setProgress] = useState<AchievementProgress | null>(null);
  const recordsRef = useRef<ChainRecord[]>([]);
  const claimsRef = useRef<BadgeClaim[]>([]);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    void Promise.all([loadSession(), loadChainRecords(), loadBadgeClaims(), loadProgressCache(CLUSTER)]).then(([s, r, c, cache]) => {
      setSession(s);
      if (cache) setProgress(cache.progress);
      recordsRef.current = r;
      claimsRef.current = c;
      setRecords(r);
      setClaims(c);
    });
  }, []);

  const saveRecords = useCallback((r: ChainRecord[]) => {
    recordsRef.current = r;
    setRecords(r);
    void saveChainRecords(r);
  }, []);
  const saveClaims = useCallback((c: BadgeClaim[]) => {
    claimsRef.current = c;
    setClaims(c);
    void saveBadgeClaims(c);
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      setSession(await connectWallet());
      return null;
    } catch (e) {
      return classifyError(e);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const s = session;
    setSession(null);
    await disconnectWallet(s);
  }, [session]);

  const recordScore = useCallback(
    async (run: RunResult): Promise<SubmitOutcome> => {
      if (!session) return { ok: false, error: classifyError(new Error('no wallet')) };
      // double-taps while a transaction is in flight are ignored, not queued
      if (inFlight.current.has(run.runId)) return { ok: false, error: { code: 'ALREADY_RECORDED', message: 'Already recorded' } };
      inFlight.current.add(run.runId);
      try {
        return await recordScoreOnchain(run, session.address, () => recordsRef.current, {
          cluster: CLUSTER,
          replays: REPLAYS,
          now: () => Date.now(),
          sendMemo: (memo) => sendMemo(session, memo),
          fetchTx: fetchParsedTx,
          findRecorded: (runId, wallet) => findRecordedSignature(getConnection(), new PublicKey(wallet), runId),
          save: saveRecords,
        });
      } finally {
        inFlight.current.delete(run.runId);
      }
    },
    [session, saveRecords],
  );

  const fetchVerified = useCallback((wallet: string): Promise<VerifiedChainRun[]> => fetchVerifiedRuns(getConnection(), new PublicKey(wallet), wallet, REPLAYS), []);

  const refreshProgress = useCallback(async () => {
    if (!session) return { progress: EMPTY, error: null };
    try {
      const p = uniqueVerifiedSurvivingRugs(await fetchVerified(session.address), session.address, REPLAYS);
      setProgress(p);
      void saveProgressCache(session.address, p, CLUSTER);
      return { progress: p, error: null };
    } catch (e) {
      return { progress: progress ?? EMPTY, error: classifyError(e) };
    }
  }, [session, fetchVerified, progress]);

  const claimNow = useCallback(async (): Promise<ClaimOutcome> => {
    if (!session) return { ok: false, reason: 'ERROR', error: classifyError(new Error('no wallet')) };
    if (inFlight.current.has('badge')) return { ok: false, reason: 'ERROR', error: classifyError(new Error('interrupted')) };
    inFlight.current.add('badge');
    try {
      return await claimBadge(session.address, () => claimsRef.current, {
        cluster: CLUSTER,
        replays: REPLAYS,
        now: () => Date.now(),
        fetchVerifiedRuns: fetchVerified,
        existingBadge: () => existingBadgeAddress(session),
        mint: (_w, p) => mintBadge(session, p),
        save: saveClaims,
      });
    } finally {
      inFlight.current.delete('badge');
    }
  }, [session, fetchVerified, saveClaims]);

  const value = useMemo<ChainValue>(() => {
    const p = progress ?? EMPTY;
    const claim = session ? claimFor(claims, session.address, CLUSTER) : null;
    return {
      session,
      connecting,
      records,
      claims,
      connect,
      disconnect,
      badgeOf: (runId) => badgeFor(records, runId, CLUSTER),
      recordOf: (runId) => records.find((r) => r.runId === runId && r.network === CLUSTER) ?? null,
      recordScore,
      refreshProgress,
      progress,
      badge: badgeStatus(p, claim !== null),
      claim,
      claimBadge: claimNow,
    };
  }, [session, connecting, records, claims, progress, connect, disconnect, recordScore, refreshProgress, claimNow]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChain(): ChainValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useChain must be used inside ChainProvider');
  return v;
}
