// SKR badge upgrades (payment flow + issuer) and the locked prize-pool accounting.
// Part of `npm run verify:replay`. No network: the chain is faked, the issuer key is a test key.
// These tests prove the logic and the transaction contents; they do not prove a real payment on a
// real network (that needs the devnet run described in server/README.md).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

import { DEMO_PLAYERS } from '../src/competition/demo';
import { buildRunResult, RunResult } from '../src/competition/result';
import { REPLAYS } from '../src/data/replays';
import { applyBuy, applySell, newPlayer } from '../src/game/player';
import { tickIndexAt } from '../src/game/timeline';
import type { Replay } from '../src/game/types';
import { signalEvent } from '../src/game/verdict';
import { uniqueVerifiedSurvivingRugs } from '../src/badge/achievement';
import { MEMO_PROGRAM_ID } from '../src/chain/config';
import { memoFromRunResult } from '../src/chain/memo';
import { ParsedTxLike, verifyTransaction, VerifiedChainRun } from '../src/chain/verifyTx';
import { PAYOUT_GATE, PAYOUT_SHARES, PayoutsLocked, assertPayoutsAllowed, planPayouts, POOL_SPLIT, rankWeek, splitFunds, TimedVerifiedRun, weekOf } from '../src/prize/pool';
import { upgradeTier, fetchOwnedTiers, UpgradeIO } from '../src/upgrade/client';
import { upgradeAvailability } from '../src/upgrade/config';
import { inspectUpgradeTransaction, MPL_CORE_PROGRAM } from '../src/upgrade/inspect';
import { IssuerConfig, IssuerDeps, prepareUpgrade, tierAssetKeypair } from '../src/upgrade/issuer';
import { TIERS, formatPrice, tierViews } from '../src/upgrade/tiers';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

// ---------- fixtures ----------
const walletKp = Keypair.fromSeed(new Uint8Array(32).fill(1));
const WALLET = walletKp.publicKey.toBase58();
const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const issuer = Keypair.fromSeed(new Uint8Array(32).fill(3));
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
const TREASURY = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey;
const COLLECTION = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();

const cfg: IssuerConfig = { issuer, collection: COLLECTION, paymentMint: MINT.toBase58(), paymentDecimals: 6, treasury: TREASURY.toBase58(), assetSecret: 'test-secret', rpcUrl: 'http://127.0.0.1:1', replays: REPLAYS };

type Style = 'CLEAN' | 'LATE' | 'RUGGED';
function runFor(replay: Replay, style: Style): RunResult {
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
  return buildRunResult(replay, p, 'you')!;
}
const txFor = (wallet: string, memo: string): ParsedTxLike => ({
  meta: { err: null },
  transaction: { message: { accountKeys: [{ pubkey: wallet, signer: true }], instructions: [{ programId: MEMO_PROGRAM_ID, parsed: memo }] } },
});
function verified(run: RunResult, wallet = WALLET): VerifiedChainRun {
  const v = verifyTransaction(txFor(wallet, memoFromRunResult(run, wallet)), `sig-${run.runId}`, REPLAYS, wallet);
  if (!v.ok) throw new Error(v.reason);
  return v.run;
}
const runsFor = (n: number, wallet = WALLET) => REPLAYS.slice(0, n).map((r) => verified(runFor(r, 'CLEAN'), wallet));

const deps = (runs: VerifiedChainRun[], o: { exists?: boolean; readFails?: boolean } = {}): IssuerDeps => ({
  fetchVerifiedRuns: async () => {
    if (o.readFails) throw new Error('rpc down');
    return runs;
  },
  accountExists: async () => o.exists ?? false,
  latestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 }),
});

const prog = (n: number) => uniqueVerifiedSurvivingRugs(runsFor(n), WALLET, REPLAYS);
const exp = (tier = 1) => ({ wallet: WALLET, tier, paymentMint: MINT.toBase58(), paymentDecimals: 6, treasury: TREASURY.toBase58(), amount: TIERS[tier - 1].priceBaseUnits });

