// The worlds shown on the selection screen, derived from the replay registry. No rug data is
// copied: names, symbols, dates and counts are read from the registry at the moment they are shown,
// and the miniature chart is a downsampled VIEW of the replay's real ticks (nothing is altered).
import type { MenuWorld } from '../bridge/menuProtocol';
import { REPLAYS } from '../data/replays';
import type { Replay } from '../game/types';

/** Columns in the miniature chart on each world. */
export const PROFILE_COLUMNS = 20;

/**
 * The replay's price path as `columns` buckets (the close of each bucket), mapped to 0..1 on a log
 * scale, plus whether each bucket closed above (+1) or below (-1) the previous one.
 */
export function chartProfile(ticks: readonly { price: number }[], columns = PROFILE_COLUMNS): { profile: number[]; steps: number[] } {
  if (ticks.length === 0) return { profile: [], steps: [] };
  const closes: number[] = [];
  for (let c = 0; c < columns; c++) {
    const end = Math.min(ticks.length - 1, Math.floor(((c + 1) * ticks.length) / columns) - 1);
    closes.push(Math.log(ticks[Math.max(0, end)].price));
  }
  const lo = Math.min(...closes);
  const hi = Math.max(...closes);
  const span = hi - lo || 1;
  return {
    profile: closes.map((v) => (v - lo) / span),
    steps: closes.map((v, i) => (i === 0 ? 1 : v >= closes[i - 1] ? 1 : -1)),
  };
}

export function menuWorld(replay: Replay, index: number): MenuWorld {
  const { profile, steps } = chartProfile(replay.ticks);
  return { id: replay.id, symbol: replay.symbol, rugType: replay.rugType, index, profile, steps };
}

export function menuWorlds(replays: readonly Replay[] = REPLAYS): MenuWorld[] {
  return replays.map(menuWorld);
}

/** "16h 24m", "42m 10s", "58s" (the HUD's span format with spaces, for the info card). */
export function fmtHistory(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
