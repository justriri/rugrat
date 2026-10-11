// Data pipeline step 2a: raw trades + raw on-chain transactions -> classified, timestamped events.
//   npm run build:events        (then npm run build:replay embeds them in the replay JSON)
//
// Every tag is produced by a stated, mechanical rule over data we hold locally, and every event
// keeps its evidence. Nothing here asserts intent or guilt: tags are neutral labels
// (DEV / INSIDER / SMART / WHALE / LIQUIDITY). A wallet that matches no rule stays untagged.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const LIBRA = 'Bo9jh3wsmcC2AjakLWzNmKJ3SgtZmXEcSaW7L2FAvUsU';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---- configuration (every threshold is a published rule, not a hand-picked list) -----------------
const WINDOW = (() => {
  const r = JSON.parse(read('src/data/replays/libra.json')) as { ticks: { timestamp: number }[]; rugTimestamp: number };
  return { from: r.ticks[0].timestamp, to: r.ticks[r.ticks.length - 1].timestamp, rug: r.rugTimestamp };
})();
const RULES = {
  candidates: 'see data/raw/candidates.json (top early buyers, top sellers, single trades >= $500k, direct recipients of dev supply)',
  botFilter: { maxMevTradeFraction: 0.1 }, // wallets whose trades are mostly flagged MEV are routers/bots, left untagged
  smart: { topN: 5, rankBy: 'realized profit (USD sold - USD bought)', minRealizedProfitUsd: 1_000_000, minSoldFractionOfBought: 0.8, lastSellBeforeCollapseMarker: true },
  whale: { topN: 3, rankBy: 'total USD traded inside the replay window', excludes: 'DEV, INSIDER, SMART, bots' },
  eventMinUsd: { INSIDER: 0, SMART: 250_000, WHALE: 750_000 },
};

// ---- types ----------------------------------------------------------------------------------
interface Trade {
  type: 'buy' | 'sell';
  usdVolume: number;
  nativeVolume?: number;
  traderAddress: string;
  txHash: string;
  poolId: string;
  actionId: string;
  timestamp: string;
  amount: number; // LIBRA
  isMev?: boolean;
}
interface Evidence {
  rule: string;
  detail: string;
  signatures?: string[];
}
type Tag = 'DEV' | 'INSIDER' | 'SMART' | 'WHALE' | 'LIQUIDITY';
type Action = 'BUY' | 'SELL' | 'SUPPLY_MOVE' | 'LIQUIDITY_REMOVAL';
interface Ev {
  id: string;
  timestamp: number;
  walletAddress: string;
  tag?: Tag;
  action: Action;
  amount?: number;
  amountUnit?: 'USD' | 'LIBRA';
  signature: string;
  source: string;
  classification: Evidence[];
  note?: string;
}

