// Per-rug build: raw data on disk -> deterministic replay JSON.
//   npm run build:rug -- <slug>
// Reads data/rugs/<slug>/config.json and data/rugs/<slug>/raw/*, writes
//   src/data/replays/<slug>.json          the replay the game loads
//   data/rugs/<slug>/events.json          classified events with full evidence (provenance)
//   data/rugs/<slug>/report.json          what was cleaned/selected, and why
// Every tag comes from a stated rule over data we hold locally; nothing here asserts intent. A
// wallet that matches no rule stays untagged. The signal and the collapse are defined here, from
// the data, and stored in the replay's metadata; the game engine knows neither.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseReplay } from '../../src/game/timeline';
import type { PriceTick, Replay, ReplayEvent, RugType, SignalRule, WalletAction, WalletTag } from '../../src/game/types';

const ROOT = resolve(__dirname, '..');
const slug = process.argv[2];
if (!slug) throw new Error('usage: build-rug <slug>');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(resolve(ROOT, p));

interface Config {
  slug: string;
  id: string;
  mint: string;
  rugType: RugType;
  date: string;
  window: { from: string; to: string };
  playbackSpeed: number;
  collapse: { kind: 'peak-drawdown'; fraction: number };
  signal: SignalRule;
  rules: {
    botFilter: { maxMevTradeFraction: number };
    smart: { topN: number; minRealizedProfitUsd: number; minSoldFractionOfBought: number; lastSellBeforeCollapse: boolean; /** wallet must have stopped buying before the peak: an exit, not a flipper */ lastBuyBeforePeak?: boolean };
    whale: { topN: number };
    eventMinUsd: { INSIDER: number; SMART: number; WHALE: number; DEV: number };
    /** dev token transfers below this share of supply are merged into bursts of at most this gap (s). */
    devMove: { minPctSupply: number; burstGapSec: number; burstMaxSec: number };
    /** A wallet's consecutive same-direction trades within these gaps become one event. */
    tradeBurst: { gapSec: number; maxSec: number };
  };
}
const cfg = JSON.parse(read(`data/rugs/${slug}/config.json`)) as Config;
const RAW = `data/rugs/${slug}/raw`;

interface Trade {
  type: 'buy' | 'sell';
  usdVolume: number;
  nativeVolume?: number;
  traderAddress: string;
  txHash: string;
  poolId: string;
  actionId: string;
  timestamp: string;
  amount: number;
  isMev?: boolean;
}
interface Evidence { rule: string; detail: string; signatures?: string[] }
interface Ev {
  id: string;
  timestamp: number;
  walletAddress: string;
  tag?: WalletTag;
  action: WalletAction;
  amount?: number;
  amountUnit?: string;
  valueUsd?: number;
  signature: string;
  signatures?: string[];
  source: string;
  classification: Evidence[];
  note?: string;
}
const short = (a: string) => `${a.slice(0, 3)}...${a.slice(-3)}`;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0));

// ---------------------------------------------------------------- token identity
const asset = JSON.parse(read(`${RAW}/asset.json`)) as { id: string; name: string; symbol: string; icon?: string; dev: string; totalSupply: number; firstPool?: { id: string } };
if (asset.id !== cfg.mint) throw new Error('asset record does not match the mint in the config');
const DEV = asset.dev;
const SUPPLY = asset.totalSupply;
const SYMBOL = asset.symbol;

