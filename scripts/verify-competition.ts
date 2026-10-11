// Rug selection flow + Friends/Competition layer verification. Part of `npm run verify:replay`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HostMessage } from '../src/bridge/protocol';
import { INITIAL_SCREEN, navReducer, replayForScreen, Screen } from '../src/app/nav';
import { compareOnRug } from '../src/competition/compare';
import { DEMO_PLAYERS } from '../src/competition/demo';
import { buildLeaderboard } from '../src/competition/leaderboard';
import { buildRunResult, LOCAL_PLAYER_ID, RunResult } from '../src/competition/result';
import { SCORE_WEIGHTS, scoreRun } from '../src/competition/score';
import { addRunIfNew, bestPerRug, computeStats, PlayerRecord } from '../src/competition/stats';
import { getReplay, REPLAYS } from '../src/data/replays';
import { ReplayEngine } from '../src/game/ReplayEngine';
import { applyBuy, applySell, newPlayer, STARTING_PAPER_SOL } from '../src/game/player';
import { tickIndexAt } from '../src/game/timeline';
import type { Replay } from '../src/game/types';
import { computeVerdict, signalEvent } from '../src/game/verdict';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

// ---------- helpers: drive a REAL engine through a whole run ----------
type Plan = { buyAt: number; sellAt: number | null; watch?: boolean; reveal?: boolean };
function playRun(replay: Replay, plan: Plan, speed: number, chunk: () => number, solUsd = replay.paperSolUsd) {
  const seen: HostMessage[] = [];
  const engine = new ReplayEngine(replay, (m) => seen.push(m), () => 0);
  engine.setSpeed(speed);
  engine.start();
  const advanceTo = (target: number) => {
    for (let guard = 0; guard < 5_000_000; guard++) {
      const remainMs = ((target - engine.getSnapshot().clock.timestamp) / speed) * 1000;
      if (remainMs <= 0) return;
      const dt = chunk();
      engine.advanceForTest(Math.min(dt, remainMs));
      if (dt >= remainMs) return;
    }
  };
  advanceTo(plan.buyAt);
  engine.buy();
  if (plan.sellAt !== null) {
    advanceTo(plan.sellAt);
    engine.sell();
    if (plan.watch !== false) engine.watchWhatHappened();
  }
  for (let g = 0; engine.getSnapshot().phase !== 'finished' && g < 5_000_000; g++) engine.advanceForTest(chunk());
  if (plan.reveal) {
    engine.startReveal();
    for (let g = 0; engine.getSnapshot().phase !== 'revealed' && g < 5_000_000; g++) engine.advanceForTest(chunk());
  }
  const snap = engine.getSnapshot();
  engine.dispose();
  void solUsd;
  return { snap, seen, result: buildRunResult(replay, snap.player, LOCAL_PLAYER_ID) };
}

/** Plans in fractions of THIS replay's own timeline (no rug-specific numbers). */
function plans(r: Replay): Record<'CLEAN' | 'LATE' | 'RUGGED', Plan> {
  const sig = signalEvent(r)!;
  const buyAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.2;
  return {
    CLEAN: { buyAt, sellAt: r.replayStart + (sig.timestamp - r.replayStart) * 0.6 },
    LATE: { buyAt, sellAt: sig.timestamp + (r.rugTimestamp - sig.timestamp) * 0.3 },
    RUGGED: { buyAt, sellAt: null },
  };
}
const tickTs = (r: Replay, ts: number) => r.ticks[Math.max(0, tickIndexAt(r, ts))].timestamp;
const snapTo = (r: Replay, p: Plan): Plan => ({ ...p, buyAt: tickTs(r, p.buyAt), sellAt: p.sellAt === null ? null : tickTs(r, p.sellAt) });

