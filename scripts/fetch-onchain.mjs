// Data pipeline step 1c: a wallet's transactions in a time window -> data/raw/onchain/<name>.json
//   node scripts/fetch-onchain.mjs --name dev --wallet <addr> --from <ISO> --to <ISO>
// Source: Solana public RPC (api.mainnet-beta.solana.com, keyless, archival). Transactions are
// saved exactly as the RPC returns them (jsonParsed), keyed by signature, so every derived event
// can be traced to a transaction. Re-running reuses already-downloaded transactions.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
for (const k of ['name', 'wallet', 'from', 'to']) if (!args[k]) throw new Error(`missing --${k}`);
const RPC = 'https://api.mainnet-beta.solana.com';
const from = Date.parse(args.from) / 1000;
const to = Date.parse(args.to) / 1000;
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

const file = `data/raw/onchain/${args.name}.json`;
mkdirSync('data/raw/onchain', { recursive: true });
const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { wallet: args.wallet, txs: {} };

// 1) signatures newest -> oldest, until we pass the start of the window
const sigs = [];
let before;
for (;;) {
  const page = await rpc('getSignaturesForAddress', [args.wallet, { limit: 1000, ...(before ? { before } : {}) }]);
  if (!page.length) break;
  sigs.push(...page);
  before = page[page.length - 1].signature;
  if (page[page.length - 1].blockTime < from) break;
}
const inWindow = sigs.filter((s) => s.blockTime >= from && s.blockTime < to && !s.err);
console.log(`${args.name}: ${sigs.length} signatures scanned, ${inWindow.length} successful in window`);

// 2) full parsed transactions (cached)
let n = 0;
for (const s of inWindow) {
  if (!cache.txs[s.signature]) {
    cache.txs[s.signature] = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (++n % 20 === 0) { console.log(`  fetched ${n}`); writeFileSync(file, JSON.stringify(cache)); }
    await sleep(120);
  }
}
cache.window = { from: args.from, to: args.to, signatures: inWindow.map((s) => s.signature) };
cache.fetchedAt = new Date().toISOString();
cache.source = `${RPC} getSignaturesForAddress/getTransaction (jsonParsed)`;
writeFileSync(file, JSON.stringify(cache));
console.log(`saved ${Object.keys(cache.txs).length} transactions -> ${file}`);
