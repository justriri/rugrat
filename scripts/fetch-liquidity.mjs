// Data pipeline step 1f: localise large pool-reserve drops to the transactions that caused them.
//   node scripts/fetch-liquidity.mjs
// Reads data/raw/onchain/pool-reserve.json (USDC reserve sampled every ~30s). For every interval
// where the reserve falls by more than DROP_USD, it lists every transaction that touched the pool's
// USDC vault between the two samples (Solana public RPC), fetches them, and keeps those whose logs
// contain a liquidity instruction (RemoveLiquidity*, ClaimFee, ClosePosition...) or whose vault
// balance changes by more than BIG_USD. Output is raw, with the instruction logs, in
// data/raw/onchain/liquidity-candidates.json; scripts/build-liquidity.ts turns it into events.
import { readFileSync, writeFileSync } from 'node:fs';

const VAULT = '3nSdqiF5Cxd22r8h6Ti1TwzDmcVN6SgFfDcWbBtCFRdc';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DROP_USD = Number(process.env.DROP_USD ?? 9_000_000);
const BIG_USD = 1_000_000;
const RPC = 'https://api.mainnet-beta.solana.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (r.status === 429) { await sleep(1500 * (a + 1)); continue; }
      const j = await r.json();
      if (j.error) { if (/rate|limit|429|too many/i.test(JSON.stringify(j.error))) { await sleep(1500 * (a + 1)); continue; } throw new Error(JSON.stringify(j.error)); }
      return j.result;
    } catch (e) { if (a > 8) throw e; await sleep(1000 * (a + 1)); }
  }
}

const { samples } = JSON.parse(readFileSync('data/raw/onchain/pool-reserve.json', 'utf8'));
const intervals = [];
for (let i = 1; i < samples.length; i++) {
  const drop = samples[i - 1].reservePost - samples[i].reservePost;
  if (drop > DROP_USD) intervals.push({ from: samples[i - 1], to: samples[i], drop });
}
console.log(`${samples.length} samples, ${intervals.length} intervals with a reserve drop > $${DROP_USD}`);

const found = [];
for (const iv of intervals) {
  // all transactions touching the vault strictly between the two sampled transactions
  const sigs = [];
  let before = iv.to.txHash;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [VAULT, { limit: 1000, before, until: iv.from.txHash }]);
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  sigs.push({ signature: iv.to.txHash, blockTime: iv.to.blockTime });
  console.log(`interval ${iv.from.timestamp.slice(11, 19)} -> ${iv.to.timestamp.slice(11, 19)}: drop $${Math.round(iv.drop).toLocaleString()}, ${sigs.length} vault transactions`);
  for (const s of sigs) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx || tx.meta?.err) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const idx = keys.indexOf(VAULT);
    const pre = (tx.meta.preTokenBalances ?? []).find((b) => b.accountIndex === idx && b.mint === USDC);
    const post = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === idx && b.mint === USDC);
    if (!pre || !post) continue;
    const delta = Number(post.uiTokenAmount.uiAmount) - Number(pre.uiTokenAmount.uiAmount);
    const logs = (tx.meta.logMessages ?? []).filter((l) => /Instruction: /.test(l)).map((l) => l.split('Instruction: ')[1]);
    const liquidityIx = logs.filter((l) => /RemoveLiquidity|ClaimFee|ClosePosition|RemoveAllLiquidity|ClaimReward|WithdrawIneligibleReward/.test(l));
    if (liquidityIx.length || Math.abs(delta) > BIG_USD) {
      found.push({ signature: s.signature, blockTime: tx.blockTime, slot: tx.slot, payer: keys[0], vaultUsdcDelta: delta, liquidityInstructions: [...new Set(liquidityIx)], allInstructions: [...new Set(logs)].slice(0, 8), interval: { from: iv.from.timestamp, to: iv.to.timestamp, reserveDrop: iv.drop } });
    }
    await sleep(80);
  }
}
writeFileSync('data/raw/onchain/liquidity-candidates.json', JSON.stringify({ vault: VAULT, dropThresholdUsd: DROP_USD, bigThresholdUsd: BIG_USD, source: `${RPC} getSignaturesForAddress/getTransaction`, fetchedAt: new Date().toISOString(), intervals: intervals.length, found }, null, 1));
console.log(`saved ${found.length} liquidity-related transactions`);
