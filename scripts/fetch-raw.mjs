// Step 1 of the data pipeline: Historical API -> raw JSON on disk.
//   node scripts/fetch-raw.mjs --mint <mint> --from <ISO> --to <ISO> --interval 1_SECOND --out data/raw/x.json
// Source: Jupiter chart API (datapi.jup.ag), keyless, USD price candles. The response is saved
// untouched next to the request that produced it, so the processed replay can always be
// regenerated and audited offline. The game itself never calls this.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const k of ['mint', 'from', 'to', 'out']) if (!args[k]) throw new Error(`missing --${k}`);
const interval = args.interval ?? '1_MINUTE';
const fromMs = Date.parse(args.from);
const toMs = Date.parse(args.to);

const url =
  `https://datapi.jup.ag/v2/charts/${args.mint}?interval=${interval}&baseAsset=${args.mint}` +
  `&from=${fromMs}&to=${toMs}&candles=1000&type=price`;

const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const body = await res.json();
if (!Array.isArray(body.candles)) throw new Error('unexpected response shape');
if (body.candles.length >= 1000) throw new Error('hit the 1000-candle cap: narrow the window or page it');

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(
  args.out,
  JSON.stringify(
    { source: 'Jupiter chart API', url, fetchedAt: new Date().toISOString(), mint: args.mint, interval, candles: body.candles },
    null,
    1,
  ),
);
console.log(`saved ${body.candles.length} candles -> ${args.out}`);
