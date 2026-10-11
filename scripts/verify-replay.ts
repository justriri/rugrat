// Dev check: the replay is deterministic, speed only changes pacing, and the terrain is the chart.
// Run with `npm run verify:replay` (bundled with esbuild, runs in node).
import { existsSync, readFileSync } from 'node:fs';

import type { HostMessage } from '../src/bridge/protocol';
import { activeReplay, demoReplay, getReplay } from '../src/data/replays';
import { ReplayEngine } from '../src/game/ReplayEngine';
import { applyBuy, applySell, newPlayer, STARTING_PAPER_SOL } from '../src/game/player';
import { computeVerdict, signalEvent } from '../src/game/verdict';
import { tickIndexAt } from '../src/game/timeline';
import { buildTerrain } from '../src/game/terrain';

// `REPLAY=demo npm run verify:replay` runs the same checks against the synthetic replay (which has events).
// REPLAY=<id|demo> picks the replay under test (default: the active one). `npm run verify:replay`
// runs this whole suite against every registered replay.
const replay =
  process.env.REPLAY === 'demo'
    ? demoReplay
    : process.env.REPLAY
      ? (getReplay(process.env.REPLAY) ?? (() => { throw new Error(`unknown replay ${process.env.REPLAY}`); })())
      : activeReplay;

let failed = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};

/** Runs a full replay and returns the ordered tick/event/rug log (clock syncs excluded). */
function run(speed: number, chunkMs: () => number) {
  const log: string[] = [];
  let terrain = '';
  // clock window of the step currently being processed, to prove each event fires in its own step
  let prevClock = -Infinity;
  let nowClock = -Infinity;
  const emissions: { id: string; ts: number; prev: number; now: number }[] = [];
  const tagsSeenByScene = new Set<string>();
  const engine = new ReplayEngine(
    replay,
    (m: HostMessage) => {
      if (m.type === 'WALLET_EVENT') {
        log.push(`E:${m.id}`);
        const ev = replay.events.find((e) => e.id === m.id)!;
        emissions.push({ id: m.id, ts: ev.timestamp, prev: prevClock, now: nowClock });
        if (m.tag) tagsSeenByScene.add(m.tag);
      }
      if (m.type === 'PRICE_TICK') log.push(`T${m.index}`);
      if (m.type === 'SHOW_RUG') log.push('RUG');
      if (m.type === 'START_REPLAY') terrain = JSON.stringify(m.terrain);
    },
    () => 0, // frozen wall clock: only advanceForTest moves time
  );
  engine.setSpeed(speed);
  nowClock = replay.ticks[0].timestamp;
  engine.start();
  let realMs = 0;
  while (engine.getSnapshot().phase !== 'finished') {
    const dt = chunkMs();
    prevClock = engine.getSnapshot().clock.timestamp;
    nowClock = prevClock + (dt / 1000) * speed;
    engine.advanceForTest(dt);
    realMs += dt;
  }
  const snap = engine.getSnapshot();
  // events are in the feed (newest first); read them back in timeline order
  const events = [...snap.feed].reverse().map((f) => `${f.event.timestamp}:${f.event.action}`);
  engine.dispose();
  return { log: log.join(','), terrain, events: events.join(','), realMs, clock: snap.clock, emissions, tagsSeenByScene };
}

const base = replay.playbackSpeed;
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const a = run(base, () => 40);
const a2 = run(base, () => 40);
const jitter = run(base, () => 5 + rnd() * 900); // very uneven frame times
const x2 = run(base * 2, () => 40);
const x4 = run(base * 4, () => 333);

console.log(`\n${replay.token}: ${replay.ticks.length} ticks, ${replay.events.length} events`);
check(a.log === a2.log && a.terrain === a2.terrain && a.events === a2.events, 'restart reproduces identical terrain, tick order and events');
check(a.log === jitter.log && a.events === jitter.events, 'uneven frame times do not change the sequence');
check(a.log === x2.log && a.terrain === x2.terrain && a.events === x2.events, '2x speed: identical sequence and terrain');
check(a.log === x4.log && a.events === x4.events, '4x speed: identical sequence');
check(Math.abs(x2.realMs * 2 - a.realMs) / a.realMs < 0.03, `2x takes half the real time (${(a.realMs / 1000).toFixed(1)}s -> ${(x2.realMs / 1000).toFixed(1)}s)`);
check(a.clock.timestamp === replay.ticks[replay.ticks.length - 1].timestamp, 'clock ends exactly on the last historical timestamp');

// ---- wallet events ------------------------------------------------------------------------------
const evs = replay.events;
const first = replay.ticks[0].timestamp;
const last = replay.ticks[replay.ticks.length - 1].timestamp;
check(evs.every((e, i) => i === 0 || e.timestamp >= evs[i - 1].timestamp), `events are chronologically sorted (${evs.length} events)`);
check(evs.every((e) => e.timestamp >= first && e.timestamp <= last), 'every event timestamp lies inside the replay window');
check(new Set(evs.map((e) => e.id)).size === evs.length, 'event ids are unique (no duplicate events)');
check(evs.every((e) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(e.wallet)) && evs.every((e) => e.wallet.length <= 11), 'replay events carry shortened wallets only, never full addresses');

// independent expected timeline: ticks and events merged by timestamp, ticks first on ties
const expected = [
  ...replay.ticks.map((t, i) => ({ ts: t.timestamp, k: 0, i, label: `T${i}` })),
  ...evs.map((e, i) => ({ ts: e.timestamp, k: 1, i, label: `E:${e.id}` })),
]
  .sort((a, b) => a.ts - b.ts || a.k - b.k || a.i - b.i)
  .map((x) => x.label)
  .filter((l) => l !== undefined);