// ---------- 1. rug selection ----------
console.log('\n== rug selection ==');
check(REPLAYS.length === 4, 'all four rugs are in the catalogue');
check(['LIBRA', 'BARRON', 'MELANIA', 'HAWK'].every((s) => REPLAYS.some((r) => r.symbol === s)), 'the catalogue is $LIBRA, $BARRON, $MELANIA, $HAWK');
check(INITIAL_SCREEN.name === 'home' && replayForScreen(INITIAL_SCREEN) === null, 'launch does not start any rug (no auto-LIBRA)');
let s: Screen = navReducer(INITIAL_SCREEN, { type: 'OPEN_RUGS' });
check(s.name === 'rugs' && replayForScreen(s) === null, 'PLAY opens the selection screen without starting a replay');
check(navReducer(s, { type: 'BACK' }).name === 'home', 'back from the selection screen returns home without starting');
s = navReducer(s, { type: 'START_RUG', replayId: 'nope' });
check(s.name === 'rugs', 'an unknown rug id starts nothing and does not fall back to another rug');

for (const r of REPLAYS) {
  const tag = `[${r.symbol}]`;
  let sc: Screen = navReducer(navReducer(INITIAL_SCREEN, { type: 'OPEN_RUGS' }), { type: 'START_RUG', replayId: r.id });
  check(sc.name === 'play' && replayForScreen(sc) === r && getReplay(r.id) === r, `${tag} selecting it loads that exact replay object from the registry`);
  const p = snapTo(r, plans(r).CLEAN);
  const run = playRun(r, p, r.playbackSpeed, () => 100, r.paperSolUsd);
  const startMsg = run.seen.find((m) => m.type === 'START_REPLAY');
  check(run.snap.replayId === r.id, `${tag} the engine's snapshot is for the selected replay`);
  check(!!startMsg && startMsg.type === 'START_REPLAY' && JSON.stringify(startMsg.terrain).length > 100, `${tag} the scene terrain was built from the selected replay`);
  const events = run.seen.filter((m) => m.type === 'WALLET_EVENT').map((m) => (m as { id: string }).id);
  check(events.length > 0 && events.every((id) => r.events.some((e) => e.id === id)), `${tag} every wallet event shown belongs to the selected replay`);
  check(run.snap.verdict?.rugId === r.id && run.snap.verdict.collapseTimestamp === r.rugTimestamp, `${tag} the verdict is computed against the selected replay (rug id + collapse)`);
  check(run.result?.rugId === r.id && run.result.rugSymbol === r.symbol, `${tag} the run result carries the selected rug id`);
  const rev = playRun(r, { ...p, reveal: true }, r.playbackSpeed, () => 100);
  check(rev.snap.reveal?.rugId === r.id && rev.snap.replayId === r.id, `${tag} the Reveal uses the selected replay`);
  sc = navReducer(sc, { type: 'FINISH_RUN' });
  check(sc.name === 'rugs', `${tag} after the run the player returns to selection, not to a default rug`);
  check(REPLAYS.length === 4 && getReplay(r.id) === r, `${tag} returning to selection leaves the catalogue untouched`);
}
// selection persists through a run: switching rugs gives a different run with a different id everywhere
{
  const [a, b] = [REPLAYS[0], REPLAYS[1]];
  const ra = playRun(a, snapTo(a, plans(a).CLEAN), a.playbackSpeed, () => 100);
  const rb = playRun(b, snapTo(b, plans(b).CLEAN), b.playbackSpeed, () => 100);
  check(ra.snap.replayId !== rb.snap.replayId && ra.result!.rugId !== rb.result!.rugId, 'different rugs keep different rug ids end to end');
}
// no hidden LIBRA-only assumption in the selection/start flow
{
  const root = join(__dirname, '..');
  const files = ['App.tsx', 'src/app/nav.ts', 'src/screens/RugSelectScreen.tsx', 'src/screens/GameScreen.tsx', 'src/screens/HomeScreen.tsx', 'src/competition/result.ts', 'src/competition/score.ts'];
  const offenders = files.filter((f) => /libra|activeReplay|toolingDefaultReplay/i.test(readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '')));
  check(offenders.length === 0, `the selection/start flow and competition core name no specific rug and use no default replay${offenders.length ? ' (' + offenders.join(', ') + ')' : ''}`);
}