// ---------------------------------------------------------------- ticks (cleaned, never invented)
const candles = JSON.parse(read(`${RAW}/candles.json`)) as { source: string; url: string; fetchedAt: string; interval: string; candles: { time?: unknown; close?: unknown }[] };
const cleaning = { rawCandles: candles.candles.length, malformedDropped: 0, duplicateTimestampsDropped: 0, outOfOrderResorted: false };
let ticks: PriceTick[] = [];
for (const c of candles.candles) {
  const timestamp = Number(c.time);
  const price = Number(c.close);
  if (!Number.isFinite(timestamp) || !(price > 0) || !Number.isFinite(price)) { cleaning.malformedDropped++; continue; }
  ticks.push({ timestamp, price });
}
if (ticks.some((t, i) => i > 0 && t.timestamp < ticks[i - 1].timestamp)) {
  cleaning.outOfOrderResorted = true;
  ticks = ticks.map((t, i) => ({ t, i })).sort((a, b) => a.t.timestamp - b.t.timestamp || a.i - b.i).map((x) => x.t);
}
const dedup: PriceTick[] = [];
for (const t of ticks) {
  if (dedup.length && dedup[dedup.length - 1].timestamp === t.timestamp) { dedup[dedup.length - 1] = t; cleaning.duplicateTimestampsDropped++; } else dedup.push(t);
}
ticks = dedup;
// The chart API returns the latest candles ending at the window's end (it ignores `from`), so the
// replay window is applied here, explicitly and visibly.
const beforeWindow = ticks.length;
ticks = ticks.filter((t) => t.timestamp >= Date.parse(cfg.window.from) / 1000 && t.timestamp <= Date.parse(cfg.window.to) / 1000);
(cleaning as Record<string, unknown>).outsideWindowDropped = beforeWindow - ticks.length;
const FIRST = ticks[0].timestamp;
const LAST = ticks[ticks.length - 1].timestamp;

// ---------------------------------------------------------------- the collapse, from the price series
const peak = ticks.reduce((m, t) => (t.price > m.price ? t : m), ticks[0]);
const collapseTick = ticks.find((t) => t.timestamp > peak.timestamp && t.price <= peak.price * cfg.collapse.fraction);
if (!collapseTick) throw new Error('no collapse found by the configured rule');
const RUG = collapseTick.timestamp;
const collapseReason = `First tick after the replay's peak (${peak.price.toPrecision(4)} at ${iso(peak.timestamp)}) whose price is at or below ${(cfg.collapse.fraction * 100).toFixed(0)}% of that peak: ${collapseTick.price.toPrecision(4)} at ${iso(RUG)}. A price-only rule, stored with this replay; the engine does not know it.`;

// ---------------------------------------------------------------- wallets: complete histories of the candidates
const cand = JSON.parse(read(`${RAW}/candidates.json`)) as { wallets: Record<string, string[]>; sampleTrades: number };
const histories = new Map<string, Trade[]>();
const capped = new Set<string>();
for (const w of Object.keys(cand.wallets)) {
  const f = `${RAW}/wallets/${w}.jsonl`;
  if (!exists(`${f}.done`)) throw new Error(`incomplete download for candidate ${w}: run fetch-rug`);
  if (read(`${f}.done`) === 'capped') capped.add(w);
  const rows: Trade[] = [];
  const seen = new Set<string>();
  if (exists(f)) for (const line of read(f).split(String.fromCharCode(10))) {
    if (!line) continue;
    const t = JSON.parse(line) as Trade;
    const k = `${t.actionId}|${t.txHash}`;
    if (!seen.has(k)) { seen.add(k); rows.push(t); }
  }
  rows.sort((a, b) => (BigInt(a.actionId) < BigInt(b.actionId) ? -1 : BigInt(a.actionId) > BigInt(b.actionId) ? 1 : 0));
  histories.set(w, rows);
}
const holders = (JSON.parse(read(`${RAW}/holders.json`)) as { holders: { address: string; tags?: unknown[] }[] }).holders;
const infra = new Set<string>(holders.filter((h) => h.tags?.length).map((h) => h.address));
if (asset.firstPool) infra.add(asset.firstPool.id);
for (const h of histories.values()) for (const t of h) infra.add(t.poolId);

