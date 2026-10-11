// Data pipeline step 1d: LIBRA/USDC pool USDC reserve over time -> data/raw/onchain/pool-reserve.json
//   node scripts/fetch-reserve.mjs
// For one swap transaction every 30s (taken from the downloaded trade tape) we read the pool's USDC
// vault balance straight from the transaction's postTokenBalances (Solana public RPC). A reserve
// that falls by far more than the swaps explain means liquidity left the pool; the analysis step
// then localises it to a transaction. Samples are saved raw so the analysis is reproducible.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const POOL = 'BzzMNvfm7T6zSGFeLXzERmRxfKaNLdo4fSzvsisxcSzz';
const VAULT = '3nSdqiF5Cxd22r8h6Ti1TwzDmcVN6SgFfDcWbBtCFRdc'; // pool's USDC reserve account
const FROM = Date.parse('2025-02-14T22:25:00Z');
const TO = Date.parse('2025-02-15T00:00:00Z');
const STEP = 30_000;
const OUT = 'data/raw/onchain/pool-reserve.json';
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

// one pool trade per 30s: ask the trades API for the first trades after a slot estimate for that
// time (actionId = slot * 1e9 + n), and take the first trade on the main pool.
const MINT = 'Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU';
const SLOT0 = 320684409;
const T0 = Date.parse('2025-02-14T22:01:00Z') / 1000;
const picks = [];
for (let ms = FROM; ms < TO; ms += STEP) {
  const slot = Math.round(SLOT0 + (ms / 1000 - T0) / 0.4);
  const url = `https://datapi.jup.ag/v1/txs/${MINT}?dir=asc&offset=${BigInt(slot) * 1000000000n}`;
  let page;
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (r.status === 429) { console.log(`rate limited at ${new Date(ms).toISOString().slice(11, 19)}, waiting`); await sleep(Math.min(15000, 3000 * (a + 1))); continue; }
      page = await r.json();
      break;
    } catch (e) {
      if (a > 8) throw e;
      await sleep(1500 * (a + 1));
    }
  }
  const t = (page.txs ?? []).find((x) => x.poolId === POOL);
  if (t) picks.push(t);
  if (picks.length % 20 === 0) console.log(`picked ${picks.length} (at ${new Date(ms).toISOString().slice(11, 19)})`);
  await sleep(400);
}
console.log(`picked ${picks.length} pool trades`);
const buckets = new Map(picks.map((t, i) => [i, t]));

const saved = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { pool: POOL, vault: VAULT, samples: [] };
const have = new Set(saved.samples.map((s) => s.txHash));
let n = 0;
for (const [, t] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
  if (have.has(t.txHash)) continue;
  const tx = await rpc('getTransaction', [t.txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (!tx) continue;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const post = (tx.meta.postTokenBalances ?? []).find((b) => keys[b.accountIndex] === VAULT);
  const pre = (tx.meta.preTokenBalances ?? []).find((b) => keys[b.accountIndex] === VAULT);
  if (!post || !pre) continue;
  saved.samples.push({
    timestamp: t.timestamp,
    blockTime: tx.blockTime,
    slot: tx.slot,
    txHash: t.txHash,
    actionId: t.actionId,
    reservePre: Number(pre.uiTokenAmount.uiAmount),
    reservePost: Number(post.uiTokenAmount.uiAmount),
  });
  if (++n % 25 === 0) { console.log(`sampled ${n}`); writeFileSync(OUT, JSON.stringify(saved)); }
  await sleep(100);
}
saved.samples.sort((a, b) => BigInt(a.actionId) < BigInt(b.actionId) ? -1 : 1);
saved.source = `${RPC} getTransaction (jsonParsed), postTokenBalances of the pool USDC vault`;
saved.fetchedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(saved));
console.log(`saved ${saved.samples.length} reserve samples -> ${OUT}`);
