// Step 2 of the data pipeline: raw JSON on disk -> deterministic replay JSON.
//   npm run build:replay
// Cleans the raw candles (never invents or reorders prices), derives the collapse marker by a
// stated rule, validates with the same parseReplay the game uses, and writes the replay.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildTerrain } from '../src/game/terrain';
import { parseReplay } from '../src/game/timeline';
import type { PriceTick, Replay, ReplayEvent } from '../src/game/types';

const ROOT = resolve(__dirname, '..');
const RAW = 'data/raw/libra.jupiter.1s.json';
const OUT = 'src/data/replays/libra.json';
const REPORT = 'data/processed/libra.report.json';

const raw = JSON.parse(readFileSync(resolve(ROOT, RAW), 'utf8')) as {
  source: string;
  url: string;
  fetchedAt: string;
  mint: string;
  interval: string;
  candles: { time?: unknown; close?: unknown }[];
};

// ---- clean ---------------------------------------------------------------------------------
const report = { rawCandles: raw.candles.length, malformedDropped: 0, duplicateTimestampsDropped: 0, outOfOrderResorted: false };

let ticks: PriceTick[] = [];
for (const c of raw.candles) {
  const timestamp = Number(c.time);
  const price = Number(c.close);
  if (!Number.isFinite(timestamp) || !(price > 0) || !Number.isFinite(price)) {
    report.malformedDropped++;
    continue;
  }
  ticks.push({ timestamp, price });
}

if (ticks.some((t, i) => i > 0 && t.timestamp < ticks[i - 1].timestamp)) {
  report.outOfOrderResorted = true;
  ticks = ticks.map((t, i) => ({ t, i })).sort((a, b) => a.t.timestamp - b.t.timestamp || a.i - b.i).map((x) => x.t);
}

// Duplicate timestamps: keep the LAST record for a second (the latest known price for it).
const deduped: PriceTick[] = [];
for (const t of ticks) {
  if (deduped.length && deduped[deduped.length - 1].timestamp === t.timestamp) {
    deduped[deduped.length - 1] = t;
    report.duplicateTimestampsDropped++;
  } else deduped.push(t);
}
ticks = deduped;

// ---- collapse marker -------------------------------------------------------------------------
// Rule: the first tick AFTER the peak whose price is <= 50% of the peak price.
const peak = ticks.reduce((m, t) => (t.price > m.price ? t : m), ticks[0]);
const rugTick = ticks.find((t) => t.timestamp > peak.timestamp && t.price <= peak.price * 0.5);
if (!rugTick) throw new Error('no collapse found by the 50%-of-peak rule');

const gaps = ticks
  .map((t, i) => (i ? { from: ticks[i - 1].timestamp, seconds: t.timestamp - ticks[i - 1].timestamp } : null))
  .filter((g): g is { from: number; seconds: number } => !!g && g.seconds >= 300)
  .map((g) => ({ from: new Date(g.from * 1000).toISOString(), minutes: +(g.seconds / 60).toFixed(1) }));

// ---- wallet events (optional; produced by `npm run build:events`) --------------------------------
// The replay carries only the shortened wallet; full addresses and evidence stay in the
// provenance file, keyed by event id.
let events: ReplayEvent[] = [];
let paperSolUsd = 0;
let provenance: Record<string, unknown> = { file: null };
const EVENTS = 'data/processed/libra.events.json';
if (existsSync(resolve(ROOT, EVENTS))) {
  const e = JSON.parse(readFileSync(resolve(ROOT, EVENTS), 'utf8')) as {
    events: { id: string; timestamp: number; walletAddress: string; tag?: ReplayEvent['tag']; action: ReplayEvent['action']; amount?: number; amountUnit?: ReplayEvent['amountUnit'] }[];
    duplicatesDropped: number;
    paperSolUsd: { value: number };
  };
  const first = ticks[0].timestamp;
  const last = ticks[ticks.length - 1].timestamp;
  events = e.events.map((x) => ({
    id: x.id,
    timestamp: x.timestamp,
    wallet: `${x.walletAddress.slice(0, 3)}...${x.walletAddress.slice(-3)}`,
    ...(x.tag ? { tag: x.tag } : {}),
    action: x.action,
    ...(x.amount !== undefined ? { amount: x.amount, amountUnit: x.amountUnit } : {}),
  }));
  const outside = events.filter((x) => x.timestamp < first || x.timestamp > last);
  if (outside.length) throw new Error(`${outside.length} events fall outside the replay window`);
  paperSolUsd = e.paperSolUsd.value;
  provenance = { file: EVENTS, events: events.length, duplicatesDropped: e.duplicatesDropped };
}

// Real token identity from Jupiter's asset record (saved raw next to the price data).
const asset = (JSON.parse(readFileSync(resolve(ROOT, 'data/raw/libra.asset.json'), 'utf8')) as { id: string; name: string; symbol: string; icon?: string }[])[0];
if (asset.id !== raw.mint) throw new Error('asset record does not match the mint');

