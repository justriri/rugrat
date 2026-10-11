import type { Direction, PriceTick, TerrainColumn } from './types';

/** Lowest column height. Keeps the cheapest price standing on solid ground. */
export const MIN_LEVEL = 2;
const LEVELS_PER_LN_UNIT = 15;
const MIN_LEVEL_SPAN = 36;
const MAX_LEVEL_SPAN = 60;

/**
 * Turns the exact price history into voxel columns.
 *
 * Pure and deterministic: the same ticks always produce the same terrain. Heights are a
 * log-scale mapping of price between the replay's own min and max, so direction, peaks,
 * dips and crashes are preserved. No smoothing, no randomness.
 */
export function buildTerrain(ticks: readonly PriceTick[]): TerrainColumn[] {
  if (ticks.length === 0) return [];

  const logs = ticks.map((t) => Math.log(t.price));
  const logMin = Math.min(...logs);
  const logMax = Math.max(...logs);
  const logSpan = logMax - logMin;

  const levelSpan = Math.min(
    MAX_LEVEL_SPAN,
    Math.max(MIN_LEVEL_SPAN, Math.round(logSpan * LEVELS_PER_LN_UNIT)),
  );

  return ticks.map((tick, index) => {
    const unit = logSpan === 0 ? 0 : (logs[index] - logMin) / logSpan;
    const level = MIN_LEVEL + Math.round(unit * levelSpan);

    let dir: Direction = 'flat';
    if (index > 0) {
      const prev = ticks[index - 1].price;
      dir = tick.price > prev ? 'up' : tick.price < prev ? 'down' : 'flat';
    }
    return { index, timestamp: tick.timestamp, price: tick.price, level, dir };
  });
}