const gotSeq = a.log.split(',').filter((x) => x.startsWith('T') || x.startsWith('E:'));
check(JSON.stringify(expected) === JSON.stringify(gotSeq), 'emitted tick+event sequence equals the independently sorted timeline');
check(
  [a, jitter, x2, x4].every((r) => r.emissions.every((m) => m.ts <= m.now + 1e-6 && (m.prev === -Infinity || m.ts > m.prev - 1e-6))),
  'every event is emitted in the step where the clock crosses its timestamp (never early, never late)',
);
check(a.emissions.length === evs.length, 'every event is emitted exactly once per replay');
check(a.log === jitter.log && a.log === x2.log && a.log === x4.log, 'event order is identical across restart, uneven frames, 2x and 4x');

// provenance: every event traces to a record with evidence, a signature and a matching short wallet
if (replay.id.startsWith('libra') && existsSync('data/processed/libra.events.json')) {
  const prov = JSON.parse(readFileSync('data/processed/libra.events.json', 'utf8')).events as {
    id: string; timestamp: number; walletAddress: string; tag?: string; action: string; signature: string; classification: { rule: string; detail: string }[];
  }[];
  const byId = new Map(prov.map((p) => [p.id, p]));
  check(prov.length === evs.length && evs.every((e) => byId.has(e.id)), 'every replay event has a provenance record (and vice versa)');
  check(
    evs.every((e) => {
      const p = byId.get(e.id)!;
      return p.timestamp === e.timestamp && p.action === e.action && p.tag === e.tag && e.wallet === `${p.walletAddress.slice(0, 3)}...${p.walletAddress.slice(-3)}`;
    }),
    'replay events match their provenance (timestamp, action, tag, shortened wallet)',
  );
  check(prov.every((p) => p.signature.length > 40 && p.classification.length > 0 && p.classification.every((c) => c.rule && c.detail)), 'every event records a transaction signature and why its wallet was classified');
}

// hard mode: the scene must never receive a label
{
  const tags = new Set<string>();
  const e = new ReplayEngine(replay, (m: HostMessage) => { if (m.type === 'WALLET_EVENT' && m.tag) tags.add(m.tag); }, () => 0);
  e.setDifficulty('hard');
  e.start();
  while (e.getSnapshot().phase !== 'finished') e.advanceForTest(500);
  check(tags.size === 0, 'hard mode never sends a tag to the scene');
  e.dispose();
}
check(evs.length === 0 || a.tagsSeenByScene.size > 0, 'easy mode sends tags to the scene');

const expectedTicks = replay.ticks.map((_, i) => `T${i}`);
const gotTicks = a.log.split(',').filter((x) => x.startsWith('T'));
check(JSON.stringify(expectedTicks) === JSON.stringify(gotTicks), 'every tick emitted exactly once, in order');

// The clock advances exactly realMs * speed of historical time, at 1x and 2x.
for (const mult of [1, 2]) {
  const e = new ReplayEngine(replay, () => {}, () => 0);
  e.setSpeed(mult);
  e.start();
  const t0 = replay.ticks[0].timestamp;
  e.advanceForTest(10_000);
  const got = e.getSnapshot().clock.timestamp - t0;
  check(Math.abs(got - 10 * mult) < 1e-6, `${mult}x: 10 real seconds advance the clock exactly ${10 * mult} historical seconds (got ${got})`);
  e.dispose();
}

const terrain = buildTerrain(replay.ticks);
check(
  terrain.every((c, i) => c.price === replay.ticks[i].price && c.timestamp === replay.ticks[i].timestamp),
  'one column per historical tick, same order, same prices and timestamps',
);
check(
  terrain.every((c, i) => {
    if (i === 0) return true;
    const d = Math.sign(c.price - terrain[i - 1].price);
    return (d > 0 && c.dir === 'up') || (d < 0 && c.dir === 'down') || (d === 0 && c.dir === 'flat');
  }),
  'column colour direction matches the price change at every tick',
);
let mono = true;
for (let i = 0; i < terrain.length; i++)
  for (let j = 0; j < terrain.length; j++)
    if (terrain[i].price > terrain[j].price && terrain[i].level < terrain[j].level) mono = false;
check(mono, 'height is a monotonic function of price (higher price never maps lower)');

// ---- paper trading ------------------------------------------------------------------------------
// Trades are made at exact replay-clock timestamps. To compare runs with different frame timing
// we advance in uneven chunks and make the last step land exactly on the target timestamp.
interface TradeResult {
  buyTs: number; buyTick: number; buyPrice: number; solSpent: number; tokens: number;
  sellTs: number; sellTick: number; sellPrice: number; proceeds: number; pnlSol: number; pnlPct: number; balance: number;
  frozen: boolean; emittedAfterSell: number; seqPrefix: string; totalAfterBuy: number; clockBeforeBuy: number; clockBeforeSell: number;
}