const replay: Replay = parseReplay({
  id: 'libra-2025-02-14',
  token: asset.symbol,
  name: asset.name,
  symbol: asset.symbol,
  mint: asset.id,
  logoUrl: asset.icon ?? null,
  logoSource: asset.icon ? 'Jupiter asset metadata (datapi.jup.ag/v1/assets/search), icon field' : null,
  // Not classified into one of the three catalogue rug types: the original replay.
  rugType: 'UNCLASSIFIED',
  date: '2025-02-14',
  replayStart: ticks[0].timestamp,
  replayEnd: ticks[ticks.length - 1].timestamp,
  signal: {
    tag: 'SMART',
    action: 'SELL',
    minUsd: 500_000,
    description: 'First SMART SELL of at least $500,000: the first time a wallet with an early, profitable exit sold a half-million dollars or more (chosen from the LIBRA SMART-sell analysis).',
  },
  collapseReason: 'First tick after the peak whose price is at or below 50% of the peak price (price-only rule, see meta.rugRule).',
  source: `${raw.source} (${raw.url})`,
  ticks,
  events,
  rugTimestamp: rugTick.timestamp,
  // 90x: the 85-minute window plays in about a minute. A global multiplier only.
  playbackSpeed: 90,
  // SOL/USD for paper trading, derived from the trades' own USD/SOL volumes (see build-events).
  paperSolUsd,
  meta: {
    mint: raw.mint,
    priceUnit: 'USD',
    priceField: 'close of each candle, at the candle timestamp (epoch seconds)',
    interval: raw.interval,
    candlesOnlyWhereTradesOccurred: true,
    rawFile: RAW,
    fetchedAt: raw.fetchedAt,
    rugRule: 'first tick after the peak with price <= 50% of the peak price',
    peak: { timestamp: peak.timestamp, price: peak.price },
    gapsOver5Minutes: gaps,
    cleaning: report,
    eventProvenance: provenance,
  },
});

mkdirSync(resolve(ROOT, 'data/processed'), { recursive: true });
writeFileSync(resolve(ROOT, OUT), JSON.stringify(replay, null, 1) + '\n');
writeFileSync(resolve(ROOT, REPORT), JSON.stringify({ ...report, ticks: ticks.length, peak, rug: rugTick, gaps }, null, 2) + '\n');

// ---- verification chart --------------------------------------------------------------------
// Top: price on a real time axis (compare with any external LIBRA chart). Bottom: the voxel
// columns the game builds, one per tick, in the same order.
{
  const terrain = buildTerrain(replay.ticks);
  const W = 1100;
  const t0 = ticks[0].timestamp;
  const t1 = ticks[ticks.length - 1].timestamp;
  const lo = Math.log(Math.min(...ticks.map((t) => t.price)));
  const hi = Math.log(Math.max(...ticks.map((t) => t.price)));
  const px = (t: number) => 50 + ((t - t0) / (t1 - t0)) * (W - 70);
  const py = (p: number) => 220 - ((Math.log(p) - lo) / (hi - lo)) * 180;
  const line = ticks.map((t, i) => `${i ? 'L' : 'M'}${px(t.timestamp).toFixed(1)},${py(t.price).toFixed(1)}`).join(' ');
  const maxLevel = Math.max(...terrain.map((c) => c.level));
  const bw = (W - 70) / terrain.length;
  const bars = terrain
    .map((c, i) => `<rect x="${(50 + i * bw).toFixed(1)}" y="${(520 - (c.level / maxLevel) * 200).toFixed(1)}" width="${Math.max(0.8, bw - 0.4).toFixed(1)}" height="${((c.level / maxLevel) * 200).toFixed(1)}" fill="${c.dir === 'down' ? '#e5483f' : c.dir === 'up' ? '#4fd35f' : '#c9c24e'}"/>`)
    .join('');
  const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
  const ticksX = [0, 0.25, 0.5, 0.75, 1].map((f) => t0 + f * (t1 - t0));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="560" font-family="monospace" font-size="12">
<rect width="100%" height="100%" fill="#fff"/>
<text x="50" y="22" font-size="14">LIBRA price (USD, log scale) vs real time, 2025-02-14 UTC. ${ticks.length} ticks. Gaps = no trades in the source.</text>
<path d="${line}" fill="none" stroke="#1f2a37" stroke-width="1.2"/>
${ticks.map((t) => `<circle cx="${px(t.timestamp).toFixed(1)}" cy="${py(t.price).toFixed(1)}" r="1.6" fill="#1f2a37"/>`).join('')}
<line x1="${px(peak.timestamp)}" x2="${px(peak.timestamp)}" y1="40" y2="225" stroke="#4fd35f" stroke-dasharray="4"/><text x="${px(peak.timestamp) + 4}" y="52" fill="#2d8a3a">peak ${peak.price.toFixed(2)}</text>
<line x1="${px(rugTick.timestamp)}" x2="${px(rugTick.timestamp)}" y1="40" y2="225" stroke="#e5483f" stroke-dasharray="4"/><text x="${px(rugTick.timestamp) + 4}" y="52" fill="#9c2a24">collapse marker ${rugTick.price.toFixed(2)}</text>
${ticksX.map((t) => `<text x="${px(t) - 14}" y="240">${hhmm(t)}</text>`).join('')}
<text x="50" y="290" font-size="14">Terrain columns the game builds (one per tick, in order, height = log price). Green up / red down.</text>
${bars}
</svg>`;
  writeFileSync(resolve(ROOT, 'data/processed/libra.chart.svg'), svg);
}

const iso = (t: number) => new Date(t * 1000).toISOString();
console.log(`raw candles:        ${report.rawCandles}`);
console.log(`malformed dropped:  ${report.malformedDropped}`);
console.log(`duplicates dropped: ${report.duplicateTimestampsDropped}`);
console.log(`re-sorted:          ${report.outOfOrderResorted}`);
console.log(`ticks written:      ${ticks.length}  (${iso(ticks[0].timestamp)} -> ${iso(ticks[ticks.length - 1].timestamp)})`);
console.log(`peak:               ${peak.price} at ${iso(peak.timestamp)}`);
console.log(`collapse marker:    ${rugTick.price} at ${iso(rugTick.timestamp)}`);
console.log(`gaps >= 5 min:      ${JSON.stringify(gaps)}`);
console.log(`wrote ${OUT}, ${REPORT}, data/processed/libra.chart.svg`);
