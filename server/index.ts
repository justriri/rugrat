// Rugrat issuer backend. A small, dependency-free HTTP service (Node's http module).
//
//   POST /v1/upgrade/prepare  { wallet, tier }  -> an atomic, partially-signed upgrade transaction
//   POST /v1/upgrade/owned    { wallet }          -> tiers this wallet already owns
//   GET  /health
//
// It holds the issuer key (the Core collection's update authority) and decides eligibility itself
// by reading the chain; it never trusts the client. It has NO payout code. Configure with env vars
// (see server/README.md); it refuses to start unless every one is set.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { createServer, IncomingMessage } from 'node:http';

import { REPLAYS } from '../src/data/replays';
import { fetchVerifiedRuns } from '../src/chain/verifyTx';
import { IssuerConfig, IssuerDeps, prepareUpgrade, tierAssetKeypair } from '../src/upgrade/issuer';
import { SKR_MINT } from '../src/skr/config';
import { TIERS } from '../src/upgrade/tiers';

function need(name: string): string {
  const v = process.env[name];
  if (!v || /REPLACE|CHANGEME/i.test(v)) {
    console.error(`Missing or placeholder env var ${name}. See server/README.md.`);
    process.exit(1);
  }
  return v;
}

const rpcUrl = need('RPC_URL');
const cfg: IssuerConfig = {
  issuer: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need('ISSUER_KEYPAIR_FILE'), 'utf8')))),
  collection: need('COLLECTION'),
  paymentMint: need('PAYMENT_MINT'),
  paymentDecimals: Number(process.env.PAYMENT_DECIMALS ?? 6),
  treasury: need('TREASURY'),
  assetSecret: need('ASSET_SECRET'),
  rpcUrl,
  replays: REPLAYS,
};
if (/mainnet/i.test(rpcUrl) && cfg.paymentMint !== SKR_MINT) {
  console.error('Refusing to start: on mainnet the payment token must be the SKR mint.');
  process.exit(1);
}
const conn = new Connection(rpcUrl, 'confirmed');
const deps: IssuerDeps = {
  fetchVerifiedRuns: (wallet) => fetchVerifiedRuns(conn as any, new PublicKey(wallet), wallet, REPLAYS),
  accountExists: async (address) => (await conn.getAccountInfo(new PublicKey(address), 'confirmed')) !== null,
  latestBlockhash: () => conn.getLatestBlockhash('confirmed'),
};

// tiny per-IP rate limit: 20 requests / minute
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 20;
}

async function body(req: IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('too large');
  }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  try {
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (limited(req.socket.remoteAddress ?? '?')) return send(429, { ok: false, message: 'Too many requests.' });
    if (req.method === 'POST' && req.url === '/v1/upgrade/prepare') {
      const b = await body(req);
      const out = await prepareUpgrade(cfg, deps, { wallet: b.wallet, tier: b.tier });
      return send(out.ok ? 200 : out.code === 'BAD_REQUEST' ? 400 : out.code === 'UNAVAILABLE' ? 503 : 409, out);
    }
    if (req.method === 'POST' && req.url === '/v1/upgrade/owned') {
      const b = await body(req);
      if (typeof b.wallet !== 'string') return send(400, { ok: false, message: 'Invalid request.' });
      const owned: number[] = [];
      for (const t of TIERS) if (await deps.accountExists(tierAssetKeypair(cfg.assetSecret, b.wallet, t.tier).publicKey.toBase58())) owned.push(t.tier);
      return send(200, { ok: true, owned });
    }
    send(404, { ok: false, message: 'Not found.' });
  } catch {
    send(400, { ok: false, message: 'Bad request.' });
  }
}).listen(Number(process.env.PORT ?? 8787), () => console.log('Rugrat issuer listening'));
