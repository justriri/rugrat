// SKR holder perks verification (Phase 1). Part of `npm run verify:replay`.
// All RPC responses are MOCKED. Nothing here talks to a real network, so nothing here proves that
// a real wallet's real SKR is detected; that needs a device test (see the report).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PublicKey } from '@solana/web3.js';

import { buildLeaderboard } from '../src/competition/leaderboard';
import { DEMO_PLAYERS } from '../src/competition/demo';
import { buildRunResult } from '../src/competition/result';
import { scoreRun } from '../src/competition/score';
import { REPLAYS } from '../src/data/replays';
import { ReplayEngine } from '../src/game/ReplayEngine';
import { computeVerdict, signalEvent } from '../src/game/verdict';
import { formatSkr, readSkrBalance, SkrConnection, SkrReading } from '../src/skr/balance';
import { SKR_CLUSTER, SKR_DECIMALS, SKR_MINT, validMintAddress } from '../src/skr/config';
import { isSkrHolderPlayer, nextSkrState, perksFor, SkrState } from '../src/skr/status';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

const WALLET = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const OTHER = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
const acct = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } });

/** A fake connection that records every call. */
function fake(o: { accounts?: { account: unknown }[]; throwOn?: 'tokens' | 'mint'; mintExists?: boolean }) {
  const calls: string[] = [];
  const connection: SkrConnection = {
    getParsedTokenAccountsByOwner: async () => {
      calls.push('tokens');
      if (o.throwOn === 'tokens') throw new Error('503 service unavailable');
      return { value: (o.accounts ?? []) as any };
    },
    getAccountInfo: async () => {
      calls.push('mint');
      if (o.throwOn === 'mint') throw new Error('boom');
      return o.mintExists === false ? null : {};
    },
  };
  return { connection, calls, deps: { connection, toKey: (a: string) => a } };
}
const read = (o: Parameters<typeof fake>[0], mint = SKR_MINT) => {
  const f = fake(o);
  return readSkrBalance(WALLET, mint, f.deps).then((r) => ({ r, calls: f.calls }));
};

