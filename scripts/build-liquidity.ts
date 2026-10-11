// Data pipeline step 2b: liquidity-related transactions -> LIQUIDITY events.
//   npm run build:liquidity   (run before build:events; build:events merges data/processed/libra.liquidity.json)
// Only a transaction that actually executes a RemoveLiquidity instruction against the pool becomes
// a LIQUIDITY_REMOVAL event. Fee claims and other pool instructions are listed under `excluded`
// with the reason, never presented as removals.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const DEV = (JSON.parse(readFileSync(resolve(ROOT, 'data/raw/libra.asset.json'), 'utf8')) as { dev: string }[])[0].dev;
const raw = JSON.parse(readFileSync(resolve(ROOT, 'data/raw/onchain/liquidity-candidates.json'), 'utf8')) as {
  vault: string;
  found: { signature: string; blockTime: number; payer: string; vaultUsdcDelta: number; liquidityInstructions: string[]; allInstructions: string[] }[];
};
const replay = JSON.parse(readFileSync(resolve(ROOT, 'src/data/replays/libra.json'), 'utf8')) as { ticks: { timestamp: number }[] };
const from = replay.ticks[0].timestamp;
const to = replay.ticks[replay.ticks.length - 1].timestamp;

const short = (a: string) => `${a.slice(0, 3)}...${a.slice(-3)}`;
const events: unknown[] = [];
const excluded: unknown[] = [];
for (const f of raw.found.sort((a, b) => a.blockTime - b.blockTime || (a.signature < b.signature ? -1 : 1))) {
  const isRemoval = f.liquidityInstructions.some((i) => /^RemoveLiquidity|^RemoveAllLiquidity/.test(i));
  const when = new Date(f.blockTime * 1000).toISOString();
  if (!isRemoval) {
    excluded.push({ signature: f.signature, timestamp: f.blockTime, at: when, payer: short(f.payer), vaultUsdcDelta: f.vaultUsdcDelta, instructions: f.liquidityInstructions.length ? f.liquidityInstructions : f.allInstructions, reason: f.liquidityInstructions.length ? 'liquidity-related but not a removal (e.g. fee claim)' : 'large swap, not a liquidity instruction' });
    continue;
  }
  if (f.blockTime < from || f.blockTime > to || f.vaultUsdcDelta >= 0) {
    excluded.push({ signature: f.signature, timestamp: f.blockTime, at: when, reason: 'outside replay window or no USDC left the pool' });
    continue;
  }
  events.push({
    id: `${f.signature.slice(0, 12)}:${short(f.payer)}:liq`,
    timestamp: f.blockTime,
    walletAddress: f.payer,
    tag: 'LIQUIDITY',
    action: 'LIQUIDITY_REMOVAL',
    amount: Math.round(-f.vaultUsdcDelta),
    amountUnit: 'USD',
    signature: f.signature,
    source: 'solana-rpc getTransaction (Meteora RemoveLiquidity instruction in logs)',
    classification: [
      { rule: 'onchain-remove-liquidity-instruction', detail: `Transaction executes ${f.liquidityInstructions.join(', ')} and the pool USDC vault ${short(raw.vault)} decreases by $${Math.round(-f.vaultUsdcDelta).toLocaleString('en-US')}.${f.payer === DEV ? ' The fee payer is the dev wallet.' : ''}`, signatures: [f.signature] },
    ],
    note: `Pool USDC reserve fell by $${Math.round(-f.vaultUsdcDelta).toLocaleString('en-US')} in this transaction.`,
  });
}
writeFileSync(resolve(ROOT, 'data/processed/libra.liquidity.json'), JSON.stringify({ events, excluded }, null, 1) + '\n');
console.log(`liquidity removal events: ${events.length}; excluded liquidity-related transactions: ${excluded.length}`);
for (const e of excluded as { at: string; payer?: string; vaultUsdcDelta?: number; reason: string }[]) console.log(`  excluded ${e.at.slice(11, 19)} ${e.payer ?? ''} ${e.vaultUsdcDelta !== undefined ? '$' + Math.round(e.vaultUsdcDelta).toLocaleString('en-US') : ''} ${e.reason}`);
