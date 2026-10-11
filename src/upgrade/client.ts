// The app's side of an upgrade: ask the issuer, CHECK what it returned against the app's own
// config, and only then ask the wallet to sign. Optional; the game never calls this by itself.
import { Transaction } from '@solana/web3.js';

import { signAndSendPrepared, WalletSession } from '../chain/wallet';
import { inspectUpgradeTransaction } from './inspect';
import { PAYMENT_DECIMALS, UpgradeAvailability, upgradeAvailability } from './config';
import { tierByNumber } from './tiers';

export type UpgradeOutcome =
  | { ok: true; signature: string; assetAddress: string }
  | { ok: false; code: 'UNAVAILABLE' | 'NOT_ELIGIBLE' | 'ALREADY_OWNED' | 'SERVER' | 'UNSAFE' | 'WALLET'; message: string };

export interface UpgradeIO {
  post: (url: string, body: unknown) => Promise<{ status: number; json: any }>;
  sign: (session: WalletSession, tx: Transaction) => Promise<string>;
}

export const realIO: UpgradeIO = {
  post: async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  },
  sign: signAndSendPrepared,
};

export async function fetchOwnedTiers(session: WalletSession, avail: UpgradeAvailability = upgradeAvailability(), io: UpgradeIO = realIO): Promise<number[]> {
  if (!avail.available) return [];
  try {
    const r = await io.post(`${avail.issuerUrl}/v1/upgrade/owned`, { wallet: session.address });
    return r.json?.ok && Array.isArray(r.json.owned) ? r.json.owned.filter((n: unknown) => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

export async function upgradeTier(session: WalletSession, tierNumber: number, avail: UpgradeAvailability = upgradeAvailability(), io: UpgradeIO = realIO): Promise<UpgradeOutcome> {
  if (!avail.available) return { ok: false, code: 'UNAVAILABLE', message: avail.reason };
  const tier = tierByNumber(tierNumber);
  if (!tier) return { ok: false, code: 'UNAVAILABLE', message: 'Unknown tier.' };
  let res;
  try {
    res = await io.post(`${avail.issuerUrl}/v1/upgrade/prepare`, { wallet: session.address, tier: tierNumber });
  } catch {
    return { ok: false, code: 'SERVER', message: "Couldn't reach the upgrade service. Nothing was charged." };
  }
  if (!res.json?.ok) {
    const code = res.json?.code === 'NOT_ELIGIBLE' ? 'NOT_ELIGIBLE' : res.json?.code === 'ALREADY_OWNED' ? 'ALREADY_OWNED' : 'SERVER';
    return { ok: false, code, message: typeof res.json?.message === 'string' ? res.json.message : 'The upgrade service declined. Nothing was charged.' };
  }
  // never sign what we have not checked against OUR OWN expectations
  const check = inspectUpgradeTransaction(res.json.transaction, { wallet: session.address, tier: tierNumber, paymentMint: avail.paymentMint, paymentDecimals: PAYMENT_DECIMALS, treasury: avail.treasury, amount: tier.priceBaseUnits });
  if (!check.ok) return { ok: false, code: 'UNSAFE', message: `Upgrade cancelled: the transaction did not match what was expected (${check.reason}). Nothing was charged.` };
  try {
    const signature = await io.sign(session, check.tx);
    return { ok: true, signature, assetAddress: String(res.json.assetAddress ?? '') };
  } catch {
    return { ok: false, code: 'WALLET', message: 'The transaction was declined or failed. Nothing was charged.' };
  }
}
