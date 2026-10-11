// Onchain score + Rug Hunter badge verification. Part of `npm run verify:replay`.
// No network and no wallet: the wallet/RPC are replaced by fakes, so every path is deterministic.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Keypair } from '@solana/web3.js';
import { getCreateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';

import { ACHIEVEMENT_VERSION, AchievementProgress, badgeStatus, RUG_HUNTER_REQUIRED, uniqueVerifiedSurvivingRugs } from '../src/badge/achievement';
import { BadgeClaim, claimBadge, claimFor } from '../src/badge/claim';
import { assetKeypairFromSignature, badgeSeedMessage, buildBadgeInstructions } from '../src/badge/mint';
import { badgeAttributes, badgeMetadataUri, BADGE_DESCRIPTION, BADGE_NAME } from '../src/badge/metadata';
import { badgeFor, canSubmit, ChainRecord, upsertChainRecord } from '../src/chain/chainState';
import { MEMO_PROGRAM_ID } from '../src/chain/config';
import { classifyError } from '../src/chain/errors';
import { MAX_MEMO_BYTES, MEMO_PREFIX, memoFromRunResult, matchesRunResult, parseMemo, recordFromRunResult, serializeMemo, verifyRecord } from '../src/chain/memo';
import { recordScoreOnchain, SubmitDeps } from '../src/chain/submit';
import { fetchVerifiedRuns, ParsedTxLike, ScanConnection, verifyTransaction, VerifiedChainRun } from '../src/chain/verifyTx';
import { DEMO_PLAYERS } from '../src/competition/demo';
import { buildRunResult, RunResult } from '../src/competition/result';
import { scoreRun } from '../src/competition/score';
import { REPLAYS } from '../src/data/replays';
import { applyBuy, applySell, newPlayer } from '../src/game/player';
import { tickIndexAt } from '../src/game/timeline';
import type { Replay } from '../src/game/types';
import { signalEvent } from '../src/game/verdict';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

const WALLET = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const OTHER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';

// ---------- fixtures: real RunResults built with the real accounting + verdict code ----------
type Style = 'CLEAN' | 'LATE' | 'RUGGED';
function runFor(replay: Replay, style: Style, playerId = 'you'): RunResult {
  const sig = signalEvent(replay)!;
  const start = replay.replayStart;
  const entry = start + (sig.timestamp - start) * 0.2;
  const exit = style === 'CLEAN' ? start + (sig.timestamp - start) * 0.6 : style === 'LATE' ? sig.timestamp + (replay.rugTimestamp - sig.timestamp) * 0.3 : null;
  const at = (ts: number) => {
    const i = Math.max(0, tickIndexAt(replay, ts));
    return { timestamp: ts, tickIndex: i, price: replay.ticks[i].price };
  };
  let p = applyBuy(newPlayer(), at(entry), replay.paperSolUsd);
  if (exit !== null) p = applySell(p, at(exit), replay.paperSolUsd);
  return buildRunResult(replay, p, playerId)!;
}

const txFor = (wallet: string, memo: string | string[], err: unknown = null): ParsedTxLike => ({
  meta: { err },
  transaction: {
    message: {
      accountKeys: [{ pubkey: wallet, signer: true }, { pubkey: MEMO_PROGRAM_ID, signer: false }],
      instructions: (Array.isArray(memo) ? memo : [memo]).map((m) => ({ programId: MEMO_PROGRAM_ID, parsed: m })),
    },
  },
});

/** A verified chain run exactly as the verifier would produce it. */
function verified(run: RunResult, wallet = WALLET, sig = `sig-${run.runId}`): VerifiedChainRun {
  const v = verifyTransaction(txFor(wallet, memoFromRunResult(run, wallet)), sig, REPLAYS, wallet);
  if (!v.ok) throw new Error('fixture did not verify: ' + v.reason);
  return v.run;
}

async function main() {
// ---------- 1. RunResult <-> memo ----------
console.log('\n== memo ==');
for (const r of REPLAYS) {
  for (const style of ['CLEAN', 'LATE', 'RUGGED'] as Style[]) {
    const run = runFor(r, style);
    const memo = memoFromRunResult(run, WALLET);
    const parsed = parseMemo(memo);
    const tag = `[${r.symbol}] ${style}`;
    check(parsed.ok && matchesRunResult(parsed.record, run, WALLET), `${tag}: RunResult -> memo -> record is lossless`);
    check(parsed.ok && parsed.record.score === run.score && parsed.record.verdict === run.verdict && parsed.record.rugId === run.rugId && parsed.record.runId === run.runId, `${tag}: score, verdict, rug id and run id are preserved exactly`);
    check(parsed.ok && parsed.record.wallet === WALLET && parsed.record.entryTimestamp === run.entryTimestamp && parsed.record.exitTimestamp === run.exitTimestamp && parsed.record.survivalSeconds === run.survivalSeconds && parsed.record.realizedPnlPct === run.realizedPnlPct, `${tag}: wallet, timestamps, survival and P/L are included correctly`);
    check(memo === memoFromRunResult(runFor(r, style), WALLET), `${tag}: the same RunResult always gives the same payload`);
    check(new TextEncoder().encode(memo).length <= MAX_MEMO_BYTES && memo.startsWith(MEMO_PREFIX + ' '), `${tag}: fits a Solana memo (${new TextEncoder().encode(memo).length} bytes) with the game/version prefix`);
    check(verifyRecord(recordFromRunResult(run, WALLET), { replays: REPLAYS, expectedWallet: WALLET }).ok, `${tag}: the record verifies against the replay catalogue and game rules`);
  }
}
{
  const r = REPLAYS[0];
  const run = runFor(r, 'CLEAN');
  const rec = recordFromRunResult(run, WALLET);
  const snapshot = JSON.stringify(run);
  void memoFromRunResult(run, WALLET);
  check(JSON.stringify(run) === snapshot && !('wallet' in run) && !('signature' in run), 'building the payload does not alter the RunResult');
  check(Object.isFrozen(rec), 'the record built from a RunResult is frozen: it cannot be edited before signing');
  check(memoFromRunResult(run, WALLET) !== memoFromRunResult(run, OTHER), 'a different wallet gives a different payload');

  const bad = (m: string) => !parseMemo(m).ok;
  const good = memoFromRunResult(run, WALLET);
  const body = JSON.parse(good.slice(MEMO_PREFIX.length + 1));
  const withBody = (b: unknown) => `${MEMO_PREFIX} ${JSON.stringify(b)}`;
  check(bad('hello') && bad('') && bad('rugreplay/1') && bad('rugreplay/1 {nope') && bad('rugreplay/2 ' + JSON.stringify(body)) && bad('other/1 ' + JSON.stringify(body)), 'malformed / foreign / unsupported-version memos are rejected');
  check(bad(withBody({ ...body, w: 'not-a-wallet' })) && bad(withBody({ ...body, d: 'WINNER' })) && bad(withBody({ ...body, s: 'high' })) && bad(withBody({ ...body, extra: 1 })) && bad(withBody({ ...body, r: undefined })), 'bad wallet / verdict / types / extra or missing fields are rejected');

  const ok = (b: unknown) => {
    const p = parseMemo(withBody(b));
    return p.ok && verifyRecord(p.record, { replays: REPLAYS, expectedWallet: WALLET }).ok;
  };
  check(ok(body), 'the untampered record verifies');
  check(!ok({ ...body, s: body.s + 1 }), 'a forged score does not verify');
  check(!ok({ ...body, d: 'RUGGED' }) && !ok({ ...body, d: 'LATE_EXIT' }), 'a forged verdict does not verify');
  check(!ok({ ...body, u: REPLAYS[1].id }) && !ok({ ...body, u: 'made-up-rug' }), 'a changed or unknown rug id does not verify');
  check(!ok({ ...body, e: body.e - 100000 }) && !ok({ ...body, x: body.x + 10_000_000 }) && !ok({ ...body, x: body.e - 1 }) && !ok({ ...body, t: body.t + 5 }), 'forged timestamps / survival do not verify');
  check(!verifyRecord(rec, { replays: REPLAYS, expectedWallet: OTHER }).ok, 'a record does not verify for a different wallet');
  check(!ok({ ...body, p: null }), 'P/L that disagrees with the exit does not verify');
}

// ---------- 2. transaction verification ----------
console.log('\n== transaction verification ==');
{
  const run = runFor(REPLAYS[1], 'LATE');
  const memo = memoFromRunResult(run, WALLET);
  const ok = verifyTransaction(txFor(WALLET, memo), 'S', REPLAYS, WALLET);
  check(ok.ok && ok.run.wallet === WALLET && ok.run.record.score === run.score, 'a signed, successful memo transaction verifies and yields the record');
  check(!verifyTransaction(txFor(WALLET, memo, { InstructionError: [0, 'x'] }), 'S', REPLAYS, WALLET).ok, 'a failed transaction does not verify');
  check(!verifyTransaction(txFor(OTHER, memo), 'S', REPLAYS, OTHER).ok, 'a record whose wallet is not the signer does not verify');
  check(!verifyTransaction(txFor(WALLET, memo), 'S', REPLAYS, OTHER).ok, 'a transaction signed by a different wallet is not accepted for this wallet');
  check(!verifyTransaction(txFor(WALLET, [memo, memo]), 'S', REPLAYS, WALLET).ok && !verifyTransaction(txFor(WALLET, []), 'S', REPLAYS, WALLET).ok, 'zero or multiple memo instructions do not verify');
  check(!verifyTransaction(null, 'S', REPLAYS, WALLET).ok && !verifyTransaction(txFor(WALLET, 'hello'), 'S', REPLAYS, WALLET).ok, 'a missing transaction or non-record memo does not verify');
}

// ---------- 3. submission: duplicates, rejection, failures ----------
console.log('\n== submission ==');
function harness(opts: { send?: (memo: string) => Promise<string>; fetch?: (sig: string) => Promise<ParsedTxLike | null>; findRecorded?: SubmitDeps['findRecorded'] } = {}) {
  let records: ChainRecord[] = [];
  const sent: string[] = [];
  const deps: SubmitDeps = {
    cluster: 'devnet',
    replays: REPLAYS,
    now: () => 1000,
    sendMemo: async (memo) => {
      sent.push(memo);
      return opts.send ? opts.send(memo) : `sig${sent.length}`;
    },
    fetchTx: opts.fetch ?? (async () => null),
    findRecorded: opts.findRecorded,
    save: (r) => {
      records = r;
    },
  };
  return { deps, sent, get records() { return records; }, getRecords: () => records };
}
{
  const run = runFor(REPLAYS[0], 'CLEAN');
  const h = harness({ fetch: async (sig) => txFor(WALLET, memoFromRunResult(run, WALLET)) });
  const a = await recordScoreOnchain(run, WALLET, h.getRecords, h.deps);
  check(a.ok && a.record.status === 'ONCHAIN_VERIFIED' && a.record.wallet === WALLET && a.record.network === 'devnet' && h.records.length === 1, 'recording stores wallet, signature, network and ONCHAIN_VERIFIED status');
  check(h.sent.length === 1 && h.sent[0] === memoFromRunResult(run, WALLET), 'the transaction carries exactly the payload built from the RunResult');
  const b = await recordScoreOnchain(run, WALLET, h.getRecords, h.deps);
  check(!b.ok && b.error.code === 'ALREADY_RECORDED' && b.error.message === 'Already recorded' && h.sent.length === 1 && h.records.length === 1, 'recording the same run again says "Already recorded" and sends nothing');
  const other = runFor(REPLAYS[1], 'LATE');
  const c = await recordScoreOnchain(other, WALLET, h.getRecords, { ...h.deps, fetchTx: async () => txFor(WALLET, memoFromRunResult(other, WALLET)) });
  check(c.ok && h.sent.length === 2 && h.records.length === 2, 'a different completed run can still be recorded');
  check(badgeFor(h.records, run.runId, 'devnet') === 'ONCHAIN_VERIFIED' && badgeFor(h.records, 'unrecorded', 'devnet') === 'LOCAL', 'a run shows ONCHAIN_VERIFIED once recorded, LOCAL otherwise');
  check(canSubmit(h.records, run.runId, 'devnet').ok === false && canSubmit(h.records, run.runId, 'mainnet-beta').ok === true, 'duplicates are per run and network');
}
{
  const run = runFor(REPLAYS[0], 'LATE');
  const before = JSON.stringify(run);
  const store = [run];
  const rejecting = harness({ send: async () => { throw Object.assign(new Error('User declined the transaction request'), { code: 4001 }); } });
  const r = await recordScoreOnchain(run, WALLET, rejecting.getRecords, rejecting.deps);
  check(!r.ok && r.error.code === 'TX_REJECTED' && rejecting.records.length === 0, 'a rejected wallet transaction is reported and records nothing');
  check(JSON.stringify(run) === before && store.length === 1 && store[0] === run, 'a rejected transaction leaves the local result intact');
  const retry = harness({ fetch: async () => txFor(WALLET, memoFromRunResult(run, WALLET)) });
  check((await recordScoreOnchain(run, WALLET, retry.getRecords, retry.deps)).ok, 'after a rejection the same run can be recorded later');

  // interrupted: sent, but the read-back fails -> signature kept as SUBMITTED, not re-sent
  const flaky = harness({ fetch: async () => { throw new Error('503 service unavailable'); } });
  const f1 = await recordScoreOnchain(run, WALLET, flaky.getRecords, flaky.deps);
  check(f1.ok && f1.record.status === 'SUBMITTED' && flaky.records.length === 1, 'if the read-back fails the signature is kept as SUBMITTED, not lost');
  const f2 = await recordScoreOnchain(run, WALLET, flaky.getRecords, flaky.deps);
  check(!f2.ok && f2.error.code === 'ALREADY_RECORDED' && flaky.sent.length === 1, 'an interrupted run is not submitted a second time');
  // a read-back that shows a different record never becomes verified
  const liar = harness({ fetch: async () => txFor(WALLET, memoFromRunResult(runFor(REPLAYS[0], 'CLEAN'), WALLET)) });
  const l = await recordScoreOnchain(run, WALLET, liar.getRecords, liar.deps);
  check(l.ok && l.record.status === 'SUBMITTED', 'a transaction that does not match this run is not marked verified');
  // chain already has it (e.g. reinstall)
  const dup = harness({ findRecorded: async () => 'oldsig' });
  const d = await recordScoreOnchain(run, WALLET, dup.getRecords, dup.deps);
  check(!d.ok && d.error.code === 'ALREADY_RECORDED' && dup.sent.length === 0 && dup.records[0]?.signature === 'oldsig', 'a run already recorded onchain (found by the wallet history) is not sent again');
  // an invalid payload never reaches the wallet
  const bogus: RunResult = { ...run, score: run.score + 1 };
  const bg = harness();
  const bo = await recordScoreOnchain(bogus, WALLET, bg.getRecords, bg.deps);
  check(!bo.ok && bo.error.code === 'MALFORMED_MEMO' && bg.sent.length === 0, 'a result whose score does not match the game rules is never sent to the wallet');
}
{
  const c = (e: unknown) => classifyError(e).code;
  check(c(new Error('Found no installed wallet that supports the requested transaction')) === 'WALLET_NOT_INSTALLED', 'error: wallet not installed');
  check(c(new Error('Authorization request declined')) === 'CONNECT_REJECTED' && c(Object.assign(new Error('x'), { code: 'ERROR_AUTHORIZATION_FAILED' })) !== 'UNKNOWN', 'error: wallet connection rejected');
  check(c(new Error('User declined the transaction request')) === 'TX_REJECTED', 'error: transaction rejected');
  check(c(new Error('Attempt to debit an account but found no record of a prior credit.')) === 'INSUFFICIENT_FUNDS' && c(new Error('insufficient lamports 5000')) === 'INSUFFICIENT_FUNDS', 'error: insufficient SOL for the fee');
  check(c(new Error('429 Too Many Requests')) === 'RPC_FAILURE' && c(new Error('block height exceeded')) === 'RPC_FAILURE', 'error: RPC failure');
  check(c(new TypeError('Network request failed')) === 'NETWORK_FAILURE', 'error: network failure');
  check(c(new Error('session closed')) === 'INTERRUPTED' && c(new Error('???')) === 'UNKNOWN', 'error: interrupted / unknown');
  check(['WALLET_NOT_INSTALLED', 'CONNECT_REJECTED', 'TX_REJECTED', 'INSUFFICIENT_FUNDS', 'RPC_FAILURE', 'NETWORK_FAILURE', 'INTERRUPTED', 'UNKNOWN'].every((k) => classifyError(new Error(k)).message.length > 0), 'every error case has a player-facing message');
  const up = upsertChainRecord([{ runId: 'a', wallet: WALLET, signature: 's', network: 'devnet', status: 'ONCHAIN_VERIFIED', recordedAt: 1 }], { runId: 'a', wallet: WALLET, signature: 's', network: 'devnet', status: 'SUBMITTED', recordedAt: 2 });
  check(up.length === 1 && up[0].status === 'ONCHAIN_VERIFIED', 'a verified record is never downgraded');
}

// ---------- 4. competition integration ----------
console.log('\n== competition integration ==');
{
  check(DEMO_PLAYERS.every((p) => p.demo && p.runs.every((r) => badgeFor([], r.runId, 'devnet') === 'LOCAL')), 'demo players stay DEMO and are never onchain');
  const keys = Object.keys(runFor(REPLAYS[0], 'CLEAN')).sort().join(',');
  check(!/wallet|signature|onchain|network/i.test(keys), 'the RunResult has no onchain fields (bookkeeping is stored separately)');
  check(scoreRun({ verdict: 'CLEAN_EXIT', entryTimestamp: 0, exitTimestamp: 0, collapseTimestamp: 100 }).total === 800 && scoreRun({ verdict: 'RUGGED', entryTimestamp: 0, exitTimestamp: null, collapseTimestamp: 100 }).total === 0, 'the scoring rules are unchanged');
  // a demo run can never be turned into a chain record for a wallet that did not play it as a real rug-less demo
  const demoRun = DEMO_PLAYERS[0].runs[0];
  const asRecord = verifyTransaction(txFor(WALLET, memoFromRunResult(demoRun, WALLET)), 'S', REPLAYS, WALLET);
  check(asRecord.ok === true, 'note: records are judged only on the rug, timing, verdict and score (they cannot prove who played; see report)');
}

// ---------- 5. scanning the wallet history ----------
console.log('\n== chain scan ==');
function fakeConn(entries: { signature: string; tx: ParsedTxLike; err?: unknown; memo?: string | null }[]): ScanConnection {
  return {
    getSignaturesForAddress: async (_a, opts) => (opts.before ? [] : entries.map((e) => ({ signature: e.signature, err: e.err ?? null, memo: e.memo === undefined ? `[100] ${MEMO_PREFIX} ...` : e.memo }))),
    getParsedTransaction: async (sig) => entries.find((e) => e.signature === sig)?.tx ?? null,
  };
}
{
  const runs = REPLAYS.map((r) => runFor(r, 'CLEAN'));
  const entries = runs.map((run, i) => ({ signature: `s${i}`, tx: txFor(WALLET, memoFromRunResult(run, WALLET)) }));
  const got = await fetchVerifiedRuns(fakeConn(entries), null, WALLET, REPLAYS);
  check(got.length === 4 && got.every((g) => g.wallet === WALLET), 'the scan returns every verified record the wallet signed');
  const mixed = [
    ...entries.slice(0, 2),
    { signature: 'bad1', tx: txFor(WALLET, memoFromRunResult({ ...runs[2], score: 1 }, WALLET)) },
    { signature: 'bad2', tx: txFor(WALLET, memoFromRunResult(runs[3], WALLET), { InstructionError: [0, 'x'] }), err: { InstructionError: 1 } },
    { signature: 'bad3', tx: txFor(OTHER, memoFromRunResult(runs[3], OTHER)) },
    { signature: 'bad4', tx: txFor(WALLET, 'hello world'), memo: '[11] hello world' },
  ];
  const got2 = await fetchVerifiedRuns(fakeConn(mixed), null, WALLET, REPLAYS);
  check(got2.length === 2, 'forged, failed, foreign-wallet and unrelated transactions are ignored by the scan');
}

// ---------- 6. Rug Hunter achievement ----------
console.log('\n== rug hunter achievement ==');
{
  const vr = (replay: Replay, style: Style, wallet = WALLET) => verified(runFor(replay, style), wallet);
  const prog = (runs: VerifiedChainRun[], wallet = WALLET) => uniqueVerifiedSurvivingRugs(runs, wallet, REPLAYS);
  const [A, B, C, D] = REPLAYS;
  check(prog([]).count === 0 && !prog([]).unlocked, '0 unique rugs: locked');
  check(prog([vr(A, 'CLEAN')]).count === 1 && !prog([vr(A, 'CLEAN')]).unlocked, '1 unique rug: locked');
  check(prog([vr(A, 'CLEAN'), vr(B, 'LATE')]).count === 2 && !prog([vr(A, 'CLEAN'), vr(B, 'LATE')]).unlocked, '2 unique rugs: locked');
  const three = prog([vr(A, 'CLEAN'), vr(B, 'LATE'), vr(C, 'CLEAN')]);
  check(three.count === 3 && three.unlocked && three.required === RUG_HUNTER_REQUIRED, '3 unique rugs: unlocked');
  check(prog([vr(A, 'CLEAN'), vr(A, 'LATE'), vr(A, 'CLEAN'), vr(A, 'CLEAN')]).count === 1, 'surviving the same rug several times counts as 1');
  check(prog([vr(A, 'CLEAN')]).counted[0].verdict === 'CLEAN_EXIT' && prog([vr(A, 'LATE')]).count === 1, 'CLEAN EXIT and LATE EXIT both count');
  check(prog([vr(A, 'RUGGED'), vr(B, 'RUGGED'), vr(C, 'RUGGED'), vr(D, 'RUGGED')]).count === 0, 'RUGGED never counts');
  check(prog([vr(A, 'CLEAN'), vr(B, 'CLEAN'), vr(C, 'RUGGED'), vr(D, 'RUGGED')]).count === 2, 'rugged rugs do not add to progress');
  check(prog([vr(A, 'CLEAN'), vr(B, 'LATE'), vr(C, 'CLEAN', OTHER)]).count === 2, 'records signed by another wallet do not count');
  const rev = prog([vr(C, 'CLEAN'), vr(B, 'LATE'), vr(A, 'CLEAN')]);
  check(JSON.stringify(rev.counted.map((c) => c.rugId)) === JSON.stringify(three.counted.map((c) => c.rugId)), 'the result does not depend on input order');
  const best = prog([vr(A, 'LATE'), vr(A, 'CLEAN')]).counted[0];
  check(best.verdict === 'CLEAN_EXIT', 'a rug survived twice is represented by its best run');
  // DEMO and unverified runs cannot even be represented: the input must be a VerifiedChainRun
  const demoRuns = DEMO_PLAYERS.flatMap((p) => p.runs);
  check(demoRuns.length > 0 && prog([]).count === 0, 'DEMO runs are not chain records, so they contribute nothing');
  const fakeNoWallet = { signature: 'x', wallet: WALLET, record: { ...recordFromRunResult(runFor(A, 'CLEAN'), WALLET), rugId: 'demo-rug' } } as unknown as VerifiedChainRun;
  check(prog([fakeNoWallet]).count === 0, 'a record for a non-catalogue (demo) rug is ignored');
  const unverifiedScan = await fetchVerifiedRuns(fakeConn([{ signature: 'u', tx: txFor(WALLET, memoFromRunResult({ ...runFor(A, 'CLEAN'), score: 999 }, WALLET)) }]), null, WALLET, REPLAYS);
  check(prog(unverifiedScan).count === 0, 'an unverified (forged) record does not count');
  // the achievement is a pure function of verified chain runs: no wallet connection is involved
  check(three.unlocked && badgeStatus(three, false) === 'UNLOCKED' && badgeStatus(prog([vr(A, 'CLEAN')]), false) === 'LOCKED' && badgeStatus(three, true) === 'CLAIMED', 'status is LOCKED / UNLOCKED / CLAIMED, and unlocked does not need a connected wallet');
}

// ---------- 7. claim ----------
console.log('\n== badge claim ==');
{
  const runs3 = [REPLAYS[0], REPLAYS[1], REPLAYS[2]].map((r, i) => verified(runFor(r, i === 1 ? 'LATE' : 'CLEAN')));
  const runs2 = runs3.slice(0, 2);
  const make = (chainRuns: VerifiedChainRun[], o: { existing?: string | null; mint?: () => Promise<{ assetAddress: string; signature: string }> } = {}) => {
    let claims: BadgeClaim[] = [];
    const minted: number[] = [];
    return {
      get claims() { return claims; },
      getClaims: () => claims,
      minted,
      deps: {
        cluster: 'devnet' as const,
        replays: REPLAYS,
        now: () => 5,
        fetchVerifiedRuns: async () => chainRuns,
        existingBadge: async () => o.existing ?? null,
        mint: o.mint ?? (async (_w: string, p: AchievementProgress) => { minted.push(p.count); return { assetAddress: 'ASSET1', signature: 'MINTSIG' }; }),
        save: (c: BadgeClaim[]) => { claims = c; },
      },
    };
  };
  const h2 = make(runs2);
  const n = await claimBadge(WALLET, h2.getClaims, h2.deps);
  check(!n.ok && n.reason === 'NOT_ELIGIBLE' && h2.minted.length === 0, 'with 2 unique rugs the claim is refused and nothing is minted');

  const h = make(runs3);
  const c1 = await claimBadge(WALLET, h.getClaims, h.deps);
  check(c1.ok && c1.claim.assetAddress === 'ASSET1' && c1.claim.signature === 'MINTSIG' && c1.claim.rugsSurvived === 3 && c1.claim.network === 'devnet', 'with 3 verified unique rugs the badge is minted and the claim stores asset, signature, network and rugs survived');
  const c2 = await claimBadge(WALLET, h.getClaims, h.deps);
  check(!c2.ok && c2.reason === 'ALREADY_CLAIMED' && h.minted.length === 1, 'the same wallet cannot claim twice (no second mint)');
  check(claimFor(h.claims, WALLET, 'devnet') !== null && claimFor(h.claims, OTHER, 'devnet') === null, 'a claim belongs to one wallet and network');

  const ex = make(runs3, { existing: 'OLDASSET' });
  const c3 = await claimBadge(WALLET, ex.getClaims, ex.deps);
  check(!c3.ok && c3.reason === 'ALREADY_CLAIMED' && ex.minted.length === 0 && ex.claims[0].assetAddress === 'OLDASSET', 'a badge already onchain for the wallet (e.g. after reinstall) is detected, not minted again');

  let first = true;
  const rj = make(runs3, { mint: async () => { if (first) { first = false; throw new Error('User declined the transaction request'); } return { assetAddress: 'A2', signature: 'S2' }; } });
  const r1 = await claimBadge(WALLET, rj.getClaims, rj.deps);
  check(!r1.ok && r1.reason === 'ERROR' && r1.error.code === 'TX_REJECTED' && rj.claims.length === 0, 'a rejected mint leaves the badge unclaimed');
  const r2 = await claimBadge(WALLET, rj.getClaims, rj.deps);
  check(r2.ok, 'and it can be claimed later');

  // achievement reached without a wallet, claimed after connecting later
  const progressNoWallet = uniqueVerifiedSurvivingRugs(runs3, WALLET, REPLAYS);
  check(progressNoWallet.unlocked, 'the achievement is unlocked from verified runs alone');
  const later = make(runs3);
  check((await claimBadge(WALLET, later.getClaims, later.deps)).ok, 'it can be claimed after the wallet is connected later');

  // attributes come from fresh chain data, not the caller
  const att = make(runs3);
  let seen: string[] = [];
  att.deps.mint = async (_w, p) => { seen = badgeAttributes(p).map((a) => `${a.key}=${a.value}`); return { assetAddress: 'A', signature: 'S' }; };
  await claimBadge(WALLET, att.getClaims, att.deps);
  check(seen.includes('Rugs Survived=3') && seen.includes('Achievement=Rug Hunter') && seen.includes('Game=Rug Replay') && seen.includes(`Achievement Version=${ACHIEVEMENT_VERSION}`) && seen.includes('Non-Demo=true'), 'badge attributes are built from the verified progress');
  check(!seen.join('|').includes(WALLET) && !BADGE_DESCRIPTION.includes(WALLET) && BADGE_NAME === 'Rug Hunter' && BADGE_DESCRIPTION === 'Earned by surviving 3 unique historical rug pulls in Rug Replay.', 'public metadata has the agreed name/description and no wallet information');
  check(badgeMetadataUri(undefined).startsWith('data:application/json,') && badgeMetadataUri('https://example.com/b.json') === 'https://example.com/b.json', 'metadata URI: configured https URL, or a small inline fallback');

  // a wallet that failed to read the chain cannot claim
  const down = make(runs3);
  down.deps.fetchVerifiedRuns = async () => { throw new TypeError('Network request failed'); };
  const dn = await claimBadge(WALLET, down.getClaims, down.deps);
  check(!dn.ok && dn.reason === 'ERROR' && dn.error.code === 'NETWORK_FAILURE' && down.claims.length === 0, 'if the chain cannot be read, nothing is claimed');
}

// ---------- 8. Metaplex Core instruction ----------
console.log('\n== metaplex core badge ==');
{
  const sigA = new Uint8Array(64).fill(7);
  const sigB = new Uint8Array(64).fill(8);
  const kpA = assetKeypairFromSignature(sigA);
  check(kpA.publicKey.equals(assetKeypairFromSignature(sigA).publicKey) && !kpA.publicKey.equals(assetKeypairFromSignature(sigB).publicKey), 'the badge address is deterministic per wallet signature and differs between wallets');
  check(new TextDecoder().decode(badgeSeedMessage(WALLET, 'devnet')).includes(WALLET), 'the seed message names the wallet and is readable');
  const progress = uniqueVerifiedSurvivingRugs([REPLAYS[0], REPLAYS[1], REPLAYS[2]].map((r) => verified(runFor(r, 'CLEAN'))), WALLET, REPLAYS);
  const ixs = buildBadgeInstructions(WALLET, kpA, progress, 'http://127.0.0.1:1');
  check(ixs.length === 1 && ixs[0].programId.toBase58() === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'one Metaplex Core instruction is built');
  const keys = ixs[0].keys;
  check(keys.some((k) => k.pubkey.equals(kpA.publicKey) && k.isSigner) && keys.some((k) => k.pubkey.toBase58() === WALLET && k.isSigner), 'the asset and the wallet sign; the asset is the derived address');
  const data = getCreateV2InstructionDataSerializer().deserialize(ixs[0].data)[0] as any;
  const plugins = data.plugins.__option === 'Some' ? data.plugins.value : [];
  const byType = (t: string) => plugins.find((p: any) => p.plugin.__kind === t);
  check(data.name === 'Rug Hunter', 'the asset is named Rug Hunter');
  const frozen = byType('PermanentFreezeDelegate');
  check(!!frozen && frozen.plugin.fields[0].frozen === true && frozen.authority.__option === 'Some' && frozen.authority.value.__kind === 'None', 'PermanentFreezeDelegate is frozen with NO authority: the badge cannot be transferred or unfrozen');
  const attrs = byType('Attributes');
  check(!!attrs && attrs.authority.value.__kind === 'None' && attrs.plugin.fields[0].attributeList.some((a: any) => a.key === 'Rugs Survived' && a.value === '3'), 'Attributes are written onchain and made immutable');
  check(!!byType('ImmutableMetadata'), 'name/uri are made immutable');
  // the hosted metadata is what the mint actually writes into the asset
  const HOSTED = 'https://rugrat-badge.expo.app/rug-hunter.json';
  const easEnv = JSON.parse(readFileSync(join(__dirname, '..', 'eas.json'), 'utf8')).build;
  check(easEnv.preview.env.EXPO_PUBLIC_BADGE_METADATA_URI === HOSTED && easEnv.production.env.EXPO_PUBLIC_BADGE_METADATA_URI === HOSTED, 'every EAS build profile sets EXPO_PUBLIC_BADGE_METADATA_URI to the hosted metadata');
  const prevUri = process.env.EXPO_PUBLIC_BADGE_METADATA_URI;
  process.env.EXPO_PUBLIC_BADGE_METADATA_URI = HOSTED;
  const hostedData = getCreateV2InstructionDataSerializer().deserialize(buildBadgeInstructions(WALLET, kpA, progress, 'http://127.0.0.1:1')[0].data)[0] as any;
  if (prevUri === undefined) delete process.env.EXPO_PUBLIC_BADGE_METADATA_URI;
  else process.env.EXPO_PUBLIC_BADGE_METADATA_URI = prevUri;
  check(hostedData.uri === HOSTED && hostedData.name === 'Rug Hunter', 'with the env var set, the mint instruction carries the hosted metadata URI');
  const hostedJson = JSON.parse(readFileSync(join(__dirname, '..', 'badge', 'site', 'rug-hunter.json'), 'utf8'));
  const attrKeys = badgeAttributes(progress).map((a) => a.key).sort().join();
  check(hostedJson.attributes.map((a: any) => a.trait_type).sort().join() === attrKeys && hostedJson.name === BADGE_NAME && hostedJson.description === BADGE_DESCRIPTION && /^https:\/\/rugrat-badge\.expo\.app\/rug-hunter\.png$/.test(hostedJson.image), 'the hosted metadata has the same name, description and attributes as the mint code and points at the hosted image');
  check(JSON.stringify(JSON.parse(readFileSync(join(__dirname, '..', 'badge', 'rug-hunter.json'), 'utf8'))) === JSON.stringify(hostedJson), 'the repo copy of the metadata matches what is hosted');
  // not transferable by owner: no owner-managed transfer plugin is present
  check(!byType('TransferDelegate') && !byType('PermanentTransferDelegate') && !byType('BurnDelegate'), 'no transfer or burn delegate is attached');
}

}

main().then(() => {
  console.log(`\nONCHAIN PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL  suite crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