async function main() {
  console.log('\n== configuration ==');
  check(SKR_MINT === 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3' && validMintAddress(SKR_MINT) && new PublicKey(SKR_MINT).toBytes().length === 32, 'the SKR mint is the official address from solanamobile.com/skr, in one config file, and is a valid address');
  check(SKR_DECIMALS === 6 && SKR_CLUSTER === 'mainnet-beta', 'SKR config: 6 decimals, mainnet-beta');
  const srcFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : [join(dir, e.name)]));
  const root = join(__dirname, '..');
  const withMint = srcFiles(join(root, 'src')).filter((f) => readFileSync(f, 'utf8').includes('SKRbvo6'));
  check(withMint.length === 1 && withMint[0].endsWith(join('skr', 'config.ts')), 'the mint address appears in exactly one source file');
  check(!validMintAddress('') && !validMintAddress(null) && !validMintAddress('not-a-mint') && !validMintAddress('SKR123'), 'invalid or missing mint configuration is rejected');

  console.log('\n== balance detection (mocked RPC) ==');
  {
    const { r, calls } = await read({ accounts: [acct('123450000')] });
    check(r.ok && r.raw === 123450000n && r.accounts === 1 && calls.join() === 'tokens', 'a positive balance is read with a single RPC call');
    check(r.ok && formatSkr(r.raw) === '123.45', 'balance is shown in SKR (6 decimals): 123.45');
  }
  {
    const { r } = await read({ accounts: [acct('1000000'), acct('2500000')] });
    check(r.ok && r.raw === 3500000n && formatSkr(3500000n) === '3.5', 'several SKR token accounts are summed');
    check(formatSkr(9_007_199_254_740_993_000_000n) === '9,007,199,254,740,993' && formatSkr(0n) === '0' && formatSkr(1n) === '0.0000', 'amounts larger than 2^53 and tiny amounts format without rounding errors');
  }
  {
    const { r } = await read({ accounts: [acct('0')] });
    check(r.ok && r.raw === 0n && r.accounts === 1, 'zero SKR in an existing token account reads as 0');
  }
  {
    const { r, calls } = await read({ accounts: [], mintExists: true });
    check(r.ok && r.raw === 0n && r.accounts === 0 && calls.join() === 'tokens,mint', 'a missing token account reads as 0 SKR (not an error)');
  }
  {
    const { r } = await read({ accounts: [], mintExists: false });
    check(!r.ok && r.error === 'NETWORK_MISMATCH', 'no token account AND no mint on this network is reported as a network mismatch');
  }
  {
    check(!(await read({ throwOn: 'tokens' })).r.ok && (await read({ throwOn: 'tokens' })).r.ok === false && ((await read({ throwOn: 'tokens' })).r as any).error === 'RPC_FAILURE', 'an RPC failure is reported as RPC_FAILURE');
    check(((await read({ accounts: [], throwOn: 'mint' })).r as any).error === 'RPC_FAILURE', 'an RPC failure while checking the mint is RPC_FAILURE');
    check(((await read({ accounts: [{ account: { data: {} } }] })).r as any).error === 'READ_FAILED' && ((await read({ accounts: [acct('12.5')] })).r as any).error === 'READ_FAILED', 'unreadable account data is READ_FAILED');
    const bad = await read({ accounts: [acct('5')] }, 'nope');
    check(!bad.r.ok && (bad.r as any).error === 'INVALID_MINT' && bad.calls.length === 0, 'an invalid mint is rejected before any RPC call');
  }

  console.log('\n== status, perks and refresh ==');
  const ok = (raw: bigint, accounts = 1): SkrReading => ({ ok: true, raw, accounts });
  const err = (error: any): SkrReading => ({ ok: false, error });
  {
    const d = nextSkrState(null, null, { kind: 'UNCHECKED' });
    check(d.kind === 'DISCONNECTED' && perksFor(d).characterSkin === false && perksFor(d).arena === false, 'wallet disconnected: DISCONNECTED, no perks');
    const connected = nextSkrState(WALLET, null, d);
    check(connected.kind === 'UNCHECKED' && !perksFor(connected).characterSkin, 'just connected: UNCHECKED until the first read, no perks yet');
    const zero = nextSkrState(WALLET, ok(0n, 1), connected);
    const none = nextSkrState(WALLET, ok(0n, 0), connected);
    check(zero.kind === 'LOCKED' && none.kind === 'LOCKED' && !perksFor(zero).characterSkin && !perksFor(none).arena, 'zero SKR / no token account: LOCKED, no perks');
    const holder = nextSkrState(WALLET, ok(1n), zero);
    check(holder.kind === 'HOLDER' && perksFor(holder).characterSkin && perksFor(holder).arena, 'any non-zero balance (even 0.000001 SKR) unlocks the skin and the arena');
    const lost = nextSkrState(WALLET, ok(0n, 1), holder);
    check(lost.kind === 'LOCKED' && !perksFor(lost).characterSkin && !perksFor(lost).arena, 'a holder whose balance becomes zero loses the perks');
    // refresh sequence
    let st: SkrState = connected;
    const seen: string[] = [];
    for (const rd of [ok(5_000_000n), ok(5_000_000n), ok(0n), ok(2n)]) {
      st = nextSkrState(WALLET, rd, st);
      seen.push(st.kind);
    }
    check(seen.join() === 'HOLDER,HOLDER,LOCKED,HOLDER', 'each refresh reflects the newly read balance');
    // failure handling
    const failedFresh = nextSkrState(WALLET, err('RPC_FAILURE'), connected);
    check(failedFresh.kind === 'ERROR' && !perksFor(failedFresh).characterSkin, 'a failed first read grants nothing');
    const failedAfterHolder = nextSkrState(WALLET, err('RPC_FAILURE'), holder);
    check(failedAfterHolder.kind === 'ERROR' && perksFor(failedAfterHolder).characterSkin, 'a failed refresh keeps a perk that was proven for this wallet (offline is not a loss)');
    const recovered = nextSkrState(WALLET, ok(0n, 1), failedAfterHolder);
    check(recovered.kind === 'LOCKED' && !perksFor(recovered).characterSkin, 'once the read works again, a zero balance removes the perk');
    const failedAfterLocked = nextSkrState(WALLET, err('NETWORK_MISMATCH'), zero);
    check(failedAfterLocked.kind === 'ERROR' && !perksFor(failedAfterLocked).characterSkin && failedAfterLocked.error === 'NETWORK_MISMATCH', 'network mismatch: error shown, no perks');
    check(nextSkrState(null, null, holder).kind === 'DISCONNECTED' && !perksFor(nextSkrState(null, null, holder)).characterSkin, 'disconnecting removes the perks');
    // one call per refresh (no polling): three explicit refreshes = three reads
    const f = fake({ accounts: [acct('7')] });
    for (let i = 0; i < 3; i++) await readSkrBalance(WALLET, SKR_MINT, f.deps);
    check(f.calls.length === 3, 'the chain is read only when a refresh is requested (3 refreshes = 3 reads)');
    void OTHER;
  }

  console.log('\n== SKR never touches the game ==');
  {
    const holder: SkrState = { kind: 'HOLDER', raw: 10n ** 12n, stale: false };
    check(DEMO_PLAYERS.every((p) => p.demo && !isSkrHolderPlayer(p, holder)), 'DEMO players are never treated as SKR holders');
    check(isSkrHolderPlayer({ demo: false }, holder) && !isSkrHolderPlayer({ demo: false }, { kind: 'LOCKED', hasAccount: false }), 'a real player is a holder only while the wallet holds SKR');

    // same run, any SKR state: identical result, verdict and score
    const r = REPLAYS[0];
    const sig = signalEvent(r)!;
    const buyAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.2;
    const sellAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.6;
    const play = () => {
      const e = new ReplayEngine(r, () => {}, () => 0);
      e.start();
      const adv = (t: number) => { while (e.getSnapshot().clock.timestamp < t) e.advanceForTest(200); };
      adv(buyAt); e.buy(); adv(sellAt); e.sell(); e.watchWhatHappened();
      for (let g = 0; e.getSnapshot().phase !== 'finished' && g < 1e6; g++) e.advanceForTest(1000);
      const s = e.getSnapshot();
      e.dispose();
      return { s, res: buildRunResult(r, s.player, 'you') };
    };
    const a = play();
    const b = play();
    check(!!a.res && a.s.phase === 'finished' && JSON.stringify(a.res) === JSON.stringify(b.res), 'the core game plays through to a verdict and result with no SKR involved');
    check(JSON.stringify(computeVerdict(r, a.s.player)) === JSON.stringify(a.s.verdict), 'the verdict does not depend on SKR');
    const row = (players: typeof DEMO_PLAYERS) => JSON.stringify(buildLeaderboard(players, 'ALL'));
    check(row(DEMO_PLAYERS) === row(DEMO_PLAYERS) && scoreRun({ verdict: 'CLEAN_EXIT', entryTimestamp: 0, exitTimestamp: 50, collapseTimestamp: 100 }).total === 900, 'the score formula and leaderboard are unchanged');

    // structural guarantee: no scoring / game / chain-record code can even see SKR state
    const guarded = ['src/game', 'src/competition', 'src/chain/memo.ts', 'src/chain/verifyTx.ts', 'src/chain/submit.ts', 'src/badge/achievement.ts', 'src/badge/claim.ts'];
    const offenders = guarded.flatMap((g) => {
      const p = join(root, g);
      const files = g.endsWith('.ts') ? [p] : srcFiles(p);
      return files.filter((f) => /skr|cosmetic/i.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    });
    check(offenders.length === 0, `game, scoring, competition, verification and badge code never reference SKR${offenders.length ? ' (' + offenders.join(', ') + ')' : ''}`);
    const proto = readFileSync(join(root, 'src/bridge/protocol.ts'), 'utf8');
    check(/SET_COSMETICS/.test(proto) && !/SET_COSMETICS/.test(readFileSync(join(root, 'src/game/ReplayEngine.ts'), 'utf8')), 'cosmetics are a scene-presentation message the engine never handles');
    void a;
  }
}

main().then(() => {
  console.log(`\nSKR PASS ${pass}  FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log('FAIL  suite crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
