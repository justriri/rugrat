// App-side upgrade configuration. Nothing is guessed: if any value is missing, upgrades are simply
// unavailable in this build (the game and everything else work as before).
import { PublicKey } from '@solana/web3.js';

import { CLUSTER, Cluster } from '../chain/config';
import { SKR_DECIMALS, SKR_MINT } from '../skr/config';

const env = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export const ISSUER_URL = env(process.env.EXPO_PUBLIC_ISSUER_URL);
/** Devnet: a throwaway test token. Mainnet: set this to the SKR mint (src/skr/config.ts). */
export const PAYMENT_MINT = env(process.env.EXPO_PUBLIC_PAYMENT_MINT);
export const TREASURY = env(process.env.EXPO_PUBLIC_TREASURY);
export const PAYMENT_DECIMALS = SKR_DECIMALS;

export type UpgradeAvailability = { available: true; issuerUrl: string; paymentMint: string; treasury: string } | { available: false; reason: string };

const validAddress = (a: string) => {
  try {
    return new PublicKey(a).toBytes().length === 32;
  } catch {
    return false;
  }
};

/**
 * Upgrades are available only when an issuer, a payment token AND a treasury are all configured and
 * valid. On mainnet the payment token must be SKR itself and the issuer must be https. Anything
 * missing (or malformed) means "not configured": there is no default treasury and no fallback.
 */
export function upgradeAvailability(c: { ISSUER_URL: string | null; PAYMENT_MINT: string | null; TREASURY: string | null } = { ISSUER_URL, PAYMENT_MINT, TREASURY }, cluster: Cluster = CLUSTER): UpgradeAvailability {
  if (!c.ISSUER_URL) return { available: false, reason: 'Upgrades are not available in this build (no issuer configured).' };
  if (!c.PAYMENT_MINT || !c.TREASURY) return { available: false, reason: 'Upgrades are not available in this build (payment not configured).' };
  if (!validAddress(c.PAYMENT_MINT) || !validAddress(c.TREASURY)) return { available: false, reason: 'Upgrades are not available in this build (payment configuration is invalid).' };
  if (cluster === 'mainnet-beta' && c.PAYMENT_MINT !== SKR_MINT) return { available: false, reason: 'Upgrades are not available in this build (mainnet payments must use SKR).' };
  if (cluster === 'mainnet-beta' && !/^https:\/\//i.test(c.ISSUER_URL)) return { available: false, reason: 'Upgrades are not available in this build (issuer must use https).' };
  return { available: true, issuerUrl: c.ISSUER_URL, paymentMint: c.PAYMENT_MINT, treasury: c.TREASURY };
}

/** What is configured, for logs and audits (addresses are public; "NOT_CONFIGURED" is explicit). */
export function describeUpgradeConfig(c: { ISSUER_URL: string | null; PAYMENT_MINT: string | null; TREASURY: string | null } = { ISSUER_URL, PAYMENT_MINT, TREASURY }) {
  return { issuer: c.ISSUER_URL ?? 'NOT_CONFIGURED', paymentMint: c.PAYMENT_MINT ?? 'NOT_CONFIGURED', treasury: c.TREASURY ?? 'NOT_CONFIGURED' };
}
