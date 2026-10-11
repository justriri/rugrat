import { endTimestamp, startTimestamp, tickIndexAt } from './timeline';
import type { Replay } from './types';

export interface ClockState {
  /** Current historical timestamp (epoch seconds). */
  timestamp: number;
  /** Last tick at or before `timestamp`. The price is held (step), never interpolated. */
  index: number;
  /** 0..1 progress between tick `index` and `index + 1`. */
  frac: number;
  price: number;
  /** 0..1 progress through the whole replay window. */
  progress: number;
  finished: boolean;
}

/**
 * THE source of truth for replay time. Price, terrain position, event visibility and the
 * player's place on the timeline are all derived from `elapsed` here.
 *
 * The clock only moves when `advance(realDeltaMs)` is called by its single driver, and it
 * moves by realDelta * speed. Pausing is speed 0 (just don't advance).
 */
export class ReplayClock {
  private elapsed = 0; // historical seconds since the first tick
  private readonly start: number;
  private readonly duration: number;

  constructor(
    private readonly replay: Replay,
    public speed: number,
  ) {
    this.start = startTimestamp(replay);
    this.duration = endTimestamp(replay) - this.start;
  }

  reset() {
    this.elapsed = 0;
  }

  advance(realDeltaMs: number) {
    if (realDeltaMs <= 0) return;
    this.elapsed = Math.min(this.duration, this.elapsed + (realDeltaMs / 1000) * this.speed);
  }

  get timestamp() {
    return this.start + this.elapsed;
  }

  get state(): ClockState {
    const { ticks } = this.replay;
    const t = this.timestamp;
    const index = Math.max(0, tickIndexAt(this.replay, t));
    const next = ticks[index + 1];
    const frac = next ? (t - ticks[index].timestamp) / (next.timestamp - ticks[index].timestamp) : 0;
    return {
      timestamp: t,
      index,
      frac,
      price: ticks[index].price,
      progress: this.duration === 0 ? 1 : this.elapsed / this.duration,
      finished: this.elapsed >= this.duration,
    };
  }
}
