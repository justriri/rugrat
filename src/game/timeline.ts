import type { Replay } from './types';

/** Validates untrusted replay JSON. Throws on anything the engine would silently mangle. */
export function parseReplay(raw: unknown): Replay {
  const r = raw as Replay;
  const fail = (msg: string): never => {
    throw new Error(`Invalid replay "${r?.id ?? '?'}": ${msg}`);
  };
  if (!r || typeof r.id !== 'string' || typeof r.token !== 'string') fail('missing id/token');
  if (!Array.isArray(r.ticks) || r.ticks.length < 2) fail('needs at least 2 ticks');
  r.ticks.forEach((t, i) => {
    if (!Number.isFinite(t.timestamp)) fail(`tick ${i} has no timestamp`);
    if (!(t.price > 0) || !Number.isFinite(t.price)) fail(`tick ${i} has a bad price`);
    if (i > 0 && t.timestamp <= r.ticks[i - 1].timestamp) fail(`tick ${i} is out of order`);
  });
  (r.events ?? []).forEach((e, i, all) => {
    if (!Number.isFinite(e.timestamp)) fail(`event ${i} has no timestamp`);
    if (i > 0 && e.timestamp < all[i - 1].timestamp) fail(`event ${i} is out of order`);
  });
  if (!Number.isFinite(r.rugTimestamp)) fail('missing rugTimestamp');
  if (!(r.playbackSpeed > 0)) fail('playbackSpeed must be > 0');
  if (!(r.paperSolUsd > 0)) fail('paperSolUsd must be > 0');
  for (const k of ['name', 'symbol', 'mint', 'date', 'collapseReason'] as const) {
    if (typeof r[k] !== 'string' || r[k].length === 0) fail(`missing ${k}`);
  }
  if (r.logoUrl !== null && !/^https?:\/\//.test(String(r.logoUrl))) fail('logoUrl must be an http(s) URL or null');
  if (!['FAST_DUMP', 'SLOW_BLEED', 'DEV_EXIT', 'UNCLASSIFIED'].includes(r.rugType)) fail('bad rugType');
  if (r.replayStart !== r.ticks[0].timestamp || r.replayEnd !== r.ticks[r.ticks.length - 1].timestamp) fail('replayStart/replayEnd must equal the first/last tick');
  if (!r.signal || !(r.signal.minUsd > 0) || !r.signal.tag || !r.signal.action || !r.signal.description) fail('missing or invalid signal rule');
  if (!r.ticks.some((t) => t.timestamp === r.rugTimestamp)) fail('rugTimestamp must be a tick timestamp (the first tick of the collapse)');
  return { ...r, events: r.events ?? [] };
}

/** Index of the last tick with timestamp <= t, or -1 if t is before the first tick. */
export function tickIndexAt(replay: Replay, t: number): number {
  let lo = 0;
  let hi = replay.ticks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (replay.ticks[mid].timestamp <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function rugTickIndex(replay: Replay): number {
  const i = replay.ticks.findIndex((t) => t.timestamp >= replay.rugTimestamp);
  return i === -1 ? replay.ticks.length - 1 : i;
}

export function startTimestamp(replay: Replay): number {
  return replay.ticks[0].timestamp;
}

export function endTimestamp(replay: Replay): number {
  return replay.ticks[replay.ticks.length - 1].timestamp;
}

/** "+45s", "+12m", "+1h05m" relative to the replay start. */
export function fmtElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m}m`;
  return `+${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** A duration with no sign: "47s", "12m05s", "1h02m". */
export function fmtSpan(seconds: number): string {
  const s = Math.max(0, Math.round(Math.abs(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/** Player/collapse markers that the Reveal replays on the same timeline. */
export interface TimelineMarker {
  timestamp: number;
  kind: 'BUY' | 'SELL' | 'COLLAPSE' | 'HELD';
  /** The tick whose column the marker belongs to. */
  tickIndex: number;
}

export type TimelineItem = { kind: 'tick' | 'event' | 'marker'; index: number };

/**
 * Everything that happened in (fromCursor, now], in strict timeline order. On equal timestamps,
 * ticks come first, then wallet events, then markers. The result depends only on the data and
 * `now`, never on how the clock was chopped into frames, so replays are identical run to run.
 * `markers` (sorted by timestamp) are optional; without them this is exactly ticks + events.
 */
export class TimelineCursor {
  private tick = -1;
  private event = -1;
  private marker = -1;

  constructor(
    private readonly replay: Replay,
    private readonly markers: readonly TimelineMarker[] = [],
  ) {}

  reset() {
    this.tick = -1;
    this.event = -1;
    this.marker = -1;
  }

  markerAt(index: number): TimelineMarker {
    return this.markers[index];
  }

  drain(now: number): TimelineItem[] {
    const out: TimelineItem[] = [];
    const { ticks, events } = this.replay;
    const markers = this.markers;
    for (;;) {
      const nt = this.tick + 1 < ticks.length ? ticks[this.tick + 1].timestamp : Infinity;
      const ne = this.event + 1 < events.length ? events[this.event + 1].timestamp : Infinity;
      const nm = this.marker + 1 < markers.length ? markers[this.marker + 1].timestamp : Infinity;
      if (nt > now && ne > now && nm > now) break;
      if (nt <= ne && nt <= nm) out.push({ kind: 'tick', index: ++this.tick });
      else if (ne <= nm) out.push({ kind: 'event', index: ++this.event });
      else out.push({ kind: 'marker', index: ++this.marker });
    }
    return out;
  }
}