function tradeRun(speed: number, chunkMs: () => number, buyAt: number, sellAt: number, useResetPath = false): TradeResult {
  const log: string[] = [];
  const engine = new ReplayEngine(
    replay,
    (m: HostMessage) => {
      if (m.type === 'PRICE_TICK') log.push(`T${m.index}`);
      else if (m.type === 'WALLET_EVENT') log.push(`E:${m.id}`);
    },
    () => 0,
  );
  engine.setSpeed(speed);
  engine.start();
  if (useResetPath) {
    engine.advanceForTest(3000);
    engine.reset(); // a restart must give the same result as a fresh run
    log.length = 0;
  }
  const advanceTo = (target: number) => {
    for (;;) {
      const remainMs = ((target - engine.getSnapshot().clock.timestamp) / speed) * 1000;
      if (remainMs <= 0) break;
      const dt = chunkMs();
      if (dt >= remainMs) { engine.advanceForTest(remainMs); break; }
      engine.advanceForTest(dt);
    }
  };
  advanceTo(buyAt);
  const clockBeforeBuy = engine.getSnapshot().clock.timestamp;
  engine.buy();
  const afterBuy = engine.getSnapshot();
  advanceTo(sellAt);
  const clockBeforeSell = engine.getSnapshot().clock.timestamp;
  engine.sell();
  const sold = engine.getSnapshot();
  const logAtSell = log.length;
  const seqPrefix = log.join(',');
  // the replay must now be frozen: more real time must change nothing
  engine.advanceForTest(120_000);
  engine.buy();
  engine.sell();
  const later = engine.getSnapshot();
  const frozen = later.clock.timestamp === sold.clock.timestamp && later.phase === 'exited' && later.player.paperSol === sold.player.paperSol && !later.canBuy && !later.canSell;
  const p = sold.player;
  engine.dispose();
  return {
    buyTs: p.buyTimestamp!, buyTick: p.buyTickIndex!, buyPrice: p.buyPrice!, solSpent: p.solSpent, tokens: afterBuy.player.tokens,
    sellTs: p.sellTimestamp!, sellTick: p.sellTickIndex!, sellPrice: p.sellPrice!, proceeds: p.proceedsSol!, pnlSol: p.realizedPnlSol, pnlPct: p.realizedPnlPct!, balance: p.paperSol,
    frozen, emittedAfterSell: log.length - logAtSell, seqPrefix, totalAfterBuy: afterBuy.totalSol, clockBeforeBuy, clockBeforeSell,
  };
}

const dur = last - first;
const scenarios = [
  { name: 'early buy, sell mid-replay', buyAt: first + 0.2 * dur + 3.37, sellAt: first + 0.55 * dur + 11.71 },
  { name: 'buy mid-replay, sell late', buyAt: first + 0.45 * dur + 1.13, sellAt: first + 0.9 * dur + 0.41 },
];
const near = (x: number, y: number, tol = 1e-6) => Math.abs(x - y) <= tol * Math.max(1, Math.abs(y));
const sameTrade = (x: TradeResult, y: TradeResult) =>
  near(x.buyTs, y.buyTs) && x.buyTick === y.buyTick && x.buyPrice === y.buyPrice && near(x.tokens, y.tokens, 1e-9) &&
  near(x.sellTs, y.sellTs) && x.sellTick === y.sellTick && x.sellPrice === y.sellPrice && near(x.proceeds, y.proceeds, 1e-9) &&
  near(x.balance, y.balance, 1e-9) && near(x.pnlPct, y.pnlPct, 1e-9);

for (const sc of scenarios) {
  const t = tradeRun(base, () => 40, sc.buyAt, sc.sellAt);
  const label = `[${sc.name}]`;
  check(near(t.buyTs, sc.buyAt) && near(t.buyTs, t.clockBeforeBuy), `${label} BUY is stamped with the exact replay clock timestamp`);
  const buyTickExpected = tickIndexAt(replay, sc.buyAt);
  check(t.buyTick === buyTickExpected && t.buyPrice === replay.ticks[buyTickExpected].price, `${label} BUY uses the price of the tick in force at that timestamp (tick ${buyTickExpected}, ${t.buyPrice})`);
  check(near(t.sellTs, sc.sellAt) && near(t.sellTs, t.clockBeforeSell), `${label} SELL is stamped with the exact replay clock timestamp`);
  const sellTickExpected = tickIndexAt(replay, sc.sellAt);
  check(t.sellTick === sellTickExpected && t.sellPrice === replay.ticks[sellTickExpected].price, `${label} SELL uses the price of the tick in force at that timestamp (tick ${sellTickExpected}, ${t.sellPrice})`);

  // independent accounting from the replay data alone
  const tokens = (STARTING_PAPER_SOL * replay.paperSolUsd) / replay.ticks[buyTickExpected].price;
  const proceeds = (tokens * replay.ticks[sellTickExpected].price) / replay.paperSolUsd;
  check(t.solSpent === STARTING_PAPER_SOL && near(t.tokens, tokens, 1e-12), `${label} BUY spends all ${STARTING_PAPER_SOL} paper SOL and receives ${tokens.toFixed(4)} tokens`);
  check(near(t.totalAfterBuy, STARTING_PAPER_SOL, 1e-12), `${label} balance right after BUY is still ${STARTING_PAPER_SOL} SOL (marked at the buy price)`);
  check(near(t.proceeds, proceeds, 1e-12) && near(t.balance, proceeds, 1e-12) && near(t.pnlSol, proceeds - STARTING_PAPER_SOL, 1e-12) && near(t.pnlPct, (proceeds / STARTING_PAPER_SOL - 1) * 100, 1e-12), `${label} SELL proceeds, balance and P/L match the independent calculation (${proceeds.toFixed(4)} SOL, ${t.pnlPct.toFixed(2)}%)`);
  check(t.frozen && t.emittedAfterSell === 0, `${label} replay freezes immediately after SELL (clock, ticks and wallet events stop; further BUY/SELL ignored)`);
  const prefixOk = t.seqPrefix === a.log.split(',').filter((x) => x.startsWith('T') || x.startsWith('E:')).slice(0, t.seqPrefix.split(',').length).join(',');
  check(prefixOk, `${label} trading does not disturb the timeline (ticks and events before the sell are the untouched replay sequence)`);

  const again = tradeRun(base, () => 40, sc.buyAt, sc.sellAt);
  const viaReset = tradeRun(base, () => 40, sc.buyAt, sc.sellAt, true);
  check(sameTrade(t, again) && sameTrade(t, viaReset), `${label} replaying the same sequence (fresh run and reset) gives the same trade result`);
  let seed2 = 777;
  const rnd2 = () => ((seed2 = (seed2 * 1664525 + 1013904223) >>> 0) / 4294967296);
  const uneven = tradeRun(base, () => 3 + rnd2() * 1400, sc.buyAt, sc.sellAt);
  const fast = tradeRun(base * 2, () => 90, sc.buyAt, sc.sellAt);
  const faster = tradeRun(base * 4, () => 17 + rnd2() * 300, sc.buyAt, sc.sellAt);
  check(sameTrade(t, uneven) && sameTrade(t, fast) && sameTrade(t, faster), `${label} uneven frame timing and 2x/4x playback do not change the trade result`);
}

