// Per-rug data fetch. Usage: node scripts/rugs/fetch-rug.mjs <slug> [--only=asset,candles,dev,tape,wallets]
// Reads data/rugs/<slug>/config.json and writes everything it downloads, untouched, to
// data/rugs/<slug>/raw/. Sources (all keyless):
//   - Jupiter asset/holders/chart/trades APIs (datapi.jup.ag): token identity + logo, price candles,
//     trades (with trader, tx hash, USD and SOL volume);
//   - Solana public RPC (api.mainnet-beta.solana.com, archival): the creator wallet's transactions.
// The game never calls any of this: the build step turns the saved raw data into the replay JSON.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const slug = process.argv[2];
if (!slug) throw new Error('usage: fetch-rug.mjs <slug>');
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? 'asset,candles,dev,tape,wallets').split(',');
const cfg = JSON.parse(readFileSync(`data/rugs/${slug}/config.json`, 'utf8'));
const RAW = `data/rugs/${slug}/raw`;
mkdirSync(`${RAW}/wallets`, { recursive: true });
const UA = { 'user-agent': 'Mozilla/5.0' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fromMs = Date.parse(cfg.window.from);
const toMs = Date.parse(cfg.window.to);
const E9 = 1_000_000_000n;

async function jget(url) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(Math.min(15000, 3000 * (a + 1))); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (a > 8) throw e;
      await sleep(1500 * (a + 1));
    }
  }
}
const RPC = 'https://api.mainnet-beta.solana.com';
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

// ---------------------------------------------------------------- 1. token identity
let asset;
if (only.includes('asset')) {
  const found = (await jget(`https://datapi.jup.ag/v1/assets/search?query=${cfg.mint}`)).find((x) => x.id === cfg.mint);
  if (!found) throw new Error('mint not found in Jupiter assets');
  asset = found;
  writeFileSync(`${RAW}/asset.json`, JSON.stringify(found, null, 1));
  writeFileSync(`${RAW}/holders.json`, JSON.stringify(await jget(`https://datapi.jup.ag/v1/holders/${cfg.mint}`)));
  console.log(`asset: ${found.symbol} | ${found.name} | dev ${found.dev} | icon ${found.icon ? 'yes' : 'NO'}`);
} else asset = JSON.parse(readFileSync(`${RAW}/asset.json`, 'utf8'));

// ---------------------------------------------------------------- 2. price candles
if (only.includes('candles')) {
  const url = `https://datapi.jup.ag/v2/charts/${cfg.mint}?interval=${cfg.priceInterval}&baseAsset=${cfg.mint}&from=${fromMs}&to=${toMs}&candles=1000&type=price`;
  const body = await jget(url);
  if (!Array.isArray(body.candles)) throw new Error('unexpected candle response');
  if (body.candles.length >= 1000) throw new Error('hit the 1000-candle cap: narrow the window or use a wider interval');
  writeFileSync(`${RAW}/candles.json`, JSON.stringify({ source: 'Jupiter chart API (datapi.jup.ag/v2/charts)', url, fetchedAt: new Date().toISOString(), interval: cfg.priceInterval, candles: body.candles }, null, 1));
  console.log(`candles: ${body.candles.length} (${cfg.priceInterval})`);
}

// ---------------------------------------------------------------- 3. creator wallet, on-chain
if (only.includes('dev')) {
  const dev = asset.dev;
  const from = Math.floor(fromMs / 1000) - (cfg.devOnchain?.lookbackSec ?? 3 * 3600);
  const to = Math.floor(toMs / 1000);
  const cap = cfg.devOnchain?.txCap ?? 300;
  const sigs = [];
  let before;
  for (;;) {
    const page = await rpc('getSignaturesForAddress', [dev, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!page.length) break;
    sigs.push(...page);
    before = page[page.length - 1].signature;
    if (page[page.length - 1].blockTime < from) break;
  }
  const inWindow = sigs.filter((s) => s.blockTime >= from && s.blockTime < to && !s.err);
  console.log(`dev ${dev.slice(0, 8)}: ${sigs.length} signatures scanned, ${inWindow.length} successful in window (fetching up to ${cap})`);
  const file = `${RAW}/dev.json`;
  const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { wallet: dev, txs: {} };
  let n = 0;
  for (const s of inWindow.slice(0, cap)) {
    if (cache.txs[s.signature]) continue;
    cache.txs[s.signature] = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (++n % 25 === 0) { writeFileSync(file, JSON.stringify(cache)); console.log(`  dev txs ${n}`); }
    await sleep(90);
  }
  cache.window = { from, to, scanned: sigs.length, inWindow: inWindow.length, fetchedCap: cap };
  cache.source = `${RPC} getSignaturesForAddress/getTransaction (jsonParsed)`;
  cache.fetchedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(cache));
  console.log(`dev: saved ${Object.keys(cache.txs).length} transactions`);
}

