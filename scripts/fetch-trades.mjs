// Data pipeline step 1b: every LIBRA trade in a time window -> data/raw/trades/chunk-NNN.jsonl.
//   node scripts/fetch-trades.mjs --mint <mint> --from <ISO> --to <ISO> --slot0 <slot> --time0 <ISO>
// Source: Jupiter token-trades API (datapi.jup.ag/v1/txs), keyless. Trades are paged by actionId,
// which is (solana slot * 1e9 + n), so the window is split into slot chunks fetched in parallel.
// Each chunk file is resumable (re-run continues). Lines are trades exactly as served.
// The game never calls this API.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []),
);
for (const k of ['mint', 'from', 'to', 'slot0', 'time0']) if (!args[k]) throw new Error(`missing --${k}`);
const DIR = args.dir ?? 'data/raw/trades';
const WORKERS = Number(args.workers ?? 8);
const CHUNKS = Number(args.chunks ?? 48);
const toMs = Date.parse(args.to);
const slot0 = Number(args.slot0);
const t0 = Date.parse(args.time0) / 1000;
// slot ~ every 0.4s; only used to place chunk boundaries (chunks overlap-free by actionId).
const slotAt = (iso) => Math.round(slot0 + (Date.parse(iso) / 1000 - t0) / 0.4);
const startSlot = slotAt(args.from);
const endSlot = slotAt(args.to) + 4000; // margin; the time check below is the real stop
const size = Math.ceil((endSlot - startSlot) / CHUNKS);
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const E9 = 1_000_000_000n;
let pages = 0;
let trades = 0;

async function getPage(offset) {
  const url = `https://datapi.jup.ag/v1/txs/${args.mint}?dir=asc&offset=${offset}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt > 10) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function doChunk(n) {
  const file = `${DIR}/chunk-${String(n).padStart(3, '0')}.jsonl`;
  const doneFile = `${file}.done`;
  if (existsSync(doneFile)) return;
  const lo = BigInt(startSlot + n * size) * E9;
  const hi = BigInt(startSlot + (n + 1) * size) * E9;
  let offset = existsSync(`${file}.cursor`) ? BigInt(readFileSync(`${file}.cursor`, 'utf8')) : lo;
  let first = true;
  for (;;) {
    const body = await getPage(offset.toString());
    const txs = body.txs ?? [];
    pages++;
    const rows = [];
    let stop = txs.length === 0;
    for (const t of txs) {
      const id = BigInt(t.actionId);
      if (!first && id === offset) continue; // cursor row repeats the previous page's next
      if (id >= hi || Date.parse(t.timestamp) >= toMs) { stop = true; break; }
      if (id >= lo) rows.push(t);
    }
    first = false;
    if (rows.length) { appendFileSync(file, rows.map((t) => JSON.stringify(t)).join('\n') + '\n'); trades += rows.length; }
    if (stop || !body.next) break;
    offset = BigInt(body.next);
    writeFileSync(`${file}.cursor`, offset.toString());
  }
  writeFileSync(doneFile, 'ok');
  console.log(`chunk ${n} done (${new Date().toISOString().slice(11, 19)}) pages=${pages} trades=${trades}`);
}

const queue = Array.from({ length: CHUNKS }, (_, i) => i);
if (args.reverse) queue.reverse(); // a second process can work from the other end of the window
await Promise.all(Array.from({ length: WORKERS }, async () => { while (queue.length) await doChunk(queue.shift()); }));
console.log(`ALL DONE: ${trades} new trades in ${pages} pages`);