// Presentation messages carry facts, never new numbers: the SELL message's P/L is the recorded one.
{
  const sellMsgs: (number | undefined)[] = [];
  const e0 = new ReplayEngine(replay, (m: HostMessage) => { if (m.type === 'SELL') sellMsgs.push(m.pnlPct); }, () => 0);
  e0.start();
  e0.advanceForTest(2000);
  e0.buy();
  e0.advanceForTest(4000);
  e0.sell();
  const rec = e0.getSnapshot().player.realizedPnlPct;
  check(sellMsgs.length === 1 && sellMsgs[0] === (rec ?? undefined), 'game feel: the SELL message carries exactly the recorded realised P/L (presentation only, accounting untouched)');
  e0.dispose();
}

// A BUY cannot happen twice, and a SELL needs a holding.
{
  const e = new ReplayEngine(replay, () => {}, () => 0);
  e.start();
  e.sell();
  check(e.getSnapshot().player.exited === false && e.getSnapshot().player.paperSol === STARTING_PAPER_SOL, 'SELL with nothing held does nothing');
  e.buy();
  const once = e.getSnapshot().player.tokens;
  e.buy();
  check(e.getSnapshot().player.tokens === once, 'a second BUY does nothing');
  e.dispose();
}

// Easy/Hard wallet behaviour is untouched by trading: the scene still gets tags in easy, none in hard.
{
  const tagsEasy = new Set<string>();
  const tagsHard = new Set<string>();
  for (const [mode, tags] of [['easy', tagsEasy], ['hard', tagsHard]] as const) {
    const e = new ReplayEngine(replay, (m: HostMessage) => { if (m.type === 'WALLET_EVENT' && m.tag) tags.add(m.tag); }, () => 0);
    e.setDifficulty(mode);
    e.start();
    e.advanceForTest(2000);
    e.buy();
    while (e.getSnapshot().phase === 'playing') e.advanceForTest(400);
    check(mode === 'hard' || e.getSnapshot().tagsVisible, `${mode}: feed tag visibility is unchanged by trading`);
    e.dispose();
  }
  check((tagsEasy.size > 0 || replay.events.length === 0) && tagsHard.size === 0, 'Easy/Hard behaviour with a trade in progress: tags in easy, none in hard');
}

// ---- post-sale replay + verdict -------------------------------------------------------------------
// Each scenario: buy at a replay timestamp, optionally sell at another, then (if sold) watch on to
// the end. Everything is driven through the engine with uneven frames; the last step before each
// trade lands exactly on its target timestamp.
interface ScenarioOut {
  seq: string[];
  windows: { id: string; ts: number; prev: number; now: number }[];
  rugWindows: { prev: number; now: number }[];
  soldPlayer: string;
  finalPlayer: string;
  sellClock: number;
  resumeClock: number;
  finalClock: number;
  finalPhase: string;
  verdictAtSell: string;
  finalVerdict: string;
  frozenBeforeWatch: boolean;
  tradeLockedWhileWatching: boolean;
  seqAtSell: number;
}

