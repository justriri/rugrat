import { LOCAL_PLAYER_ID, RunResult } from './result';
import { computeStats, PlayerRecord } from './stats';

export type LeaderboardFilter = 'ALL' | string; // 'ALL' or a rug id

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  name: string;
  demo: boolean;
  isYou: boolean;
  score: number;
  rugsSurvived: number;
  cleanExits: number;
}

/**
 * Ranks by skill score only. Ties break on clean exits, then rugs survived, then name and id, so
 * the order is deterministic. P/L and money never enter the ranking. Players with no run in the
 * chosen scope are not listed.
 */
export function buildLeaderboard(players: readonly PlayerRecord[], filter: LeaderboardFilter, youId = LOCAL_PLAYER_ID): LeaderboardRow[] {
  const rows = players
    .map((p) => {
      const runs: RunResult[] = filter === 'ALL' ? p.runs : p.runs.filter((r) => r.rugId === filter);
      if (runs.length === 0) return null;
      const s = computeStats(runs);
      return { playerId: p.playerId, name: p.name, demo: p.demo, isYou: p.playerId === youId, score: s.totalScore, rugsSurvived: s.rugsSurvived, cleanExits: s.cleanExits };
    })
    .filter((r): r is Omit<LeaderboardRow, 'rank'> => r !== null);
  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.cleanExits - a.cleanExits ||
      b.rugsSurvived - a.rugsSurvived ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0),
  );
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}