// ---------------------------------------------------------------- 4. sampled trade tape
// Trades are paged by actionId = slot * 1e9 + n. We aim at a slot for each sample time, read one
// page (30 trades), and re-calibrate slot<->time from what comes back, so the estimate never drifts.
if (only.includes('tape')) {
  const first = await jget(`https://datapi.jup.ag/v1/txs/${cfg.mint}?dir=asc`);
  let refSlot = Number(BigInt(first.txs[0].actionId) / E9);
  let refTime = Date.parse(first.txs[0].timestamp) / 1000;
  const step = cfg.rules.tapeSampleStepSec;
  const out = `${RAW}/tape-sample.jsonl`;
  const seen = new Set();
  if (existsSync(out)) for (const l of readFileSync(out, 'utf8').split('\n')) if (l) seen.add(JSON.parse(l).actionId);
  let t = fromMs / 1000;
  let pages = 0;
  while (t < toMs / 1000) {
    let page;
    for (let iter = 0; iter < 8; iter++) {
      const slot = Math.round(refSlot + (t - refTime) * 2.5);
      page = await jget(`https://datapi.jup.ag/v1/txs/${cfg.mint}?dir=asc&offset=${BigInt(slot) * E9}`);
      const got = page.txs?.[0];
      if (!got) break;
      const gotT = Date.parse(got.timestamp) / 1000;
      refSlot = Number(BigInt(got.actionId) / E9);
      refTime = gotT;
      if (Math.abs(gotT - t) < Math.max(20, step)) break;
    }
    pages++;
    const fresh = (page.txs ?? []).filter((x) => !seen.has(x.actionId) && Date.parse(x.timestamp) >= fromMs && Date.parse(x.timestamp) < toMs);
    for (const x of fresh) seen.add(x.actionId);
    if (fresh.length) appendFileSync(out, fresh.map((x) => JSON.stringify(x)).join('\n') + '\n');
    if (pages % 25 === 0) console.log(`  tape sample: ${pages} pages, ${seen.size} trades, at ${new Date(t * 1000).toISOString().slice(11, 19)}`);
    t += step;
    await sleep(250);
  }
  console.log(`tape sample: ${seen.size} trades from ${pages} pages`);
}

// ---------------------------------------------------------------- 5. candidate wallets + complete histories
if (only.includes('wallets')) {
  const rules = cfg.rules;
  const buy = new Map();
  const sell = new Map();
  const maxTrade = new Map();
  const tapeFile = `${RAW}/tape-sample.jsonl`;
  const sampleRows = existsSync(tapeFile) ? readFileSync(tapeFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const t of sampleRows) {
    const w = t.traderAddress;
    maxTrade.set(w, Math.max(maxTrade.get(w) ?? 0, t.usdVolume));
    if (t.type === 'buy') buy.set(w, (buy.get(w) ?? 0) + t.usdVolume);
    else sell.set(w, (sell.get(w) ?? 0) + t.usdVolume);
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
  const cands = new Map();
  const add = (w, why) => cands.set(w, [...(cands.get(w) ?? []), why]);
  for (const w of top(buy, rules.candidateTopN)) add(w, 'top-sampled-buyer');
  for (const w of top(sell, rules.candidateTopN)) add(w, 'top-sampled-seller');
  for (const [w, v] of maxTrade) if (v >= rules.whaleSingleTradeUsd) add(w, 'large-single-trade');
  add(asset.dev, 'dev-wallet');
  const infra = new Set(JSON.parse(readFileSync(`${RAW}/holders.json`, 'utf8')).holders.filter((h) => h.tags?.length).map((h) => h.address));
  const devFile = `${RAW}/dev.json`;
  if (existsSync(devFile)) {
    for (const tx of Object.values(JSON.parse(readFileSync(devFile, 'utf8')).txs)) {
      if (!tx) continue;
      const d = new Map();
      for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === cfg.mint) d.set(b.owner, (d.get(b.owner) ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
      for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === cfg.mint) d.set(b.owner, (d.get(b.owner) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
      if ((d.get(asset.dev) ?? 0) < -1) for (const [o, v] of d) if (o !== asset.dev && v > 1 && !infra.has(o)) add(o, 'dev-direct-recipient');
    }
  }
  const maxRecipients = rules.maxRecipientCandidates ?? 60;
  // keep the candidate list bounded: dev recipients are numerous for some tokens
  const entries = [...cands.entries()];
  const recips = entries.filter(([, w]) => w.includes('dev-direct-recipient') && w.length === 1).slice(maxRecipients).map(([k]) => k);
  for (const k of recips) cands.delete(k);
  writeFileSync(`${RAW}/candidates.json`, JSON.stringify({ sampleTrades: sampleRows.length, count: cands.size, droppedRecipientCandidates: recips.length, wallets: Object.fromEntries(cands) }, null, 1));
  console.log(`candidates: ${cands.size} (sample of ${sampleRows.length} trades; ${recips.length} surplus dev recipients not fetched)`);

  const MAX_PAGES = rules.walletMaxPages ?? 120;
  async function fetchWallet(w) {
    const file = `${RAW}/wallets/${w}.jsonl`;
    if (existsSync(`${file}.done`)) return;
    let offset = existsSync(`${file}.cursor`) ? readFileSync(`${file}.cursor`, 'utf8') : '';
    let capped = true;
    for (let p = 0; p < MAX_PAGES; p++) {
      const body = await jget(`https://datapi.jup.ag/v1/txs/${cfg.mint}?dir=asc&traderAddress=${w}${offset ? `&offset=${offset}` : ''}`);
      const rows = [];
      let stop = !body.txs?.length;
      for (const t of body.txs ?? []) {
        if (t.actionId === offset) continue;
        if (Date.parse(t.timestamp) >= toMs + 6 * 3600e3) { stop = true; break; }
        if (t.traderAddress === w) rows.push(t);
      }
      if (rows.length) appendFileSync(file, rows.map((t) => JSON.stringify(t)).join('\n') + '\n');
      if (stop || !body.next) { capped = false; break; }
      offset = body.next;
      writeFileSync(`${file}.cursor`, offset);
      await sleep(250);
    }
    writeFileSync(`${file}.done`, capped ? 'capped' : 'ok');
  }
  const queue = [...cands.keys()];
  let done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      await fetchWallet(queue.shift());
      if (++done % 10 === 0) console.log(`  wallets ${done}/${cands.size}`);
    }
  }));
  console.log('wallet histories done');
}
console.log('fetch complete');