function scenario(speed: number, chunkMs: () => number, buyAt: number, sellAt: number | null): ScenarioOut {
  const seq: string[] = [];
  const windows: ScenarioOut['windows'] = [];
  const rugWindows: ScenarioOut['rugWindows'] = [];
  let prevClock = -Infinity;
  let nowClock = first;
  const engine = new ReplayEngine(
    replay,
    (m: HostMessage) => {
      if (m.type === 'PRICE_TICK') seq.push(`T${m.index}`);
      else if (m.type === 'SHOW_RUG') { seq.push('RUG'); rugWindows.push({ prev: prevClock, now: nowClock }); }
      else if (m.type === 'WALLET_EVENT') {
        seq.push(`E:${m.id}`);
        windows.push({ id: m.id, ts: replay.events.find((e) => e.id === m.id)!.timestamp, prev: prevClock, now: nowClock });
      }
    },
    () => 0,
  );
  engine.setSpeed(speed);
  engine.start();
  const step = (dt: number) => {
    prevClock = engine.getSnapshot().clock.timestamp;
    nowClock = prevClock + (dt / 1000) * speed;
    engine.advanceForTest(dt);
  };
  const advanceTo = (target: number) => {
    for (;;) {
      const remainMs = ((target - engine.getSnapshot().clock.timestamp) / speed) * 1000;
      if (remainMs <= 0) break;
      const dt = chunkMs();
      step(Math.min(dt, remainMs));
      if (dt >= remainMs) break;
    }
  };
  advanceTo(buyAt);
  engine.buy();

  let soldPlayer = '';
  let sellClock = NaN;
  let resumeClock = NaN;
  let verdictAtSell = 'null';
  let frozenBeforeWatch = true;
  let tradeLockedWhileWatching = true;
  let seqAtSell = -1;
  if (sellAt !== null) {
    advanceTo(sellAt);
    engine.sell();
    const sold = engine.getSnapshot();
    soldPlayer = JSON.stringify(sold.player);
    sellClock = sold.clock.timestamp;
    seqAtSell = seq.length;
    verdictAtSell = JSON.stringify(computeVerdict(replay, sold.player));
    frozenBeforeWatch = sold.canWatch && sold.verdict === null;
    step(60_000); // frozen: nothing may move
    frozenBeforeWatch = frozenBeforeWatch && engine.getSnapshot().clock.timestamp === sellClock && seq.length === seqAtSell;
    engine.watchWhatHappened();
    resumeClock = engine.getSnapshot().clock.timestamp;
    prevClock = resumeClock;
  }
  // run to the end; while watching, hammer BUY/SELL to prove the closed trade cannot change
  let guard = 0;
  while (engine.getSnapshot().phase !== 'finished' && guard++ < 1_000_000) {
    step(chunkMs());
    if (sellAt !== null) {
      engine.buy();
      engine.sell();
      const s = engine.getSnapshot();
      if (s.phase === 'watching' && (s.canBuy || s.canSell || JSON.stringify(s.player) !== soldPlayer)) tradeLockedWhileWatching = false;
    }
  }
  const end = engine.getSnapshot();
  engine.dispose();
  return {
    seq, windows, rugWindows, soldPlayer, finalPlayer: JSON.stringify(end.player), sellClock, resumeClock,
    finalClock: end.clock.timestamp, finalPhase: end.phase, verdictAtSell, finalVerdict: JSON.stringify(end.verdict),
    frozenBeforeWatch, tradeLockedWhileWatching, seqAtSell,
  };
}

const fullSeq = a.log.split(',').filter((x) => x.startsWith('T') || x.startsWith('E:') || x === 'RUG');
const sig = signalEvent(replay);
const rugTs = replay.rugTimestamp;
if (!sig) throw new Error('verification needs a SMART SELL in the replay');
const gapToSig = sig.timestamp - first;
const T = {
  buy: first + 0.3 * gapToSig,
  beforeSignal: first + 0.7 * gapToSig,
  justAfterSignal: sig.timestamp + 1e-6,
  betweenSignalAndCollapse: sig.timestamp + 0.5 * (rugTs - sig.timestamp),
  afterCollapse: rugTs + 0.5 * (last - rugTs),
};
const seedFor = (n: number) => { let s = n; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };

console.log(`\nfirst qualifying signal (>= $${replay.signal.minUsd.toLocaleString("en-US")}): ${sig.id} at ${new Date(sig.timestamp * 1000).toISOString()}  collapse: ${new Date(rugTs * 1000).toISOString()}`);

// The signal rule: defined by the replay, derived from its event data, re-computed independently here.
{
  const rule = replay.signal;
  const qualifying = replay.events
    .filter((e) => e.tag === rule.tag && e.action === rule.action && ((e.amountUnit === 'USD' ? e.amount : e.valueUsd) ?? 0) >= rule.minUsd)
    .sort((x, y) => x.timestamp - y.timestamp);
  check(rule.minUsd > 0 && rule.description.length > 0, `signal rule: the replay defines its own signal (${rule.tag} ${rule.action} >= $${rule.minUsd.toLocaleString('en-US')})`);
  check(qualifying.length > 0 && sig.id === qualifying[0].id && sig.timestamp === qualifying[0].timestamp, 'signal rule: the first signal is the earliest event matching the replay rule, derived from the event data');
  check(sig.timestamp > first && sig.timestamp < rugTs, 'signal rule: the signal falls inside the replay and before the collapse, so Clean and Late are both possible');
  check(replay.collapseReason.length > 0 && replay.ticks.some((t) => t.timestamp === rugTs), 'collapse: documented in the replay metadata and on a real tick timestamp');
  if (replay.id.startsWith('libra')) {
    check(
      sig.timestamp === Date.parse('2025-02-14T22:44:22Z') / 1000 && sig.wallet === '7qN...ao7' && sig.amount === 562577,
      'LIBRA: the signal resolves to 22:44:22 UTC, 7qN...ao7, $562,577 (a smaller, earlier FS5...rcy sell of $487,583 no longer counts)',
    );
    const earlierSmaller = replay.events.filter((e) => e.tag === 'SMART' && e.action === 'SELL' && e.timestamp < sig.timestamp);
    check(earlierSmaller.length === 2 && earlierSmaller.every((e) => (e.amount ?? 0) < replay.signal.minUsd), 'LIBRA: the two earlier SMART SELLs are below the threshold, so they are hints, not the boundary');
  }
}