const short = (a: string) => `${a.slice(0, 3)}...${a.slice(-3)}`;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---- load candidate wallet histories (complete, per wallet) ---------------------------------------
// The partial bulk tape is only used by fetch-wallets.mjs to choose candidates (data/raw/candidates.json).
// Every rule below runs on each candidate's COMPLETE trade history.
const candidates = JSON.parse(read('data/raw/candidates.json')) as { selectedFrom: string; wallets: Record<string, string[]> };
const histories = new Map<string, Trade[]>();
for (const w of Object.keys(candidates.wallets)) {
  const f = resolve(ROOT, `data/raw/wallets/${w}.jsonl`);
  if (!existsSync(`${f}.done`)) throw new Error(`incomplete download for candidate ${w}: run node scripts/fetch-wallets.mjs`);
  if (!existsSync(f)) { histories.set(w, []); continue; } // fetched, zero trades
  const seenKey = new Set<string>();
  const rows: Trade[] = [];
  for (const line of readFileSync(f, 'utf8').split(String.fromCharCode(10))) {
    if (!line) continue;
    const t = JSON.parse(line) as Trade;
    const k = `${t.actionId}|${t.txHash}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    rows.push(t);
  }
  rows.sort((a, b) => (BigInt(a.actionId) < BigInt(b.actionId) ? -1 : BigInt(a.actionId) > BigInt(b.actionId) ? 1 : 0));
  histories.set(w, rows);
}
// Wallets whose fetch hit the page cap (thousands of trades: bots/routers) have an incomplete
// history, so profit-based rules cannot be applied to them. They are left untagged.
const INCOMPLETE_AT = 5_900;
const incomplete = new Set([...histories.entries()].filter(([, h]) => h.length >= INCOMPLETE_AT).map(([w]) => w));
const tape: Trade[] = [...histories.entries()].filter(([w]) => !incomplete.has(w)).flatMap(([, h]) => h);
console.log(`excluded ${incomplete.size} wallets with incomplete (capped) histories`);
console.log(`candidates: ${histories.size} wallets, ${tape.length} trades in their complete histories`);

const asset = (JSON.parse(read('data/raw/libra.asset.json')) as { dev: string; firstPool: { id: string } }[])[0];
const holders = (JSON.parse(read('data/raw/libra.holders.json')) as { holders: { address: string; tags?: { name: string }[] }[] }).holders;
const infra = new Set<string>(); // pools, vaults and locks are never classified as people
for (const h of holders) if (h.tags?.length) infra.add(h.address);
for (const t of tape) infra.add(t.poolId);
// (candidate trades only know the pools they touched; the holders list covers the rest)
const DEV = asset.dev;

// ---- DEV: Jupiter metadata + on-chain creator evidence ------------------------------------------------
const devTxs = JSON.parse(read('data/raw/onchain/dev.json')) as { txs: Record<string, any> };
const devEvidence: Evidence[] = [];
{
  let mint: string | null = null;
  let mintTo: string | null = null;
  let pool: string | null = null;
  for (const [sig, tx] of Object.entries(devTxs.txs)) {
    if (!tx) continue;
    const logs: string[] = tx.meta.logMessages ?? [];
    const payer = tx.transaction.message.accountKeys[0].pubkey;
    if (payer !== DEV) continue;
    if (logs.some((l) => l.includes('Instruction: InitializeMint2')) && tx.transaction.message.accountKeys.some((k: any) => k.pubkey === LIBRA)) mint = sig;
    if (logs.some((l) => l.includes('Instruction: MintTo')) && tx.transaction.message.accountKeys.some((k: any) => k.pubkey === LIBRA)) mintTo = sig;
    if (logs.some((l) => l.includes('InitializeCustomizablePermissionlessLbPair')) && !pool) pool = sig;
  }
  devEvidence.push({ rule: 'jupiter-asset-dev', detail: `Jupiter asset metadata lists ${short(DEV)} as the token's dev (creator) wallet.` });
  if (mint) devEvidence.push({ rule: 'onchain-mint-creator', detail: 'This wallet is the fee payer of the LIBRA InitializeMint2 transaction.', signatures: [mint] });
  if (mintTo) devEvidence.push({ rule: 'onchain-initial-supply', detail: 'This wallet is the fee payer of the transaction that minted the initial LIBRA supply.', signatures: [mintTo] });
  if (pool) devEvidence.push({ rule: 'onchain-pool-creator', detail: 'This wallet is the fee payer of the Meteora pool initialisation for LIBRA.', signatures: [pool] });
  if (!mint) throw new Error('dev evidence check failed: no mint-creation transaction signed by the dev wallet');
}

// ---- INSIDER: wallets that received LIBRA directly from the dev wallet -------------------------------
const insiders = new Map<string, Evidence[]>();
const devEvents: Ev[] = [];
for (const [sig, tx] of Object.entries(devTxs.txs)) {
  if (!tx) continue;
  const delta = new Map<string, number>();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === LIBRA) delta.set(b.owner, (delta.get(b.owner) ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
  for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === LIBRA) delta.set(b.owner, (delta.get(b.owner) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
  const devDelta = delta.get(DEV) ?? 0;
  const ts = tx.blockTime as number;
  const logs: string[] = tx.meta.logMessages ?? [];
  const when = new Date(ts * 1000).toISOString();

  if (devDelta < -1) {
    for (const [owner, d] of delta) {
      if (owner === DEV || d <= 1) continue;
      if (infra.has(owner)) {
        // tokens moved into a pool/lock: supply moved, not a person
        if (ts >= WINDOW.from && ts <= WINDOW.to && logs.some((l) => /AddLiquidity/.test(l)))
          devEvents.push({ id: `${sig.slice(0, 12)}:${short(owner)}`, timestamp: ts, walletAddress: DEV, tag: 'DEV', action: 'SUPPLY_MOVE', amount: d, amountUnit: 'LIBRA', signature: sig, source: 'solana-rpc getTransaction', classification: devEvidence, note: `Dev wallet added ${(d / 1e6).toFixed(2)}M LIBRA to a Meteora liquidity pool.` });
        continue;
      }
      const ev: Evidence = { rule: 'direct-recipient-of-dev-supply', detail: `Received ${(d / 1e6).toFixed(2)}M LIBRA directly from the dev wallet in one transaction at ${when}.`, signatures: [sig] };
      insiders.set(owner, [...(insiders.get(owner) ?? []), ev]);
      if (ts >= WINDOW.from && ts <= WINDOW.to)
        // the recipient side of the same transaction: shown as a separate INSIDER event
        devEvents.push({ id: `${sig.slice(0, 12)}:${short(owner)}:recv`, timestamp: ts, walletAddress: owner, tag: 'INSIDER', action: 'SUPPLY_MOVE', amount: d, amountUnit: 'LIBRA', signature: sig, source: 'solana-rpc getTransaction', classification: [ev], note: `Received ${(d / 1e6).toFixed(2)}M LIBRA directly from the dev wallet.` });
      if (ts >= WINDOW.from && ts <= WINDOW.to)
        devEvents.push({ id: `${sig.slice(0, 12)}:${short(owner)}`, timestamp: ts, walletAddress: DEV, tag: 'DEV', action: 'SUPPLY_MOVE', amount: d, amountUnit: 'LIBRA', signature: sig, source: 'solana-rpc getTransaction', classification: devEvidence, note: `Dev wallet transferred ${(d / 1e6).toFixed(2)}M LIBRA to ${short(owner)}.` });
    }
  }
}
console.log(`dev: ${devEvents.length} in-window supply-move events; insiders (direct recipients): ${insiders.size}`);

// ---- per-wallet stats over the whole tape (for SMART / WHALE rules) ------------------------------------
interface Stats { buyUsd: number; sellUsd: number; buyTok: number; sellTok: number; first: number; last: number; lastSell: number; maxTrade: number; trades: number; mev: number }
const stats = new Map<string, Stats>();
for (const t of tape) {
  const s = stats.get(t.traderAddress) ?? { buyUsd: 0, sellUsd: 0, buyTok: 0, sellTok: 0, first: Infinity, last: 0, lastSell: 0, maxTrade: 0, trades: 0, mev: 0 };
  const ts = sec(t.timestamp);
  if (t.type === 'buy') { s.buyUsd += t.usdVolume; s.buyTok += t.amount; } else { s.sellUsd += t.usdVolume; s.sellTok += t.amount; s.lastSell = Math.max(s.lastSell, ts); }
  s.first = Math.min(s.first, ts);
  s.last = Math.max(s.last, ts);
  s.maxTrade = Math.max(s.maxTrade, t.usdVolume);
  s.trades++;
  if (t.isMev) s.mev++;
  stats.set(t.traderAddress, s);
}

const tagged = new Map<string, { tag: Tag; evidence: Evidence[] }>();
tagged.set(DEV, { tag: 'DEV', evidence: devEvidence });
for (const [w, ev] of insiders) if (!tagged.has(w)) tagged.set(w, { tag: 'INSIDER', evidence: ev });

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const iso = (t: number) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

// in-window volume per wallet (for the WHALE ranking)
const windowUsd = new Map<string, number>();
for (const t of tape) {
  const ts = sec(t.timestamp);
  if (ts >= WINDOW.from && ts <= WINDOW.to) windowUsd.set(t.traderAddress, (windowUsd.get(t.traderAddress) ?? 0) + t.usdVolume);
}
const isBot = (s: Stats) => s.trades > 0 && s.mev / s.trades > RULES.botFilter.maxMevTradeFraction;
const notYetTagged = [...stats.keys()].filter((w) => !tagged.has(w) && !infra.has(w));

const smartCandidates = notYetTagged
  .map((w) => ({ w, s: stats.get(w)!, profit: stats.get(w)!.sellUsd - stats.get(w)!.buyUsd }))
  .filter(({ s, profit }) => !isBot(s) && profit >= RULES.smart.minRealizedProfitUsd && s.buyTok > 0 && s.sellTok / s.buyTok >= RULES.smart.minSoldFractionOfBought && s.lastSell < WINDOW.rug)
  .sort((a, b) => b.profit - a.profit)
  .slice(0, RULES.smart.topN);
smartCandidates.forEach(({ w, s, profit }, i) => {
  tagged.set(w, {
    tag: 'SMART',
    evidence: [{ rule: 'early-profitable-exit', detail: `Rank ${i + 1} of the candidates by realised profit. Recorded trades ${iso(s.first)} to ${iso(s.last)}: bought ${fmtUsd(s.buyUsd)}, sold ${fmtUsd(s.sellUsd)} (realised ${fmtUsd(profit)}); sold ${((s.sellTok / s.buyTok) * 100).toFixed(0)}% of the LIBRA bought; last sell ${iso(s.lastSell)}, before the collapse marker ${iso(WINDOW.rug)}.` }],
  });
});

const whaleCandidates = notYetTagged
  .filter((w) => !tagged.has(w) && !isBot(stats.get(w)!) && (windowUsd.get(w) ?? 0) > 0)
  .sort((a, b) => (windowUsd.get(b) ?? 0) - (windowUsd.get(a) ?? 0))
  .slice(0, RULES.whale.topN);
whaleCandidates.forEach((w, i) => {
  tagged.set(w, { tag: 'WHALE', evidence: [{ rule: 'largest-in-window-volume', detail: `Rank ${i + 1} of the candidates by USD traded inside the replay window (${fmtUsd(windowUsd.get(w) ?? 0)}); not a dev, insider or smart-exit wallet and not bot-like (MEV-flagged trades <= ${RULES.botFilter.maxMevTradeFraction * 100}%).` }] });
});
const counts: Record<string, number> = {};
for (const { tag } of tagged.values()) counts[tag] = (counts[tag] ?? 0) + 1;
console.log('tagged wallets:', counts);

// ---- trade events: aggregate legs of one transaction; keep only in-window and above the size floor -----
const legs = new Map<string, { t: Trade; usd: number; tok: number }>();
for (const t of tape) {
  const ts = sec(t.timestamp);
  if (ts < WINDOW.from || ts > WINDOW.to) continue;
  const cls = tagged.get(t.traderAddress);
  if (!cls || cls.tag === 'DEV') continue;
  const key = `${t.txHash}|${t.traderAddress}|${t.type}`;
  const cur = legs.get(key);
  if (cur) { cur.usd += t.usdVolume; cur.tok += t.amount; } else legs.set(key, { t, usd: t.usdVolume, tok: t.amount });
}
const tradeEvents: Ev[] = [];
for (const { t, usd, tok } of legs.values()) {
  const cls = tagged.get(t.traderAddress)!;
  const floor = (RULES.eventMinUsd as Record<string, number>)[cls.tag] ?? Infinity;
  if (usd < floor) continue;
  tradeEvents.push({
    id: `${t.txHash.slice(0, 12)}:${short(t.traderAddress)}`,
    timestamp: sec(t.timestamp),
    walletAddress: t.traderAddress,
    tag: cls.tag,
    action: t.type === 'buy' ? 'BUY' : 'SELL',
    amount: Math.round(usd),
    amountUnit: 'USD',
    signature: t.txHash,
    source: 'jupiter datapi /v1/txs (trade tape)',
    classification: cls.evidence,
    note: `${t.type === 'buy' ? 'Bought' : 'Sold'} ${(tok / 1e6).toFixed(2)}M LIBRA for ${fmtUsd(usd)}.`,
  });
}

// ---- liquidity events (from the reserve analysis, if present) --------------------------------------------
const liquidityEvents: Ev[] = [];
const liqFile = resolve(ROOT, 'data/processed/libra.liquidity.json');
if (existsSync(liqFile)) {
  for (const e of JSON.parse(readFileSync(liqFile, 'utf8')).events as Ev[]) liquidityEvents.push(e);
}

// ---- assemble, dedupe, sort -------------------------------------------------------------------------------
const all = [...devEvents, ...tradeEvents, ...liquidityEvents].filter((e) => e.timestamp >= WINDOW.from && e.timestamp <= WINDOW.to);
const seen = new Set<string>();
const events: Ev[] = [];
let duplicates = 0;
for (const e of all.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  const key = `${e.signature}|${e.walletAddress}|${e.action}|${e.amount}`;
  if (seen.has(key)) { duplicates++; continue; }
  seen.add(key);
  events.push(e);
}

// SOL/USD used to convert paper SOL <-> the USD replay prices: the median of usdVolume/nativeVolume
// over in-window trades (Jupiter reports both for every trade), held constant for the replay.
const ratios: number[] = [];
for (const h of histories.values()) for (const t of h) {
  const ts = sec(t.timestamp);
  if (ts >= WINDOW.from && ts <= WINDOW.to && (t.nativeVolume ?? 0) > 0.05 && t.usdVolume > 100) ratios.push(t.usdVolume / (t.nativeVolume as number));
}
ratios.sort((a, b) => a - b);
const paperSolUsd = { value: +ratios[Math.floor((ratios.length - 1) / 2)].toFixed(2), samples: ratios.length, min: +ratios[0].toFixed(2), max: +ratios[ratios.length - 1].toFixed(2), method: 'median of usdVolume/nativeVolume over in-window trades in the candidate histories' };
console.log('paperSolUsd:', JSON.stringify(paperSolUsd));

const wallets = [...tagged.entries()].map(([address, v]) => ({ address, display: short(address), tag: v.tag, evidence: v.evidence, stats: stats.get(address) ?? null }));
mkdirSync(resolve(ROOT, 'data/processed'), { recursive: true });
writeFileSync(
  resolve(ROOT, 'data/processed/libra.events.json'),
  JSON.stringify({ paperSolUsd, window: { from: iso(WINDOW.from), to: iso(WINDOW.to), collapseMarker: iso(WINDOW.rug) }, rules: RULES, generatedFrom: { tapeTrades: tape.length }, duplicatesDropped: duplicates, events, wallets }, null, 1) + '\n',
);

const byTag: Record<string, number> = {};
for (const e of events) byTag[e.tag ?? 'untagged'] = (byTag[e.tag ?? 'untagged'] ?? 0) + 1;
console.log(`events: ${events.length} (${JSON.stringify(byTag)}), duplicates dropped: ${duplicates}`);
for (const e of events) console.log(`${iso(e.timestamp).slice(11, 19)} ${(e.tag ?? '-').padEnd(8)} ${e.action.padEnd(17)} ${short(e.walletAddress)}  ${e.amount !== undefined ? (e.amountUnit === 'USD' ? fmtUsd(e.amount) : `${(e.amount / 1e6).toFixed(2)}M LIBRA`) : ''}`);
