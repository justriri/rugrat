// Data pipeline step 1e: complete LIBRA trade history for a defined candidate set of wallets.
//   node scripts/fetch-wallets.mjs
// Candidates are chosen mechanically from the downloaded tape (written to data/raw/candidates.json
// so the choice is auditable):
//   A. the 60 largest buyers (USD) before 22:35 UTC   -> "early buyers"
//   B. the 60 largest sellers (USD) in the tape         -> "largest sellers"
//   C. every wallet with a single trade >= $500,000      -> "large single trade"
//   D. every wallet that received LIBRA directly from the dev wallet (from dev.json)
// For each candidate the whole history is fetched through the keyless Jupiter trades API with its
// traderAddress filter, so rules that need a wallet's full buy/sell record are computed from
// complete data, not from whichever part of the tape happened to download.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const MINT = 'Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU';
const LIBRA = MINT;
const DEV = 'DefcyKc4yAjRsCLZjdxWuSUzVohXtLna9g22y3pBCm2z';
const END = Date.parse('2025-02-15T00:00:00Z');
const MAX_PAGES = 200;
const WORKERS = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync('data/raw/wallets', { recursive: true });

// ---- candidate selection ---------------------------------------------------------------------
const buy = new Map();
const sell = new Map();
const maxTrade = new Map();
const seen = new Set();
for (const f of readdirSync('data/raw/trades').filter((n) => n.endsWith('.jsonl'))) {
  for (const line of readFileSync(`data/raw/trades/${f}`, 'utf8').split('\n')) {
    if (!line) continue;
    const t = JSON.parse(line);
    const k = t.actionId + t.txHash;
    if (seen.has(k)) continue;
    seen.add(k);
    const w = t.traderAddress;
    maxTrade.set(w, Math.max(maxTrade.get(w) ?? 0, t.usdVolume));
    if (t.type === 'buy' && t.timestamp < '2025-02-14T22:35') buy.set(w, (buy.get(w) ?? 0) + t.usdVolume);
    if (t.type === 'sell') sell.set(w, (sell.get(w) ?? 0) + t.usdVolume);
  }
}
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
const candidates = new Map();
const add = (w, why) => candidates.set(w, [...(candidates.get(w) ?? []), why]);
for (const w of top(buy, 60)) add(w, 'early-buyer');
for (const w of top(sell, 60)) add(w, 'largest-seller');
for (const [w, v] of maxTrade) if (v >= 500_000) add(w, 'large-single-trade');

const dev = JSON.parse(readFileSync('data/raw/onchain/dev.json', 'utf8'));
const infra = new Set(JSON.parse(readFileSync('data/raw/libra.holders.json', 'utf8')).holders.filter((h) => h.tags?.length).map((h) => h.address));
for (const tx of Object.values(dev.txs)) {
  if (!tx) continue;
  const d = new Map();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === LIBRA) d.set(b.owner, (d.get(b.owner) ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
  for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === LIBRA) d.set(b.owner, (d.get(b.owner) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
  if ((d.get(DEV) ?? 0) < -1) for (const [o, v] of d) if (o !== DEV && v > 1 && !infra.has(o)) add(o, 'dev-direct-recipient');
}
writeFileSync('data/raw/candidates.json', JSON.stringify({ selectedFrom: `${seen.size} unique tape trades`, count: candidates.size, wallets: Object.fromEntries(candidates) }, null, 1));
console.log(`candidates: ${candidates.size}`);

// ---- fetch each candidate's history ------------------------------------------------------------
async function getPage(wallet, offset) {
  const url = `https://datapi.jup.ag/v1/txs/${MINT}?dir=asc&traderAddress=${wallet}${offset ? `&offset=${offset}` : ''}`;
  for (let a = 0; ; a++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.status === 429) { await sleep(4000 * (a + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (a > 8) throw e;
      await sleep(1500 * (a + 1));
    }
  }
}

async function fetchWallet(w) {
  const file = `data/raw/wallets/${w}.jsonl`;
  if (existsSync(`${file}.done`)) return 0;
  let offset = existsSync(`${file}.cursor`) ? readFileSync(`${file}.cursor`, 'utf8') : '';
  let n = 0;
  for (let p = 0; p < MAX_PAGES; p++) {
    const body = await getPage(w, offset);
    const rows = [];
    let stop = !body.txs?.length;
    for (const t of body.txs ?? []) {
      if (t.actionId === offset) continue;
      if (Date.parse(t.timestamp) >= END) { stop = true; break; }
      if (t.traderAddress === w) rows.push(t);
    }
    if (rows.length) { appendFileSync(file, rows.map((t) => JSON.stringify(t)).join('\n') + '\n'); n += rows.length; }
    if (stop || !body.next) break;
    offset = body.next;
    writeFileSync(`${file}.cursor`, offset);
    await sleep(250);
  }
  writeFileSync(`${file}.done`, 'ok');
  return n;
}

const queue = [...candidates.keys()];
let done = 0;
await Promise.all(Array.from({ length: WORKERS }, async () => {
  while (queue.length) {
    const w = queue.shift();
    const n = await fetchWallet(w);
    if (++done % 10 === 0) console.log(`wallets ${done}/${candidates.size} (last ${w.slice(0, 5)} ${n} trades)`);
  }
}));
console.log('ALL DONE');