// post-sale replay (sell between the signal and the collapse so ticks, events AND the rug remain)
{
  const r = scenario(base, () => 40, T.buy, T.betweenSignalAndCollapse);
  check(r.frozenBeforeWatch, 'post-sale: after SELL the replay is frozen and WATCH is offered (no verdict yet)');
  check(near(r.resumeClock, r.sellClock, 1e-12), 'post-sale: WATCH WHAT HAPPENED resumes from the exact sell timestamp');
  check(r.seq.join(',') === fullSeq.join(','), 'post-sale: pre-sell + post-sale ticks, wallet events and rug marker equal the uninterrupted replay sequence, in order');
  check(r.windows.every((w) => w.ts <= w.now + 1e-6 && (w.prev === -Infinity || w.ts > w.prev - 1e-6)), 'post-sale: every wallet event fires at its correct historical timestamp');
  check(r.rugWindows.length === 1 && r.rugWindows[0].now >= rugTs - 1e-6 && r.rugWindows[0].prev < rugTs + 1e-6, 'post-sale: the collapse still fires once, at the same historical point');
  check(r.soldPlayer === r.finalPlayer && r.tradeLockedWhileWatching, 'post-sale: the closed trade (price, timestamp, P/L, balance) cannot change while watching');
  check(r.finalPhase === 'finished' && r.finalClock === last, 'post-sale: the replay runs on to the final historical timestamp');
  const outs = [
    scenario(base, () => 40, T.buy, T.betweenSignalAndCollapse),
    scenario(base, seedFor(5), T.buy, T.betweenSignalAndCollapse),
    scenario(base * 2, () => 90, T.buy, T.betweenSignalAndCollapse),
    scenario(base * 4, seedFor(9), T.buy, T.betweenSignalAndCollapse),
  ];
  check(outs.every((o) => o.seq.join(',') === r.seq.join(',') && o.finalPlayer === r.finalPlayer && o.finalPhase === 'finished' && near(o.finalClock, r.finalClock, 1e-9) && o.finalVerdict === r.finalVerdict), 'post-sale: completion is deterministic across restart, uneven frames, 2x and 4x');
}

// verdict rules, edge cases on the pure function (exact ties cannot be hit reliably through a float clock)
{
  const mk = (sellTs: number | null) => {
    const bp = replay.ticks[tickIndexAt(replay, T.buy)];
    let p = applyBuy(newPlayer(), { timestamp: T.buy, tickIndex: tickIndexAt(replay, T.buy), price: bp.price }, replay.paperSolUsd);
    if (sellTs !== null) {
      const i = tickIndexAt(replay, sellTs);
      p = applySell(p, { timestamp: sellTs, tickIndex: i, price: replay.ticks[i].price }, replay.paperSolUsd);
    }
    return computeVerdict(replay, p)!.verdict;
  };
  check(mk(sig.timestamp - 1e-6) === 'CLEAN_EXIT', 'verdict: exit just before the first SMART SELL -> CLEAN EXIT');
  check(mk(sig.timestamp) === 'LATE_EXIT', 'verdict: exit at exactly the first SMART SELL timestamp -> LATE EXIT (tie goes to LATE)');
  check(mk(rugTs - 1e-6) === 'LATE_EXIT', 'verdict: exit just before the collapse -> LATE EXIT');
  check(mk(rugTs) === 'RUGGED', 'verdict: exit at exactly the collapse timestamp -> RUGGED');
  check(mk(null) === 'RUGGED', 'verdict: never sold -> RUGGED');
  check(computeVerdict(replay, newPlayer()) === null, 'verdict: a player who never bought has no verdict (nothing to judge)');
}

// verdict through the engine on the real LIBRA events
{
  const cases: { name: string; sellAt: number | null; expect: string }[] = [
    { name: 'exit before the first SMART SELL', sellAt: T.beforeSignal, expect: 'CLEAN_EXIT' },
    { name: 'exit just after the first SMART SELL', sellAt: T.justAfterSignal, expect: 'LATE_EXIT' },
    { name: 'exit between the SMART SELL and the collapse', sellAt: T.betweenSignalAndCollapse, expect: 'LATE_EXIT' },
    { name: 'exit after the collapse', sellAt: T.afterCollapse, expect: 'RUGGED' },
    { name: 'never exits', sellAt: null, expect: 'RUGGED' },
  ];
  for (const c of cases) {
    const runs = [
      scenario(base, () => 40, T.buy, c.sellAt),
      scenario(base, seedFor(21), T.buy, c.sellAt),
      scenario(base * 2, () => 90, T.buy, c.sellAt),
      scenario(base * 4, seedFor(33), T.buy, c.sellAt),
    ];
    const v = JSON.parse(runs[0].finalVerdict);
    check(v && v.verdict === c.expect && runs.every((r) => r.finalVerdict === runs[0].finalVerdict), `verdict [${c.name}] -> ${c.expect}, identical with uneven frames and at 2x/4x`);
    if (c.sellAt !== null) {
      check(runs.every((r) => r.verdictAtSell === r.finalVerdict && r.soldPlayer === r.finalPlayer), `verdict [${c.name}] is fixed by the original exit timestamp; P/L unchanged through the post-sale replay`);
      check(v.exitTimestamp !== null && near(v.exitTimestamp, c.sellAt, 1e-6), `verdict [${c.name}] reports the real exit timestamp`);
    } else {
      check(v.exitTimestamp === null && v.exitPrice === null && v.heldThroughCollapse === true && v.collapsePrice === replay.ticks[replay.ticks.findIndex((t) => t.timestamp >= rugTs)].price, `verdict [${c.name}] invents no sell: no exit time/price, collapse price shown`);
    }
  }
}

// ---- the Historical Reveal ---------------------------------------------------------------------------
// Play a run to its verdict, start the Reveal, and record everything the scene is told.
interface RevealOut {
  seq: string[];
  windows: { label: string; ts: number; prev: number; now: number; idx?: number }[];
  signalIds: string[];
  tagsInReveal: (string | null)[];
  playerBefore: string;
  playerAfter: string;
  verdictBefore: string;
  verdictAfter: string;
  phaseEnd: string;
  summary: string;
  ignoredTrades: boolean;
  eventIds: string[];
}