// ---------------------------------------------------------------- DEV (creator) and INSIDER (direct recipients)
const devEvidence: Evidence[] = [{ rule: 'jupiter-asset-dev', detail: `Jupiter asset metadata lists ${short(DEV)} as the token's dev (creator) wallet.` }];
const tagged = new Map<string, { tag: WalletTag; evidence: Evidence[] }>();
tagged.set(DEV, { tag: 'DEV', evidence: devEvidence });
const insiders = new Map<string, Evidence[]>();
const devEvents: Ev[] = [];
const devTxs = exists(`${RAW}/dev.json`) ? (JSON.parse(read(`${RAW}/dev.json`)) as { txs: Record<string, any> }) : { txs: {} };
{
  type Move = { ts: number; sig: string; amount: number; to: string; liquidity: boolean; removal: boolean };
  const moves: Move[] = [];
  for (const [sig, tx] of Object.entries(devTxs.txs)) {
    if (!tx) continue;
    const delta = new Map<string, number>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === cfg.mint) delta.set(b.owner, (delta.get(b.owner) ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
    for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === cfg.mint) delta.set(b.owner, (delta.get(b.owner) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
    const logs: string[] = tx.meta.logMessages ?? [];
    const ts = tx.blockTime as number;
    const devDelta = delta.get(DEV) ?? 0;
    const removal = logs.some((l) => /Instruction: (RemoveLiquidity|RemoveAllLiquidity|WithdrawLiquidity)/.test(l));
    if (removal && devDelta > 1) moves.push({ ts, sig, amount: devDelta, to: DEV, liquidity: true, removal: true });
    if (devDelta < -1) {
      for (const [owner, d] of delta) {
        if (owner === DEV || d <= 1) continue;
        const isInfra = infra.has(owner);
        const liquidity = isInfra && logs.some((l) => /AddLiquidity|AddLiquidityOneSide|Deposit/.test(l));
        if (!isInfra) {
          const ev: Evidence = { rule: 'direct-recipient-of-dev-supply', detail: `Received ${fmtTok(d)} ${SYMBOL} directly from the dev wallet in one transaction at ${iso(ts)}.`, signatures: [sig] };
          insiders.set(owner, [...(insiders.get(owner) ?? []), ev]);
        }
        moves.push({ ts, sig, amount: d, to: owner, liquidity, removal: false });
      }
    }
  }
  // dev supply moves become events inside the window. Small transfers are merged into bursts: one event,
  // stamped with the burst's first real timestamp, listing every transaction signature it contains.
  const inWin = moves.filter((m) => m.ts >= FIRST && m.ts <= LAST && !m.removal).sort((a, b) => a.ts - b.ts || (a.sig < b.sig ? -1 : 1));
  const big = inWin.filter((m) => m.amount >= SUPPLY * cfg.rules.devMove.minPctSupply || m.liquidity);
  const small = inWin.filter((m) => !(m.amount >= SUPPLY * cfg.rules.devMove.minPctSupply || m.liquidity) && !infra.has(m.to));
  for (const m of big) {
    devEvents.push({ id: `${m.sig.slice(0, 12)}:${short(m.to)}`, timestamp: m.ts, walletAddress: DEV, tag: 'DEV', action: 'SUPPLY_MOVE', amount: m.amount, amountUnit: SYMBOL, signature: m.sig, source: 'solana-rpc getTransaction', classification: devEvidence, note: m.liquidity ? `Dev wallet added ${fmtTok(m.amount)} ${SYMBOL} to a liquidity pool.` : `Dev wallet transferred ${fmtTok(m.amount)} ${SYMBOL} to ${short(m.to)}.` });
    if (!m.liquidity && !infra.has(m.to)) devEvents.push({ id: `${m.sig.slice(0, 12)}:${short(m.to)}:recv`, timestamp: m.ts, walletAddress: m.to, tag: 'INSIDER', action: 'SUPPLY_MOVE', amount: m.amount, amountUnit: SYMBOL, signature: m.sig, source: 'solana-rpc getTransaction', classification: insiders.get(m.to) ?? [], note: `Received ${fmtTok(m.amount)} ${SYMBOL} directly from the dev wallet.` });
  }
  let burst: Move[] = [];
  const flush = () => {
    if (!burst.length) return;
    const total = burst.reduce((s, m) => s + m.amount, 0);
    const sigs = burst.map((m) => m.sig);
    devEvents.push({ id: `${sigs[0].slice(0, 12)}:burst${burst.length}`, timestamp: burst[0].ts, walletAddress: DEV, tag: 'DEV', action: 'SUPPLY_MOVE', amount: total, amountUnit: SYMBOL, signature: sigs[0], signatures: sigs, source: 'solana-rpc getTransaction', classification: devEvidence, note: `Dev wallet sent ${fmtTok(total)} ${SYMBOL} (${((total / SUPPLY) * 100).toFixed(2)}% of supply) to ${burst.length} wallets in a burst of ${burst.length} transactions starting at ${iso(burst[0].ts)}.` });
    burst = [];
  };
  for (const m of small) {
    if (burst.length && (m.ts - burst[burst.length - 1].ts > cfg.rules.devMove.burstGapSec || m.ts - burst[0].ts > cfg.rules.devMove.burstMaxSec)) flush();
    burst.push(m);
  }
  flush();
  for (const m of moves.filter((x) => x.removal && x.ts >= FIRST && x.ts <= LAST)) {
    devEvents.push({ id: `${m.sig.slice(0, 12)}:liq`, timestamp: m.ts, walletAddress: DEV, tag: 'LIQUIDITY', action: 'LIQUIDITY_REMOVAL', amount: m.amount, amountUnit: SYMBOL, signature: m.sig, source: 'solana-rpc getTransaction (RemoveLiquidity instruction in logs)', classification: [{ rule: 'onchain-remove-liquidity-instruction', detail: `The dev wallet executes a RemoveLiquidity instruction and receives ${fmtTok(m.amount)} ${SYMBOL}.`, signatures: [m.sig] }], note: 'Dev wallet removed liquidity.' });
  }
}
for (const [w, ev] of insiders) if (!tagged.has(w)) tagged.set(w, { tag: 'INSIDER', evidence: ev });

// ---------------------------------------------------------------- SMART and WHALE from complete histories
interface Stats { lastBuy: number; buyUsd: number; sellUsd: number; buyTok: number; sellTok: number; first: number; last: number; lastSell: number; maxTrade: number; trades: number; mev: number; windowUsd: number }
const stats = new Map<string, Stats>();
for (const [w, h] of histories) {
  const s: Stats = { lastBuy: 0, buyUsd: 0, sellUsd: 0, buyTok: 0, sellTok: 0, first: Infinity, last: 0, lastSell: 0, maxTrade: 0, trades: 0, mev: 0, windowUsd: 0 };
  for (const t of h) {
    const ts = sec(t.timestamp);
    if (t.type === 'buy') { s.buyUsd += t.usdVolume; s.buyTok += t.amount; s.lastBuy = Math.max(s.lastBuy, ts); } else { s.sellUsd += t.usdVolume; s.sellTok += t.amount; s.lastSell = Math.max(s.lastSell, ts); }
    s.first = Math.min(s.first, ts); s.last = Math.max(s.last, ts); s.maxTrade = Math.max(s.maxTrade, t.usdVolume); s.trades++; if (t.isMev) s.mev++;
    if (ts >= FIRST && ts <= LAST) s.windowUsd += t.usdVolume;
  }
  stats.set(w, s);
}
const R = cfg.rules;
const isBot = (s: Stats) => s.trades > 0 && s.mev / s.trades > R.botFilter.maxMevTradeFraction;
const open = [...stats.keys()].filter((w) => !tagged.has(w) && !infra.has(w) && !capped.has(w));
const smartPool = open
  .map((w) => ({ w, s: stats.get(w) as Stats, profit: (stats.get(w) as Stats).sellUsd - (stats.get(w) as Stats).buyUsd }))
  .filter(({ s, profit }) => !isBot(s) && profit >= R.smart.minRealizedProfitUsd && s.buyTok > 0 && s.sellTok / s.buyTok >= R.smart.minSoldFractionOfBought && (!R.smart.lastSellBeforeCollapse || s.lastSell < RUG) && (!R.smart.lastBuyBeforePeak || s.lastBuy < peak.timestamp))
  .sort((a, b) => b.profit - a.profit)
  .slice(0, R.smart.topN);
smartPool.forEach(({ w, s, profit }, i) => tagged.set(w, { tag: 'SMART', evidence: [{ rule: 'early-profitable-exit', detail: `Rank ${i + 1} of the candidates by realised profit. Recorded trades ${iso(s.first)} to ${iso(s.last)}: bought ${fmtUsd(s.buyUsd)}, sold ${fmtUsd(s.sellUsd)} (realised ${fmtUsd(profit)}); sold ${((s.sellTok / s.buyTok) * 100).toFixed(0)}% of the ${SYMBOL} bought; last sell ${iso(s.lastSell)}${R.smart.lastSellBeforeCollapse ? `, before the collapse marker ${iso(RUG)}` : ''}${R.smart.lastBuyBeforePeak ? `; last buy ${iso(s.lastBuy)}, before the peak ${iso(peak.timestamp)} (stopped buying: an exit, not a flipper)` : ''}.` }] }));
open.filter((w) => !tagged.has(w) && !isBot(stats.get(w) as Stats) && (stats.get(w) as Stats).windowUsd > 0)
  .sort((a, b) => (stats.get(b) as Stats).windowUsd - (stats.get(a) as Stats).windowUsd)
  .slice(0, R.whale.topN)
  .forEach((w, i) => tagged.set(w, { tag: 'WHALE', evidence: [{ rule: 'largest-in-window-volume', detail: `Rank ${i + 1} of the candidates by USD traded inside the replay window (${fmtUsd((stats.get(w) as Stats).windowUsd)}); not a dev, insider or smart-exit wallet and not bot-like.` }] }));

// ---------------------------------------------------------------- trade events (one per transaction)
const legs = new Map<string, { t: Trade; usd: number; tok: number }>();
for (const [w, h] of histories) {
  const cls = tagged.get(w);
  if (!cls) continue;
  for (const t of h) {
    const ts = sec(t.timestamp);
    if (ts < FIRST || ts > LAST) continue;
    const key = `${t.txHash}|${w}|${t.type}`;
    const cur = legs.get(key);
    if (cur) { cur.usd += t.usdVolume; cur.tok += t.amount; } else legs.set(key, { t, usd: t.usdVolume, tok: t.amount });
  }
}
const tradeEvents: Ev[] = [];
{
  // One event per BURST: a wallet's consecutive same-direction transactions within a few seconds of
  // each other. The event is stamped with the burst's first real timestamp and lists every
  // transaction signature in it; sizes are summed. Nothing is moved in time.
  type Leg = { t: Trade; usd: number; tok: number; ts: number };
  const byWallet = new Map<string, Leg[]>();
  for (const { t, usd, tok } of legs.values()) {
    const arr = byWallet.get(t.traderAddress) ?? [];
    arr.push({ t, usd, tok, ts: sec(t.timestamp) });
    byWallet.set(t.traderAddress, arr);
  }
  for (const [w, arr] of byWallet) {
    const cls = tagged.get(w) as { tag: WalletTag; evidence: Evidence[] };
    const floor = R.eventMinUsd[cls.tag as keyof typeof R.eventMinUsd] ?? Infinity;
    for (const side of ['buy', 'sell'] as const) {
      const legsSide = arr.filter((l) => l.t.type === side).sort((x, y) => x.ts - y.ts || (x.t.actionId < y.t.actionId ? -1 : 1));
      let burst: Leg[] = [];
      const flush = () => {
        if (!burst.length) return;
        const usd = burst.reduce((a2, l) => a2 + l.usd, 0);
        const tok = burst.reduce((a2, l) => a2 + l.tok, 0);
        if (usd >= floor) {
          const sigs = [...new Set(burst.map((l) => l.t.txHash))];
          tradeEvents.push({
            id: `${sigs[0].slice(0, 12)}:${short(w)}${sigs.length > 1 ? `:b${sigs.length}` : ''}`,
            timestamp: burst[0].ts,
            walletAddress: w,
            tag: cls.tag,
            action: side === 'buy' ? 'BUY' : 'SELL',
            amount: Math.round(usd),
            amountUnit: 'USD',
            signature: sigs[0],
            ...(sigs.length > 1 ? { signatures: sigs } : {}),
            source: 'jupiter datapi /v1/txs (trade tape)',
            classification: cls.evidence,
            note: `${side === 'buy' ? 'Bought' : 'Sold'} ${fmtTok(tok)} ${SYMBOL} for ${fmtUsd(usd)}${sigs.length > 1 ? ` across ${sigs.length} transactions (${burst[burst.length - 1].ts - burst[0].ts}s)` : ''}.`,
          });
        }
        burst = [];
      };
      for (const l of legsSide) {
        if (burst.length && (l.ts - burst[burst.length - 1].ts > R.tradeBurst.gapSec || l.ts - burst[0].ts > R.tradeBurst.maxSec)) flush();
        burst.push(l);
      }
      flush();
    }
  }
}

// ---------------------------------------------------------------- assemble
// Token-denominated events get an estimated USD value: tokens x the tick price in force at the event.
const priceInForce = (ts: number) => {
  let p = ticks[0].price;
  for (const t of ticks) { if (t.timestamp <= ts) p = t.price; else break; }
  return p;
};
for (const e of [...devEvents, ...tradeEvents]) if (e.amountUnit !== 'USD' && e.amount !== undefined) e.valueUsd = Math.round(e.amount * priceInForce(e.timestamp));
const all = [...devEvents, ...tradeEvents].filter((e) => e.timestamp >= FIRST && e.timestamp <= LAST);
const seen = new Set<string>();
const events: Ev[] = [];
let duplicates = 0;
for (const e of all.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  const key = `${e.signature}|${e.walletAddress}|${e.action}|${e.amount}`;
  if (seen.has(key)) { duplicates++; continue; }
  seen.add(key);
  events.push(e);
}

// paper SOL <-> USD: median usd/native over in-window trades
const ratios: number[] = [];
for (const h of histories.values()) for (const t of h) { const ts = sec(t.timestamp); if (ts >= FIRST && ts <= LAST && (t.nativeVolume ?? 0) > 0.05 && t.usdVolume > 100) ratios.push(t.usdVolume / (t.nativeVolume as number)); }
if (exists(`${RAW}/tape-sample.jsonl`)) for (const l of read(`${RAW}/tape-sample.jsonl`).split(String.fromCharCode(10))) { if (!l) continue; const t = JSON.parse(l) as Trade; if ((t.nativeVolume ?? 0) > 0.05 && t.usdVolume > 100) ratios.push(t.usdVolume / (t.nativeVolume as number)); }
if (ratios.length < 20) throw new Error('not enough trades to derive a SOL/USD rate');
ratios.sort((a, b) => a - b);
const paperSolUsd = +ratios[Math.floor((ratios.length - 1) / 2)].toFixed(2);

// ---------------------------------------------------------------- the replay
const replayEvents: ReplayEvent[] = events.map((x) => ({
  id: x.id,
  timestamp: x.timestamp,
  wallet: short(x.walletAddress),
  ...(x.tag ? { tag: x.tag } : {}),
  action: x.action,
  ...(x.amount !== undefined ? { amount: x.amount, amountUnit: x.amountUnit } : {}),
  ...(x.valueUsd !== undefined ? { valueUsd: x.valueUsd } : {}),
}));
const replay: Replay = parseReplay({
  id: cfg.id,
  token: asset.symbol,
  name: asset.name,
  symbol: asset.symbol,
  mint: asset.id,
  logoUrl: asset.icon ?? null,
  logoSource: asset.icon ? 'Jupiter asset metadata (datapi.jup.ag/v1/assets/search), icon field' : null,
  rugType: cfg.rugType,
  date: cfg.date,
  replayStart: FIRST,
  replayEnd: LAST,
  signal: cfg.signal,
  collapseReason,
  source: `${candles.source} (${candles.url})`,
  ticks,
  events: replayEvents,
  rugTimestamp: RUG,
  playbackSpeed: cfg.playbackSpeed,
  paperSolUsd,
  meta: {
    priceUnit: 'USD',
    priceField: 'close of each candle, at the candle timestamp (epoch seconds)',
    interval: candles.interval,
    rawDir: RAW,
    fetchedAt: candles.fetchedAt,
    devWallet: short(DEV),
    cleaning,
    walletData: 'Jupiter trades API (trader-filtered histories of sampled candidate wallets) + Solana public RPC (dev wallet transactions). No Helius/Birdeye key was used.',
    candidates: Object.keys(cand.wallets).length,
    cappedWalletsExcludedFromProfitRules: capped.size,
  },
});
writeFileSync(resolve(ROOT, `src/data/replays/${slug}.json`), JSON.stringify(replay, null, 1) + '\n');
const wallets = [...tagged.entries()].map(([address, v]) => ({ address, display: short(address), tag: v.tag, evidence: v.evidence, stats: stats.get(address) ?? null }));
writeFileSync(resolve(ROOT, `data/rugs/${slug}/events.json`), JSON.stringify({ paperSolUsd, window: { from: iso(FIRST), to: iso(LAST), collapse: iso(RUG) }, rules: cfg.rules, duplicatesDropped: duplicates, events, wallets }, null, 1) + '\n');

const byTag: Record<string, number> = {};
for (const e of events) byTag[e.tag ?? 'untagged'] = (byTag[e.tag ?? 'untagged'] ?? 0) + 1;
const sigEv = events.find((e) => e.tag === cfg.signal.tag && e.action === cfg.signal.action && ((e.amountUnit === 'USD' ? e.amount : e.valueUsd) ?? 0) >= cfg.signal.minUsd);
const report = { slug, name: asset.name, symbol: asset.symbol, mint: asset.id, ticks: ticks.length, events: events.length, byTag, peak, collapse: collapseTick, paperSolUsd, signalEvent: sigEv ? { id: sigEv.id, at: iso(sigEv.timestamp), wallet: short(sigEv.walletAddress), usd: sigEv.amount } : null, taggedWallets: wallets.reduce((a: Record<string, number>, w) => ((a[w.tag] = (a[w.tag] ?? 0) + 1), a), {}), cleaning };
writeFileSync(resolve(ROOT, `data/rugs/${slug}/report.json`), JSON.stringify(report, null, 2) + '\n');

console.log(`${asset.name} (${asset.symbol}) ${cfg.rugType}`);
console.log(`ticks ${ticks.length} (${iso(FIRST)} -> ${iso(LAST)}), peak ${peak.price.toPrecision(4)} @ ${iso(peak.timestamp)}, collapse ${collapseTick.price.toPrecision(4)} @ ${iso(RUG)}`);
console.log(`events ${events.length} ${JSON.stringify(byTag)}  tagged wallets ${JSON.stringify(report.taggedWallets)}  paperSolUsd ${paperSolUsd}`);
console.log(sigEv ? `signal -> ${sigEv.id} ${iso(sigEv.timestamp)} ${fmtUsd((sigEv.amountUnit === 'USD' ? sigEv.amount : sigEv.valueUsd) ?? 0)}` : 'NO QUALIFYING SIGNAL EVENT: adjust the signal rule');
for (const e of events) console.log(`${iso(e.timestamp).slice(11, 19)} ${(e.tag ?? '-').padEnd(8)} ${e.action.padEnd(17)} ${short(e.walletAddress)}  ${e.amount !== undefined ? (e.amountUnit === 'USD' ? fmtUsd(e.amount) : `${fmtTok(e.amount)} ${e.amountUnit}${e.valueUsd !== undefined ? ` (~${fmtUsd(e.valueUsd)})` : ''}`) : ''}`);