async function main() {
  // ---------- tiers ----------
  console.log('\n== tiers and eligibility ==');
  check(TIERS.map((t) => t.requiredRugs).join() === '3,7,15' && TIERS.length === 3, 'tiers unlock at 3, 7 and 15 unique rugs');
  for (const [n, want] of [[0, 'LOCKED,LOCKED,LOCKED'], [2, 'LOCKED,LOCKED,LOCKED'], [3, 'ELIGIBLE,LOCKED,LOCKED'], [4, 'ELIGIBLE,LOCKED,LOCKED']] as const) {
    check(tierViews(prog(n), []).map((v) => v.status).join() === want, `${n} verified unique rugs -> ${want}`);
  }
  check(tierViews(prog(3), [1]).map((v) => v.status).join() === 'OWNED,LOCKED,LOCKED', 'an owned tier shows OWNED');
  check(tierViews(prog(4), [1])[0].have === 3 && tierViews(prog(2), [])[0].have === 2, 'progress is shown as have / required');
  check(formatPrice(10_000_000n) === '10' && formatPrice(1_500_000n) === '1.5', 'prices format from base units');
  check(uniqueVerifiedSurvivingRugs([verified(runFor(REPLAYS[0], 'CLEAN')), verified(runFor(REPLAYS[0], 'LATE')), verified(runFor(REPLAYS[0], 'CLEAN'))], WALLET, REPLAYS).count === 1, 'eligibility counts a rug once (same verified-runs source as the free badge)');

  // ---------- issuer ----------
  console.log('\n== issuer: prepare ==');
  const ok = await prepareUpgrade(cfg, deps(runsFor(3)), { wallet: WALLET, tier: 1 });
  check(ok.ok, 'a wallet with 3 verified unique rugs gets a prepared upgrade for tier 1');
  if (!ok.ok) throw new Error('cannot continue');
  const tx = Transaction.from(Buffer.from(ok.transaction, 'base64'));
  const progs = tx.instructions.map((i) => i.programId.toBase58());
  check(progs.includes(MPL_CORE_PROGRAM) && progs.includes(MEMO_PROGRAM_ID) && progs.filter((p) => p === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').length === 1, 'one atomic transaction: payment + memo + badge');
  check(tx.feePayer?.toBase58() === WALLET, 'the player is the fee payer and signs last');
  const sigFor = (pk: PublicKey) => tx.signatures.find((s) => s.publicKey.equals(pk))?.signature;
  check(!!sigFor(issuer.publicKey) && !!sigFor(new PublicKey(ok.assetAddress)) && !sigFor(walletKp.publicKey), 'the issuer and the badge key have signed; the player has not');
  check(ok.amount === '10000000' && ok.paymentMint === MINT.toBase58() && ok.collection === COLLECTION, 'the response states price, token and collection');
  check(ok.assetAddress === tierAssetKeypair('test-secret', WALLET, 1).publicKey.toBase58(), 'the badge address is derived from (wallet, tier)');
  check(tierAssetKeypair('s', WALLET, 1).publicKey.toBase58() !== tierAssetKeypair('s', WALLET, 2).publicKey.toBase58() && tierAssetKeypair('s', WALLET, 1).publicKey.toBase58() !== tierAssetKeypair('s', OTHER, 1).publicKey.toBase58() && tierAssetKeypair('s', WALLET, 1).publicKey.toBase58() !== tierAssetKeypair('t', WALLET, 1).publicKey.toBase58(), 'the badge address differs per tier, wallet and secret');

  const no2 = await prepareUpgrade(cfg, deps(runsFor(2)), { wallet: WALLET, tier: 1 });
  check(!no2.ok && no2.code === 'NOT_ELIGIBLE', 'with 2 unique rugs, tier 1 is refused');
  const no3 = await prepareUpgrade(cfg, deps(runsFor(4)), { wallet: WALLET, tier: 2 });
  check(!no3.ok && no3.code === 'NOT_ELIGIBLE', 'tier 2 needs 7 unique rugs: refused with 4');
  const ruggedOnly = await prepareUpgrade(cfg, deps(REPLAYS.map((r) => verified(runFor(r, 'RUGGED')))), { wallet: WALLET, tier: 1 });
  check(!ruggedOnly.ok && ruggedOnly.code === 'NOT_ELIGIBLE', 'rugged runs never make a wallet eligible');
  const foreign = await prepareUpgrade(cfg, deps(runsFor(4, OTHER)), { wallet: WALLET, tier: 1 });
  check(!foreign.ok && foreign.code === 'NOT_ELIGIBLE', "another wallet's verified runs do not make this wallet eligible");
  const fakeClaim = await prepareUpgrade(cfg, deps(runsFor(1)), { wallet: WALLET, tier: 1, count: 99, eligible: true } as any);
  check(!fakeClaim.ok && fakeClaim.code === 'NOT_ELIGIBLE', 'client-supplied eligibility or counts are ignored: the issuer reads the chain');
  const owned = await prepareUpgrade(cfg, deps(runsFor(4), { exists: true }), { wallet: WALLET, tier: 1 });
  check(!owned.ok && owned.code === 'ALREADY_OWNED', 'a tier that was already minted cannot be bought twice');
  const down = await prepareUpgrade(cfg, deps(runsFor(4), { readFails: true }), { wallet: WALLET, tier: 1 });
  check(!down.ok && down.code === 'UNAVAILABLE', 'if the chain cannot be read, nothing is issued');
  for (const bad of [{ wallet: 'nope', tier: 1 }, { wallet: WALLET, tier: 9 }, { wallet: WALLET, tier: '1' }, { wallet: 5, tier: 1 }, { wallet: WALLET, tier: 0 }]) {
    const r = await prepareUpgrade(cfg, deps(runsFor(4)), bad as any);
    check(!r.ok && r.code === 'BAD_REQUEST', `bad request rejected: ${JSON.stringify(bad)}`);
  }

  // ---------- client safety check ----------
  console.log('\n== client: transaction inspection ==');
  check(inspectUpgradeTransaction(ok.transaction, exp(1)).ok, 'the genuine upgrade transaction passes the app’s own check');
  const rebuild = (mutate: (ixs: TransactionInstruction[]) => TransactionInstruction[], feePayer = walletKp.publicKey) => {
    const t = new Transaction({ feePayer, blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1000 });
    t.add(...mutate([...tx.instructions]));
    return t.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  const from = getAssociatedTokenAddressSync(MINT, walletKp.publicKey);
  const to = getAssociatedTokenAddressSync(MINT, TREASURY, true);
  const replaceToken = (ix: TransactionInstruction) => (list: TransactionInstruction[]) => list.map((i) => (i.programId.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? ix : i));
  const bad = (b64: string) => !inspectUpgradeTransaction(b64, exp(1)).ok;
  check(bad(rebuild(replaceToken(createTransferCheckedInstruction(from, MINT, to, walletKp.publicKey, 10_000_001n, 6)))), 'a changed (higher) price is refused');
  check(bad(rebuild(replaceToken(createTransferCheckedInstruction(from, MINT, to, walletKp.publicKey, 1n, 6)))), 'a changed (lower) price is refused');
  const thief = getAssociatedTokenAddressSync(MINT, new PublicKey(OTHER));
  check(bad(rebuild(replaceToken(createTransferCheckedInstruction(from, MINT, thief, walletKp.publicKey, 10_000_000n, 6)))), 'a different destination is refused');
  const otherMint = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  check(bad(rebuild(replaceToken(createTransferCheckedInstruction(getAssociatedTokenAddressSync(otherMint, walletKp.publicKey), otherMint, getAssociatedTokenAddressSync(otherMint, TREASURY, true), walletKp.publicKey, 10_000_000n, 6)))), 'a different payment token is refused');
  check(bad(rebuild((l) => [...l, SystemProgram.transfer({ fromPubkey: walletKp.publicKey, toPubkey: new PublicKey(OTHER), lamports: 1_000_000 })])), 'an extra SOL transfer is refused');
  check(bad(rebuild((l) => [...l, createTransferCheckedInstruction(from, MINT, thief, walletKp.publicKey, 1n, 6)])), 'a second token transfer is refused');
  check(bad(rebuild((l) => l.filter((i) => i.programId.toBase58() !== MEMO_PROGRAM_ID))), 'a missing memo is refused');
  check(bad(rebuild((l) => l.filter((i) => i.programId.toBase58() !== MPL_CORE_PROGRAM))), 'a missing badge instruction is refused');
  check(bad(rebuild((l) => l, new PublicKey(OTHER))), 'a different fee payer is refused');
  check(bad('not base64 tx') && bad(''), 'garbage is refused');
  check(!inspectUpgradeTransaction(ok.transaction, { ...exp(1), tier: 2, amount: TIERS[1].priceBaseUnits }).ok, 'a tier-1 transaction is not accepted for tier 2');
  check(!inspectUpgradeTransaction(ok.transaction, { ...exp(1), treasury: OTHER }).ok, "the app's own treasury setting is what counts, not the server's");

  // ---------- client flow ----------
  console.log('\n== client: upgrade flow ==');
  const session = { address: WALLET, authToken: 't' };
  const avail = upgradeAvailability({ ISSUER_URL: 'http://issuer.test', PAYMENT_MINT: MINT.toBase58(), TREASURY: TREASURY.toBase58() });
  const mkIO = (response: { status: number; json: any } | Error, signErr = false) => {
    const calls: string[] = [];
    const io: UpgradeIO = {
      post: async (url) => {
        calls.push(url);
        if (response instanceof Error) throw response;
        return response;
      },
      sign: async () => {
        calls.push('sign');
        if (signErr) throw new Error('User declined');
        return 'SIG123';
      },
    };
    return { io, calls };
  };
  {
    const a = mkIO({ status: 200, json: ok });
    const r = await upgradeTier(session, 1, avail, a.io);
    check(r.ok && r.signature === 'SIG123' && r.assetAddress === ok.assetAddress && a.calls.filter((c) => c === 'sign').length === 1, 'a valid prepared transaction is signed once and the result reports signature and badge');
    const b = mkIO({ status: 409, json: { ok: false, code: 'NOT_ELIGIBLE', message: 'Needs 3' } });
    const rb = await upgradeTier(session, 1, avail, b.io);
    check(!rb.ok && rb.code === 'NOT_ELIGIBLE' && !b.calls.includes('sign'), 'a refusal from the issuer never reaches the wallet');
    const c = mkIO({ status: 200, json: { ...ok, transaction: rebuild(replaceToken(createTransferCheckedInstruction(from, MINT, to, walletKp.publicKey, 99_000_000n, 6))) } });
    const rc = await upgradeTier(session, 1, avail, c.io);
    check(!rc.ok && rc.code === 'UNSAFE' && !c.calls.includes('sign'), 'a tampered transaction from the server is never shown to the wallet');
    const d = mkIO(new Error('Network request failed'));
    const rd = await upgradeTier(session, 1, avail, d.io);
    check(!rd.ok && rd.code === 'SERVER' && /Nothing was charged/.test(rd.message), 'if the issuer is unreachable, nothing is charged');
    const e = mkIO({ status: 200, json: ok }, true);
    const re = await upgradeTier(session, 1, avail, e.io);
    check(!re.ok && re.code === 'WALLET' && /Nothing was charged/.test(re.message), 'a declined wallet signature charges nothing and can be retried');
    const off = mkIO({ status: 200, json: ok });
    const ro = await upgradeTier(session, 1, upgradeAvailability({ ISSUER_URL: null, PAYMENT_MINT: null, TREASURY: null }), off.io);
    check(!ro.ok && ro.code === 'UNAVAILABLE' && off.calls.length === 0, 'with no issuer configured, upgrades are unavailable and nothing is called');
    check(!upgradeAvailability({ ISSUER_URL: 'x', PAYMENT_MINT: null, TREASURY: 'y' }).available && upgradeAvailability({ ISSUER_URL: 'x', PAYMENT_MINT: MINT.toBase58(), TREASURY: TREASURY.toBase58() }).available, 'upgrades need an issuer, a payment token and a treasury (valid addresses)');
    const ot = mkIO({ status: 200, json: { ok: true, owned: [1, 'x', 3] } });
    check((await fetchOwnedTiers(session, avail, ot.io)).join() === '1,3' && (await fetchOwnedTiers(session, avail, mkIO(new Error('x')).io)).length === 0, 'owned tiers are read from the issuer; a failure just shows none');
  }

  // ---------- prize pool ----------
  console.log('\n== prize pool (accounting only; payouts locked) ==');
  {
    const s = splitFunds(1000n);
    check(s.pool === 700n && s.operations === 200n && s.reserve === 100n && POOL_SPLIT.pool === 70n, 'funds split 70% pool / 20% operations / 10% reserve');
    let exact = true;
    for (const t of [0n, 1n, 7n, 99n, 101n, 123_456_789n, 10n ** 15n + 3n]) {
      const x = splitFunds(t);
      if (x.pool + x.operations + x.reserve !== t || x.pool < 0n) exact = false;
    }
    check(exact, 'the three parts always sum exactly to the total (no dust lost or created)');
    check((() => { try { splitFunds(-1n); return false; } catch { return true; } })(), 'a negative amount is rejected');

    check(weekOf(Date.UTC(2026, 9, 7, 12) / 1000).id === '2026-W41' && weekOf(Date.UTC(2026, 9, 7, 12) / 1000).start === Date.UTC(2026, 9, 5) / 1000, 'weeks start Monday 00:00 UTC (2026-10-07 is in 2026-W41)');
    const w = weekOf(Date.UTC(2026, 9, 7) / 1000);
    check(weekOf(w.start).id === w.id && weekOf(w.end - 1).id === w.id && weekOf(w.end).id !== w.id, 'week boundaries are exact');
    check(weekOf(Date.UTC(2024, 11, 30) / 1000).id === '2025-W01' && weekOf(Date.UTC(2021, 0, 3) / 1000).id === '2020-W53', 'ISO year boundaries are handled');

    const T0 = w.start + 3600;
    const mk = (wallet: string, rug: number, style: Style, blockTime: number): TimedVerifiedRun => ({ run: verified(runFor(REPLAYS[rug], style), wallet), blockTime });
    const A = WALLET;
    const B = OTHER;
    const runs = [mk(A, 0, 'CLEAN', T0), mk(A, 1, 'LATE', T0), mk(B, 0, 'LATE', T0), mk(B, 1, 'RUGGED', T0), mk(B, 2, 'CLEAN', T0)];
    const ranked = rankWeek(runs, w);
    check(ranked.length === 2 && ranked.every((r, i) => r.rank === i + 1 && (i === 0 || ranked[i - 1].score >= r.score)), 'the weekly ranking is sorted by skill score');
    check(JSON.stringify(rankWeek([...runs].reverse(), w)) === JSON.stringify(ranked), 'ranking does not depend on input order (deterministic)');
    check(rankWeek(runs, weekOf(w.start - 1)).length === 0 && rankWeek(runs.map((r) => ({ ...r, blockTime: w.end })), w).length === 0, 'only records whose block time is inside the week count');
    const dup = rankWeek([mk(A, 0, 'LATE', T0), mk(A, 0, 'CLEAN', T0), mk(A, 0, 'CLEAN', T0)], w);
    check(dup.length === 1 && dup[0].rugsSurvived === 1 && dup[0].score === runFor(REPLAYS[0], 'CLEAN').score, 'one rug counts once per wallet (its best result)');
    check(rankWeek([mk(A, 0, 'RUGGED', T0), mk(B, 1, 'RUGGED', T0)], w).length === 0, 'a week of rugged runs scores nothing and wins nothing');
    check(rankWeek([{ run: { ...verified(runFor(REPLAYS[0], 'CLEAN')), wallet: OTHER } as VerifiedChainRun, blockTime: T0 }], w).length === 0, 'a record not signed by its own wallet is ignored');
    check(DEMO_PLAYERS.every((p) => p.demo) && ranked.every((r) => !/demo/i.test(r.wallet)), 'DEMO players cannot appear: only wallet-signed verified records are accepted');

    const pool = 1_000_003n;
    const plan = planPayouts(pool, [...ranked, { rank: 3, wallet: 'c', score: 1, rugsSurvived: 1, cleanExits: 0 }]);
    check(plan.reduce((s, l) => s + l.amount, 0n) === pool && plan.length === 3 && plan[0].amount > plan[1].amount && plan[1].amount > plan[2].amount, 'the payout plan sums exactly to the pool, 50/30/20 with rounding dust to rank 1');
    check(PAYOUT_SHARES.join() === '50,30,20', 'shares are 50% / 30% / 20%');
    const two = planPayouts(1000n, ranked);
    check(two.length === 2 && two[0].amount + two[1].amount === 1000n, 'with only two winners the pool is still fully allocated');
    check(planPayouts(1000n, []).length === 0 && planPayouts(0n, ranked).length === 0, 'no winners or an empty pool give an empty plan');

    check(PAYOUT_GATE.enabled === false && PAYOUT_GATE.legalReviewConfirmed === false && Object.isFrozen(PAYOUT_GATE), 'payouts ship locked, and the gate is frozen');
    const throws = (g: any) => { try { assertPayoutsAllowed(g); return false; } catch (e) { return e instanceof PayoutsLocked; } };
    check(throws(undefined) && throws({ enabled: true, legalReviewConfirmed: false }) && throws({ enabled: false, legalReviewConfirmed: true }) && !throws({ enabled: true, legalReviewConfirmed: true }), 'payouts are allowed only when BOTH the operator switch and the legal-review confirmation are set');
  }

  // ---------- isolation ----------
  console.log('\n== isolation ==');
  {
    const root = join(__dirname, '..');
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const guarded = [...walk(join(root, 'src/game')), ...walk(join(root, 'src/competition')), join(root, 'src/chain/memo.ts'), join(root, 'src/chain/verifyTx.ts'), join(root, 'src/chain/submit.ts'), join(root, 'src/badge/achievement.ts'), join(root, 'src/badge/claim.ts')];
    const leaks = guarded.filter((f) => /upgrade|prize|payment|treasury/i.test(strip(readFileSync(f, 'utf8'))));
    check(leaks.length === 0, `game, scoring, competition and verification code never reference upgrades, prizes or payments${leaks.length ? ' (' + leaks.join(', ') + ')' : ''}`);
    const prizeSrc = walk(join(root, 'src/prize')).map((f) => strip(readFileSync(f, 'utf8'))).join('\n');
    check(!/sendTransaction|signAndSend|transfer|@solana\/web3|@solana\/spl-token|fetch\(/.test(prizeSrc), 'the prize module contains no code that can move funds or talk to a network');
    const appImportsIssuer = walk(join(root, 'src')).filter((f) => !f.endsWith(join('upgrade', 'issuer.ts')) && /upgrade\/issuer|\.\/issuer/.test(readFileSync(f, 'utf8')));
    check(appImportsIssuer.length === 0, 'the app never imports the issuer (it holds server-only logic)');
    const keyInApp = walk(join(root, 'src')).filter((f) => /ISSUER_KEYPAIR|ASSET_SECRET|secretKey/.test(readFileSync(f, 'utf8')) && !f.endsWith(join('upgrade', 'issuer.ts')));
    check(keyInApp.length === 0, 'no issuer key or secret is referenced in app code');
    const rugsLeft = REPLAYS.length;
    check(rugsLeft === 4 && TIERS[1].requiredRugs > rugsLeft && TIERS[2].requiredRugs > rugsLeft, 'known limit: only tier 1 is reachable with the current 4-rug catalogue');
  }
}

main().then(() => {
  console.log(`\nUPGRADE PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL  suite crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