function revealRun(speed: number, chunkMs: () => number, buyAt: number | null, sellAt: number | null, mode: 'easy' | 'hard' = 'easy', viaReset = false): RevealOut {
  let phaseLog: 'play' | 'reveal' = 'play';
  const seq: string[] = [];
  const windows: RevealOut['windows'] = [];
  const signalIds: string[] = [];
  const tagsInReveal: (string | null)[] = [];
  const eventIds: string[] = [];
  let prevClock = -Infinity;
  let nowClock = first;
  const engine = new ReplayEngine(
    replay,
    (m: HostMessage) => {
      if (phaseLog !== 'reveal') return;
      const w = (label: string, ts: number, idx?: number) => windows.push({ label, ts, prev: prevClock, now: nowClock, idx });
      if (m.type === 'PRICE_TICK') seq.push(`T${m.index}`);
      else if (m.type === 'SHOW_RUG') { seq.push('RUG'); w('RUG', rugTs); }
      else if (m.type === 'WALLET_EVENT') {
        const ev = replay.events.find((e) => e.id === m.id)!;
        seq.push(`E:${m.id}`); eventIds.push(m.id); tagsInReveal.push(m.tag);
        if (m.signal) signalIds.push(m.id);
        w(`E:${m.id}`, ev.timestamp);
      } else if (m.type === 'BUY') { seq.push('BUY'); w('BUY', NaN, m.index); }
      else if (m.type === 'SELL') { seq.push('SELL'); w('SELL', NaN, m.index); }
      else if (m.type === 'MARK') { seq.push(`MARK:${m.kind}`); w(`MARK:${m.kind}`, rugTs); }
    },
    () => 0,
  );
  engine.setSpeed(speed);
  engine.setDifficulty(mode);
  const step = (dt: number) => {
    prevClock = engine.getSnapshot().clock.timestamp;
    nowClock = prevClock + (dt / 1000) * speed;
    engine.advanceForTest(dt);
  };
  const advanceTo = (target: number) => {
    for (;;) {
      const remainMs = ((target - engine.getSnapshot().clock.timestamp) / speed) * 1000;
      if (remainMs <= 0) break;
      const dt = chunkMs();
      step(Math.min(dt, remainMs));
      if (dt >= remainMs) break;
    }
  };
  const playToVerdict = () => {
    engine.start();
    if (buyAt !== null) { advanceTo(buyAt); engine.buy(); }
    if (buyAt !== null && sellAt !== null) { advanceTo(sellAt); engine.sell(); engine.watchWhatHappened(); }
    let g = 0;
    while (engine.getSnapshot().phase !== 'finished' && g++ < 1_000_000) step(chunkMs());
  };
  playToVerdict();
  if (viaReset) {
    // a full restart, same trades, must reproduce the same reveal
    playToVerdict();
  }
  const before = engine.getSnapshot();
  const playerBefore = JSON.stringify(before.player);
  const verdictBefore = JSON.stringify(before.verdict);
  phaseLog = 'reveal';
  prevClock = -Infinity;
  nowClock = first;
  engine.startReveal();
  let ignoredTrades = engine.getSnapshot().phase === 'revealing';
  let g = 0;
  while (engine.getSnapshot().phase === 'revealing' && g++ < 1_000_000) {
    step(chunkMs());
    engine.buy();
    engine.sell();
    const s = engine.getSnapshot();
    if (s.phase === 'revealing' && (s.canBuy || s.canSell || JSON.stringify(s.player) !== playerBefore)) ignoredTrades = false;
  }
  const end = engine.getSnapshot();
  engine.dispose();
  return {
    seq, windows, signalIds, tagsInReveal, playerBefore, playerAfter: JSON.stringify(end.player), verdictBefore,
    verdictAfter: JSON.stringify(end.verdict), phaseEnd: end.phase, summary: JSON.stringify(end.reveal), ignoredTrades, eventIds,
  };
}

const revealScenarios = [
  { name: 'late exit', buyAt: T.buy, sellAt: T.betweenSignalAndCollapse as number | null },
  { name: 'clean exit', buyAt: T.buy, sellAt: T.beforeSignal as number | null },
  { name: 'held through the collapse', buyAt: T.buy as number | null, sellAt: null as number | null },
  { name: 'never traded', buyAt: null as number | null, sellAt: null as number | null },
];

