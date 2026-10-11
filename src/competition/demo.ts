// DEMO players, clearly labelled, so the competition screens have something to show before there
// is any backend or wallet. They are NOT real users. Their runs are built with the same trading
// and verdict code as a real run (a buy and a sell at chosen historical timestamps), so they are
// consistent with the real rules and replays; only the choices are scripted.
import { REPLAYS } from '../data/replays';
import { applyBuy, applySell, newPlayer, PlayerState } from '../game/player';
import { tickIndexAt } from '../game/timeline';
import type { Replay } from '../game/types';
import { signalEvent } from '../game/verdict';
import { buildRunResult, RunResult } from './result';
import type { PlayerRecord } from './stats';

type Style = 'CLEAN' | 'LATE' | 'RUGGED';

/** A scripted buy and sell on a replay, expressed as fractions of that replay's own timeline. */
function scriptedPlayer(replay: Replay, style: Style, variant: number): PlayerState {
  const sig = signalEvent(replay);
  const start = replay.replayStart;
  const signalTs = sig ? sig.timestamp : start + (replay.rugTimestamp - start) * 0.5;
  const rug = replay.rugTimestamp;
  const entry = start + (signalTs - start) * 0.2;
  let exit: number | null;
  if (style === 'CLEAN') exit = start + (signalTs - start) * (0.5 + 0.08 * variant);
  else if (style === 'LATE') exit = signalTs + (rug - signalTs) * (0.15 + 0.1 * variant);
  else exit = null; // held through the collapse
  const at = (timestamp: number) => {
    const tickIndex = Math.max(0, tickIndexAt(replay, timestamp));
    return { timestamp, tickIndex, price: replay.ticks[tickIndex].price };
  };
  let p = applyBuy(newPlayer(), at(entry), replay.paperSolUsd);
  if (exit !== null) p = applySell(p, at(exit), replay.paperSolUsd);
  return p;
}

function demoRuns(playerId: string, plan: (index: number) => { style: Style; variant: number }): RunResult[] {
  const out: RunResult[] = [];
  REPLAYS.forEach((replay, i) => {
    const { style, variant } = plan(i);
    const r = buildRunResult(replay, scriptedPlayer(replay, style, variant), playerId);
    if (r) out.push(r);
  });
  return out;
}

export const DEMO_PLAYERS: PlayerRecord[] = [
  { playerId: 'demo-ava', name: 'Demo Ava', demo: true, runs: demoRuns('demo-ava', (i) => ({ style: 'CLEAN', variant: i % 3 })) },
  { playerId: 'demo-ben', name: 'Demo Ben', demo: true, runs: demoRuns('demo-ben', (i) => ({ style: 'LATE', variant: i % 3 })) },
  { playerId: 'demo-cy', name: 'Demo Cy', demo: true, runs: demoRuns('demo-cy', (i) => ({ style: i === 0 ? 'CLEAN' : i === 1 ? 'LATE' : 'RUGGED', variant: 1 })) },
];

/** Friends are local/mock for now; a real identity layer can replace this list later. */
export const DEMO_FRIEND_IDS: readonly string[] = DEMO_PLAYERS.map((p) => p.playerId);
