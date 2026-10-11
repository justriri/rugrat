// Catalogue-wide verification. Run with `npm run verify:replay`.
//  1. every registered replay loads with real metadata, valid ticks/events, a valid collapse and a
//     valid data-driven signal;
//  2. each catalogue rug type is shown by its data (fast dump / slow bleed / dev exit);
//  3. the complete per-replay suite (scripts/verify-replay.ts) runs against EVERY replay.
import { execFileSync } from 'node:child_process';

import { demoReplay, REPLAYS } from '../src/data/replays';
import { signalEvent } from '../src/game/verdict';
import type { Replay } from '../src/game/types';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GENERIC_NAME = /^(fast dump|slow bleed|dev exit)( #?\d+)?$/i;

/** How the price actually moved: peak, collapse, how long the fall took, how big the worst step was. */
function shape(r: Replay) {
  const peakIdx = r.ticks.reduce((m, t, i) => (t.price > r.ticks[m].price ? i : m), 0);
  const peak = r.ticks[peakIdx];
  const rugIdx = r.ticks.findIndex((t) => t.timestamp === r.rugTimestamp);
  let worstStep = 0;
  // worst single-step fall AFTER the peak (a launch pump can be violent without being the collapse)
  for (let i = peakIdx + 1; i < r.ticks.length; i++) worstStep = Math.max(worstStep, 1 - r.ticks[i].price / r.ticks[i - 1].price);
  return {
    peak,
    peakToCollapseSec: r.rugTimestamp - peak.timestamp,
    collapsePriceOfPeak: r.ticks[rugIdx].price / peak.price,
    worstStepDrop: worstStep,
    low: Math.min(...r.ticks.map((t) => t.price)) / peak.price,
  };
}

console.log(`catalogue: ${REPLAYS.length} replays -> ${REPLAYS.map((r) => `${r.symbol}(${r.rugType})`).join(', ')}\n`);
check(REPLAYS.length === 4, 'the catalogue holds exactly four replays: LIBRA plus three new rugs');
check(new Set(REPLAYS.map((r) => r.id)).size === REPLAYS.length && new Set(REPLAYS.map((r) => r.mint)).size === REPLAYS.length, 'replay ids and mints are unique');

for (const r of REPLAYS) {
  const tag = `[${r.symbol}]`;
  check(r.name.length > 0 && !GENERIC_NAME.test(r.name) && r.name.toLowerCase() !== r.rugType.toLowerCase().replace('_', ' '), `${tag} has its real token name ("${r.name}"), not a generic rug label`);
  check(r.symbol.length > 0 && r.token === r.symbol, `${tag} has its symbol (${r.symbol})`);
  check(BASE58.test(r.mint), `${tag} has a real mint address (${r.mint.slice(0, 6)}...${r.mint.slice(-4)})`);
  check(r.logoUrl === null ? r.logoSource === null : /^https?:\/\//.test(r.logoUrl) && !!r.logoSource, `${tag} logo: ${r.logoUrl ? 'a real URL with its source recorded' : 'none available, the UI falls back to a letter badge'}`);
  check(r.ticks.every((t, i) => i === 0 || t.timestamp > r.ticks[i - 1].timestamp) && r.ticks.every((t) => t.price > 0 && Number.isFinite(t.price)), `${tag} has ${r.ticks.length} valid, strictly chronological ticks`);
  check(r.events.every((e, i) => i === 0 || e.timestamp >= r.events[i - 1].timestamp) && r.events.every((e) => e.timestamp >= r.replayStart && e.timestamp <= r.replayEnd) && new Set(r.events.map((e) => e.id)).size === r.events.length, `${tag} has ${r.events.length} valid chronological events inside the window, no duplicates`);
  const sh = shape(r);
  check(r.rugTimestamp > r.replayStart && r.rugTimestamp < r.replayEnd && sh.collapsePriceOfPeak <= 0.55 && r.collapseReason.length > 20, `${tag} has a valid, documented collapse (${new Date(r.rugTimestamp * 1000).toISOString()}, price ${(sh.collapsePriceOfPeak * 100).toFixed(0)}% of peak)`);
  const sig = signalEvent(r);
  check(!!sig && sig.timestamp > r.replayStart && sig.timestamp < r.rugTimestamp && r.signal.description.length > 20, `${tag} has a valid data-driven verdict signal (${r.signal.tag} ${r.signal.action} >= $${r.signal.minUsd.toLocaleString('en-US')}${sig ? ` -> ${sig.wallet} at ${new Date(sig.timestamp * 1000).toISOString().slice(11, 19)}` : ''})`);
  check(r.paperSolUsd > 0 && r.playbackSpeed > 0 && r.replayStart === r.ticks[0].timestamp && r.replayEnd === r.ticks[r.ticks.length - 1].timestamp, `${tag} replay window and paper-SOL conversion are valid`);
}

// the three catalogue rug types must actually look different in their data
const byType = (t: Replay['rugType']) => REPLAYS.filter((r) => r.rugType === t);
for (const t of ['FAST_DUMP', 'SLOW_BLEED', 'DEV_EXIT'] as const) check(byType(t).length === 1, `exactly one catalogue replay is a ${t.replace('_', ' ')}`);
for (const r of byType('FAST_DUMP')) {
  const sh = shape(r);
  check(sh.peakToCollapseSec <= 3600, `[${r.symbol}] FAST DUMP: the price halves within an hour of the peak (${(sh.peakToCollapseSec / 60).toFixed(0)} min)`);
}
for (const r of byType('SLOW_BLEED')) {
  const sh = shape(r);
  check(sh.peakToCollapseSec >= 3 * 3600 && sh.worstStepDrop <= 0.4, `[${r.symbol}] SLOW BLEED: it takes ${(sh.peakToCollapseSec / 3600).toFixed(1)} h to halve and no single step falls more than ${(sh.worstStepDrop * 100).toFixed(0)}%`);
}
for (const r of byType('DEV_EXIT')) {
  const devBefore = r.events.filter((e) => (e.tag === 'DEV' || e.tag === 'LIQUIDITY') && e.timestamp < r.rugTimestamp);
  check(devBefore.length >= 3 && (r.signal.tag === 'DEV' || r.signal.tag === 'LIQUIDITY'), `[${r.symbol}] DEV EXIT: creator/liquidity activity is a meaningful part of the timeline (${devBefore.length} events before the collapse) and the verdict signal is dev-driven`);
}

// the complete suite against every replay (and the synthetic demo)
console.log('');
for (const r of [...REPLAYS, demoReplay]) {
  let out = '';
  try {
    out = execFileSync('node', ['scripts/.verify.cjs'], { env: { ...process.env, REPLAY: r.id === demoReplay.id ? 'demo' : r.id }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
    console.log(`suite for ${r.id} exited non-zero`);
  }
  const p = out.split('\n').filter((l) => l.startsWith('PASS')).length;
  const f = out.split('\n').filter((l) => l.startsWith('FAIL')).length;
  for (const l of out.split('\n')) if (l.startsWith('FAIL')) console.log(`  [${r.symbol}] ${l}`);
  console.log(`SUITE ${r.symbol.padEnd(8)} ${r.id.padEnd(22)} PASS ${p}  FAIL ${f}`);
  pass += p;
  fail += f + (p === 0 ? 1 : 0);
}

// the flow suites that are not per-replay: rug selection + competition, onchain score + badge
for (const [label, file] of [['selection+competition', 'scripts/.verify-competition.cjs'], ['onchain score + badge', 'scripts/.verify-onchain.cjs'], ['SKR holder perks', 'scripts/.verify-skr.cjs'], ['SKR upgrades + prize pool', 'scripts/.verify-upgrade.cjs'], ['menu + world selection', 'scripts/.verify-menu.cjs'], ['submission fixes', 'scripts/.verify-submission.cjs'], ['mainnet safety', 'scripts/.verify-mainnet.cjs']] as const) {
  let out = '';
  try {
    out = execFileSync('node', [file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
    console.log(`${label} suite exited non-zero`);
  }
  const p = out.split('\n').filter((l) => l.startsWith('PASS')).length;
  const f = out.split('\n').filter((l) => l.startsWith('FAIL')).length;
  for (const l of out.split('\n')) if (l.startsWith('FAIL')) console.log(`  ${l}`);
  console.log(`SUITE ${label.padEnd(30)} PASS ${p}  FAIL ${f}`);
  pass += p;
  fail += f + (p === 0 ? 1 : 0);
}

console.log(`\nTOTAL PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