for (const sc of revealScenarios) {
  const label = `[reveal: ${sc.name}]`;
  const r = revealRun(base, () => 40, sc.buyAt, sc.sellAt);
  const pj = JSON.parse(r.playerBefore);

  // 1. chronological, and equal to an independently sorted timeline (ticks, then events, then markers on ties)
  const markers: { ts: number; label: string }[] = [];
  if (pj.buyTimestamp !== null) markers.push({ ts: pj.buyTimestamp, label: 'BUY' });
  if (pj.exited) markers.push({ ts: pj.sellTimestamp, label: 'SELL' });
  if (pj.buyTimestamp !== null && !pj.exited) markers.push({ ts: rugTs, label: 'MARK:HELD' });
  markers.push({ ts: rugTs, label: 'MARK:COLLAPSE' });
  const rugIdx = replay.ticks.findIndex((t) => t.timestamp >= rugTs);
  const expectedSeq: string[] = [];
  {
    const items = [
      ...replay.ticks.map((t, i) => ({ ts: t.timestamp, k: 0, i, label: `T${i}` })),
      ...replay.events.map((e, i) => ({ ts: e.timestamp, k: 1, i, label: `E:${e.id}` })),
      ...markers.map((m, i) => ({ ts: m.ts, k: 2, i, label: m.label })),
    ].sort((a2, b2) => a2.ts - b2.ts || a2.k - b2.k || a2.i - b2.i);
    for (const it of items) { expectedSeq.push(it.label); if (it.label === `T${rugIdx}`) expectedSeq.push('RUG'); }
  }
  check(r.seq.join(',') === expectedSeq.join(','), `${label} everything appears in chronological timestamp order and equals the independently sorted timeline`);
  const evTs = r.windows.filter((w) => w.label.startsWith('E:')).map((w) => w.ts);
  check(evTs.every((t, i) => i === 0 || t >= evTs[i - 1]), `${label} reveal wallet events are in non-decreasing timestamp order`);
  check(r.windows.filter((w) => w.label.startsWith('E:')).every((w) => w.ts <= w.now + 1e-6 && w.ts > w.prev - 1e-6), `${label} every wallet event appears when its real timestamp is reached (never early)`);

  // 2. the reveal's signal is the verdict's signal (read from the data, not hardcoded)
  check(r.signalIds.length === 1 && r.signalIds[0] === sig.id, `${label} exactly one event is flagged as the signal and it is the verdict's first qualifying SMART SELL`);
  const v = JSON.parse(r.verdictBefore);
  if (v) check(v.signalEventId === r.signalIds[0], `${label} the reveal signal equals the verdict signal`);

  // 3/4. player markers use the real timestamps (and their own ticks)
  if (pj.buyTimestamp !== null) {
    const w = r.windows.find((x) => x.label === 'BUY')!;
    check(w !== undefined && w.idx === pj.buyTickIndex && pj.buyTimestamp <= w.now + 1e-6 && pj.buyTimestamp > w.prev - 1e-6, `${label} the YOU BOUGHT marker is placed at the actual entry timestamp and tick`);
  } else check(!r.seq.includes('BUY'), `${label} no entry marker when the player never bought`);
  if (pj.exited) {
    const w = r.windows.find((x) => x.label === 'SELL')!;
    check(w !== undefined && w.idx === pj.sellTickIndex && pj.sellTimestamp <= w.now + 1e-6 && pj.sellTimestamp > w.prev - 1e-6, `${label} the YOU SOLD marker is placed at the original exit timestamp and tick`);
  } else check(!r.seq.includes('SELL'), `${label} no exit marker when the player never sold${pj.buyTimestamp !== null ? '; they are marked as still in at the collapse' : ''}`);
  if (pj.buyTimestamp !== null && !pj.exited) check(r.seq.includes('MARK:HELD'), `${label} a player who held is shown as still in when the collapse hits`);

  // 5/6/7. explanatory only
  check(r.playerBefore === r.playerAfter && r.ignoredTrades, `${label} the reveal does not alter P/L or paper SOL (BUY/SELL are locked)`);
  check(r.verdictBefore === r.verdictAfter, `${label} the reveal does not change the verdict`);
  check(r.eventIds.length === replay.events.length && new Set(r.eventIds).size === replay.events.length && r.eventIds.every((id) => replay.events.some((e) => e.id === id)), `${label} the reveal creates no new wallet events (each real event appears exactly once)`);

  // 11. collapse at the existing timestamp, once
  const rugW = r.windows.filter((w) => w.label === 'RUG');
  const collapseW = r.windows.filter((w) => w.label === 'MARK:COLLAPSE');
  check(rugW.length === 1 && collapseW.length === 1 && rugW[0].now >= rugTs - 1e-6 && rugW[0].prev < rugTs + 1e-6 && collapseW[0].now >= rugTs - 1e-6 && collapseW[0].prev < rugTs + 1e-6, `${label} the collapse (existing rug behaviour + marker) happens once at the existing collapse timestamp`);

  // the end-of-reveal summary
  const sm = JSON.parse(r.summary);
  check(
    r.phaseEnd === 'revealed' && sm.collapse.timestamp === rugTs && (sm.signal?.eventId ?? null) === sig.id &&
      (pj.exited ? sm.exit.timestamp === pj.sellTimestamp && sm.exit.price === pj.sellPrice : sm.exit === null) &&
      (pj.buyTimestamp !== null ? sm.entry.timestamp === pj.buyTimestamp : sm.entry === null),
    `${label} the end summary reports the real exit, the verdict signal and the collapse`,
  );
}

// 8/9/10: determinism of the reveal (late-exit and held scenarios)
for (const sc of [revealScenarios[0], revealScenarios[2]]) {
  const label = `[reveal: ${sc.name}]`;
  const r0 = revealRun(base, () => 40, sc.buyAt, sc.sellAt);
  const same = (o: RevealOut) => o.seq.join(',') === r0.seq.join(',') && o.summary === r0.summary && o.playerAfter === r0.playerAfter && o.verdictAfter === r0.verdictAfter;
  const again = revealRun(base, () => 40, sc.buyAt, sc.sellAt);
  const viaReset = revealRun(base, () => 40, sc.buyAt, sc.sellAt, 'easy', true);
  check(same(again) && same(viaReset), `${label} the reveal is deterministic after reset (fresh run and full restart give the identical sequence)`);
  check(same(revealRun(base, seedFor(71), sc.buyAt, sc.sellAt)), `${label} uneven frame timing produces the same reveal sequence`);
  check(same(revealRun(base * 2, () => 90, sc.buyAt, sc.sellAt)) && same(revealRun(base * 4, seedFor(83), sc.buyAt, sc.sellAt)), `${label} 2x and 4x playback produce the same historical reveal sequence`);
}

// hard mode: tags stay hidden during play, and the reveal is where they appear
{
  const rh = revealRun(base, () => 40, T.buy, T.betweenSignalAndCollapse, 'hard');
  const tagged = replay.events.filter((e) => e.tag !== undefined).length;
  check(rh.tagsInReveal.filter((t) => t !== null).length === tagged, 'hard mode: the reveal shows every tag (it is the reveal)');
}

process.exit(failed ? 1 : 0);