// ---------- 2. skill score ----------
console.log('\n== skill score ==');
const base = { entryTimestamp: 1000, collapseTimestamp: 2000 };
const clean = (exit: number) => scoreRun({ ...base, verdict: 'CLEAN_EXIT', exitTimestamp: exit }).total;
const late = (exit: number) => scoreRun({ ...base, verdict: 'LATE_EXIT', exitTimestamp: exit }).total;
const rugged = scoreRun({ ...base, verdict: 'RUGGED', exitTimestamp: null }).total;
check(Math.min(clean(1000), clean(1999)) > Math.max(late(1000), late(1999)), 'CLEAN > LATE (worst clean beats best late)');
check(Math.min(late(1000), late(1999)) > rugged && rugged === 0, 'LATE > RUGGED');
check(late(1900) > late(1100), 'a later exit that still survives scores higher');
check(scoreRun({ ...base, verdict: 'RUGGED', exitTimestamp: 1500 }).total === 0, 'selling into the collapse scores nothing');
check(clean(1000) >= SCORE_WEIGHTS.survive + SCORE_WEIGHTS.clean && clean(1999) <= 1000, 'clean exits score 800..1000');

for (const r of REPLAYS) {
  const tag = `[${r.symbol}]`;
  const P = plans(r);
  const speeds = [r.playbackSpeed * 0.5, r.playbackSpeed, r.playbackSpeed * 4];
  const chunks: (() => number)[] = [() => 16, () => 100, () => 1000];
  for (const kind of ['CLEAN', 'LATE', 'RUGGED'] as const) {
    const plan = snapTo(r, P[kind]);
    const results = speeds.flatMap((sp) => chunks.map((ch) => playRun(r, plan, sp, ch).result!));
    const ref = results[0];
    check(results.every((x) => x.score === ref.score && x.runId === ref.runId && x.verdict === ref.verdict && x.exitTimestamp === ref.exitTimestamp && x.entryTimestamp === ref.entryTimestamp), `${tag} ${kind}: same run -> same result and score at every playback speed and frame size`);
    check(playRun(r, plan, speeds[1], chunks[1]).result!.score === ref.score, `${tag} ${kind}: repeating the run gives the same score`);
  }
  const rc = playRun(r, snapTo(r, P.CLEAN), r.playbackSpeed, () => 100).result!;
  const rl = playRun(r, snapTo(r, P.LATE), r.playbackSpeed, () => 100).result!;
  const rr = playRun(r, snapTo(r, P.RUGGED), r.playbackSpeed, () => 100).result!;
  check(rc.verdict === 'CLEAN_EXIT' && rl.verdict === 'LATE_EXIT' && rr.verdict === 'RUGGED', `${tag} the three plans produce CLEAN / LATE / RUGGED verdicts`);
  check(rc.score > rl.score && rl.score > rr.score, `${tag} CLEAN (${rc.score}) > LATE (${rl.score}) > RUGGED (${rr.score})`);
  check(rc.isClean && !rc.isLate && !rc.isRugged && rl.isLate && !rl.isClean && rr.isRugged && !rr.survived && rc.survived && rl.survived, `${tag} clean/late/rugged flags and survival are consistent`);
  check(rc.rugId === r.id && rc.startingPaperSol === STARTING_PAPER_SOL && rc.exitPrice !== null && rc.realizedPnlPct !== null && rc.survivalSeconds > 0 && rc.signalTimestamp === signalEvent(r)!.timestamp && rc.collapseTimestamp === r.rugTimestamp, `${tag} the RunResult is fully populated from the existing verdict/accounting`);
  check(rr.exitTimestamp === null && rr.realizedPnlPct === null, `${tag} a held-through-collapse result has no exit`);

  // money cannot change the score: same timing, different paper balance / token quantity / price scale
  const plan = snapTo(r, P.CLEAN);
  const ia = Math.max(0, tickIndexAt(r, plan.buyAt));
  const ib = Math.max(0, tickIndexAt(r, plan.sellAt!));
  const mk = (solUsd: number, startSol: number) => {
    let p = { ...newPlayer(), paperSol: startSol };
    p = applyBuy(p, { timestamp: plan.buyAt, tickIndex: ia, price: r.ticks[ia].price }, solUsd);
    p = applySell(p, { timestamp: plan.sellAt!, tickIndex: ib, price: r.ticks[ib].price }, solUsd);
    return buildRunResult(r, p, LOCAL_PLAYER_ID)!;
  };
  const m1 = mk(r.paperSolUsd, 10);
  const m2 = mk(r.paperSolUsd * 7, 1000);
  check(m1.score === m2.score && m1.verdict === m2.verdict, `${tag} the amount of SOL / token quantity does not change the score`);
  const win = r.ticks.find((t, i) => i > ia && t.price > r.ticks[ia].price * 1.5);
  void win;
}

