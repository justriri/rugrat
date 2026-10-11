import { Connection, PublicKey } from '@solana/web3.js';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useChain } from '../chain/ChainContext';
import { readSkrBalance } from './balance';
import { SKR_MINT, SKR_RPC } from './config';
import { NO_PERKS, nextSkrState, perksFor, SkrPerks, SkrState } from './status';

interface SkrValue {
  state: SkrState;
  perks: SkrPerks;
  checking: boolean;
  /** Reads the balance once. Called on wallet connect, when the SKR section opens, and by the refresh button. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<SkrValue | null>(null);
let connection: Connection | null = null;
const conn = () => (connection ??= new Connection(SKR_RPC, 'confirmed'));

/** Additive and optional: if SKR cannot be checked, the app behaves exactly as without it. */
export function SkrProvider({ children }: { children: ReactNode }) {
  const { session } = useChain();
  const wallet = session?.address ?? null;
  const [state, setState] = useState<SkrState>({ kind: 'DISCONNECTED' });
  const [checking, setChecking] = useState(false);
  const stateRef = useRef(state);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const apply = useCallback((next: SkrState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const refresh = useCallback(async () => {
    const w = walletRef.current;
    if (!w) return apply(nextSkrState(null, null, stateRef.current));
    setChecking(true);
    try {
      const reading = await readSkrBalance(w, SKR_MINT, { connection: conn(), toKey: (a) => new PublicKey(a) });
      // the wallet may have changed while the request was in flight: drop a stale answer
      if (walletRef.current === w) apply(nextSkrState(w, reading, stateRef.current));
    } finally {
      setChecking(false);
    }
  }, [apply]);

  // a new wallet starts from scratch (no perks carried over from another wallet), then reads once
  useEffect(() => {
    apply(wallet ? { kind: 'UNCHECKED' } : { kind: 'DISCONNECTED' });
    if (wallet) void refresh();
  }, [wallet, apply, refresh]);

  const value = useMemo<SkrValue>(() => ({ state, perks: wallet ? perksFor(state) : NO_PERKS, checking, refresh }), [state, wallet, checking, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSkr(): SkrValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSkr must be used inside SkrProvider');
  return v;
}
