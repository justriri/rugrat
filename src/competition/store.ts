// Local persistence for the player's own runs. No backend, no wallet. The stored value is a plain,
// versioned JSON document, so it can later be uploaded or mirrored elsewhere without conversion.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { RunResult } from './result';
export { addRunIfNew } from './stats';

const KEY = 'rugreplay.runs';
const VERSION = 1;

function isRun(x: unknown): x is RunResult {
  const r = x as RunResult;
  return (
    !!r &&
    typeof r.runId === 'string' &&
    typeof r.playerId === 'string' &&
    typeof r.rugId === 'string' &&
    typeof r.score === 'number' &&
    typeof r.entryTimestamp === 'number' &&
    typeof r.startingPaperSol === 'number' &&
    ['CLEAN_EXIT', 'LATE_EXIT', 'RUGGED'].includes(r.verdict)
  );
}

/** Never throws: unreadable or corrupt data just means "no saved runs". */
export async function loadRuns(): Promise<RunResult[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const doc = JSON.parse(raw) as { v?: number; runs?: unknown[] };
    if (doc.v !== VERSION || !Array.isArray(doc.runs)) return [];
    return doc.runs.filter(isRun);
  } catch {
    return [];
  }
}

export async function saveRuns(runs: readonly RunResult[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ v: VERSION, runs }));
  } catch {
    // a failed save must never break the game
  }
}