// ---------- 3. stats ----------
console.log('\n== stats ==');
const mkRun = (over: Partial<RunResult>): RunResult => ({
  runId: 'x', playerId: 'p', rugId: 'r1', rugSymbol: 'R1', startingPaperSol: 10, survived: true, verdict: 'CLEAN_EXIT', entryTimestamp: 0, exitTimestamp: 100,
  exitPrice: 1, realizedPnlPct: 5, survivalSeconds: 100, isClean: true, isLate: false, isRugged: false, signalTimestamp: 500, collapseTimestamp: 1000, score: 900, scoreVersion: 1, ...over,
});
{
  const runs = [
    mkRun({ runId: 'a', rugId: 'r1', score: 900, survivalSeconds: 300, realizedPnlPct: 12 }),
    mkRun({ runId: 'b', rugId: 'r1', score: 600, verdict: 'LATE_EXIT', isClean: false, isLate: true, survivalSeconds: 50, realizedPnlPct: 99 }),
    mkRun({ runId: 'c', rugId: 'r2', score: 600, verdict: 'LATE_EXIT', isClean: false, isLate: true, survivalSeconds: 200, realizedPnlPct: -3 }),
    mkRun({ runId: 'd', rugId: 'r3', score: 0, survived: false, verdict: 'RUGGED', isClean: false, isRugged: true, exitTimestamp: null, realizedPnlPct: null, survivalSeconds: 10 }),
  ];
  const st = computeStats(runs);
  check(st.rugsPlayed === 3 && st.rugsSurvived === 2 && st.cleanExits === 1 && st.lateExits === 1 && st.rugsRugged === 1, 'stats count rugs played / survived / clean / late / rugged (best result per rug)');
  check(st.bestSurvivalScore === 900 && st.totalScore === 1500, 'best survival score and total score aggregate correctly');
  check(st.bestPnlPct === 99, 'best P/L % is the best realised P/L (informational)');
  check(st.fastestSuccessfulExit?.seconds === 50, 'fastest successful exit counts only runs that survived (the 10s rugged run is excluded)');
  check(bestPerRug(runs).length === 3 && computeStats(runs, 'r1').totalScore === 900, 'a rug is counted once however often it is replayed, and stats can be scoped to one rug');
  check(computeStats([]).rugsPlayed === 0 && computeStats([]).fastestSuccessfulExit === null && computeStats([]).bestPnlPct === null, 'empty stats are empty, not zero-filled records');
  check(addRunIfNew(runs, runs[0]).length === 4 && addRunIfNew(runs, mkRun({ runId: 'z' })).length === 5, 'the same run id is only recorded once');
}

