// Live (network) checks. NOT part of verify:replay, which stays offline and deterministic.
//   npm run check:live
// 1. the hosted wallet-identity icon and badge files exist over HTTPS with the right content types
//    and are byte-identical to the repository copies, and the app config points at them;
// 2. the SKR mint in the app matches Solana Mobile's published address and is a real mainnet mint.
// Read-only: it sends no transaction and uses no key.
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) bad++;
};
const get = async (url, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      return { status: r.status, type: r.headers.get('content-type') ?? '', body: Buffer.from(await r.arrayBuffer()) };
    } catch {
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  return null;
};

const cfg = readFileSync('src/chain/config.ts', 'utf8');
const uri = /IDENTITY_URI = '([^']+)'/.exec(cfg)?.[1];
const icon = /IDENTITY_ICON = '([^']+)'/.exec(cfg)?.[1];
ok(!!uri && uri.startsWith('https://') && !!icon && icon !== 'rug-hunter.png', `app config: identity ${uri} + ${icon} (HTTPS, not the Rug Hunter badge)`);
const iconUrl = `${uri}/${icon}`;
for (const [url, type, local] of [
  [iconUrl, 'image/png', 'badge/site/rugrat.png'],
  [`${uri}/rug-hunter.json`, 'application/json', 'badge/site/rug-hunter.json'],
  [`${uri}/rug-hunter.png`, 'image/png', 'badge/site/rug-hunter.png'],
]) {
  const r = await get(url);
  ok(!!r && r.status === 200 && r.type.startsWith(type), `${url} -> ${r ? `${r.status} ${r.type}` : 'unreachable'}`);
  ok(!!r && r.body.equals(readFileSync(local)), `${url} is identical to ${local}`);
  if (r && type === 'image/png') ok(r.body.slice(1, 4).toString() === 'PNG', `${url} is a real PNG (${r.body.length} bytes)`);
}
const meta = await get(`${uri}/rug-hunter.json`);
if (meta) {
  const j = JSON.parse(meta.body.toString('utf8'));
  const img = await get(j.image);
  ok(!!img && img.status === 200 && img.type.startsWith('image/'), `badge metadata image field resolves (${j.image})`);
}

const skr = /SKR_MINT = '([^']+)'/.exec(readFileSync('src/skr/config.ts', 'utf8'))?.[1];
const page = await get('https://solanamobile.com/skr');
ok(!!page && page.body.toString('utf8').includes(skr), `solanamobile.com/skr publishes the SKR mint ${skr}`);
try {
  const rpc = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [skr, { encoding: 'jsonParsed' }] }), signal: AbortSignal.timeout(30000) });
  const v = (await rpc.json()).result?.value;
  ok(v?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' && v?.data?.parsed?.info?.decimals === 6, 'the SKR mint exists on Solana mainnet (SPL Token mint, 6 decimals)');
} catch (e) {
  console.log(`WARN  could not read the mainnet mint (${e.message}); rerun later (public RPC may be rate limiting)`);
}
process.exit(bad ? 1 : 0);
