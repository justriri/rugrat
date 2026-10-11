import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { DEMO_PLAYERS } from './demo';
import { LOCAL_PLAYER_ID, RunResult } from './result';
import type { PlayerRecord } from './stats';
import { addRunIfNew, loadRuns, saveRuns } from './store';

interface CompetitionValue {
  /** The local player's own runs. */
  runs: RunResult[];
  loaded: boolean;
  addRun: (run: RunResult) => void;
  /** The local player followed by the (clearly labelled) demo players. */
  players: PlayerRecord[];
  you: PlayerRecord;
}

const Ctx = createContext<CompetitionValue | null>(null);

export function CompetitionProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [loaded, setLoaded] = useState(false);
  const runsRef = useRef<RunResult[]>([]);

  useEffect(() => {
    let alive = true;
    loadRuns().then((saved) => {
      if (!alive) return;
      // merge anything recorded while loading
      const merged = saved.reduce((acc, r) => addRunIfNew(acc, r), runsRef.current);
      runsRef.current = merged;
      setRuns(merged);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const addRun = useCallback((run: RunResult) => {
    const next = addRunIfNew(runsRef.current, run);
    if (next.length === runsRef.current.length) return;
    runsRef.current = next;
    setRuns(next);
    void saveRuns(next);
  }, []);

  const value = useMemo<CompetitionValue>(() => {
    const you: PlayerRecord = { playerId: LOCAL_PLAYER_ID, name: 'YOU', demo: false, runs };
    return { runs, loaded, addRun, you, players: [you, ...DEMO_PLAYERS] };
  }, [runs, loaded, addRun]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompetition(): CompetitionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCompetition must be used inside CompetitionProvider');
  return v;
}