// ---------- 4. leaderboard, friends ----------
console.log('\n== leaderboard and friends ==');
{
  check(DEMO_PLAYERS.length >= 3 && DEMO_PLAYERS.every((p) => p.demo && /^Demo /.test(p.name)), 'mock players are flagged demo and named "Demo ..."');
  const mine = REPLAYS.map((r) => playRun(r, snapTo(r, plans(r).LATE), r.playbackSpeed, () => 100).result!);
  const you: PlayerRecord = { playerId: LOCAL_PLAYER_ID, name: 'You', demo: false, runs: mine };
  const all = [you, ...DEMO_PLAYERS];
  const lb = buildLeaderboard(all, 'ALL');
  check(lb.every((row, i) => row.rank === i + 1 && (i === 0 || lb[i - 1].score >= row.score)), 'leaderboard is sorted by skill score, rank 1..n');
  check(lb.some((r) => r.isYou) && lb.filter((r) => r.demo).length === DEMO_PLAYERS.length, 'the leaderboard lists you and labels demo players');
  for (const r of REPLAYS) {
    const f = buildLeaderboard(all, r.id);
    check(f.length > 0 && f.every((row, i) => i === 0 || f[i - 1].score >= row.score), `[${r.symbol}] per-rug leaderboard is sorted by skill score`);
    check(all.every((p) => p.runs.filter((x) => x.rugId === r.id).every((x) => x.rugId === r.id && x.rugSymbol === r.symbol)), `[${r.symbol}] every result for this rug carries its rug id`);
  }
  // ranking ignores money: a player with a huge P/L but a worse verdict ranks lower
  const rich = { ...mkRun({ playerId: 'rich', runId: 'rich1', rugId: 'r1', score: 600, verdict: 'LATE_EXIT', isClean: false, isLate: true, realizedPnlPct: 10_000 }) };
  const poor = { ...mkRun({ playerId: 'poor', runId: 'poor1', rugId: 'r1', score: 900, realizedPnlPct: -50 }) };
  const rank = buildLeaderboard([{ playerId: 'rich', name: 'Rich', demo: true, runs: [rich] }, { playerId: 'poor', name: 'Poor', demo: true, runs: [poor] }], 'ALL');
  check(rank[0].playerId === 'poor', 'ranking is by skill, not money (+10000% late loses to -50% clean)');
  const t1 = buildLeaderboard([{ playerId: 'b', name: 'Same', demo: true, runs: [mkRun({ playerId: 'b', runId: 'b' })] }, { playerId: 'a', name: 'Same', demo: true, runs: [mkRun({ playerId: 'a', runId: 'a' })] }], 'ALL');
  check(t1[0].playerId === 'a', 'ties break deterministically');

  const ava = DEMO_PLAYERS[0];
  for (const r of REPLAYS) {
    const c = compareOnRug(you, ava, r.id);
    check(c.ok && c.rugId === r.id && c.you.rugId === r.id && c.friend.rugId === r.id && c.you.startingPaperSol === c.friend.startingPaperSol && c.startingPaperSol === STARTING_PAPER_SOL, `[${r.symbol}] you vs a friend compares the same rug from the same starting paper balance`);
  }
  const odd: PlayerRecord = { playerId: 'odd', name: 'Odd', demo: true, runs: [mkRun({ playerId: 'odd', rugId: REPLAYS[0].id, startingPaperSol: 50 })] };
  const none: PlayerRecord = { playerId: 'none', name: 'None', demo: true, runs: [] };
  const c1 = compareOnRug(you, odd, REPLAYS[0].id);
  const c2 = compareOnRug(you, none, REPLAYS[0].id);
  check(!c1.ok && c1.reason === 'DIFFERENT_START', 'runs from different starting balances are not compared');
  check(!c2.ok && c2.reason === 'NO_FRIEND', 'a friend with no run on the rug is not compared');
  check(computeVerdict(REPLAYS[0], newPlayer()) === null && buildRunResult(REPLAYS[0], newPlayer(), 'you') === null, 'a player who never bought has no result');
}

console.log(`\nCOMPETITION PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
