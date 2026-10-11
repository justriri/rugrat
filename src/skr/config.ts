// SKR configuration: the ONE place the mint address and network live.
//
// The mint is the official SKR token published by Solana Mobile (solanamobile.com/skr, "The SKR
// Contract Address"), and was also checked against Solana mainnet: it is an SPL Token mint owned by
// the classic Token program with 6 decimals.
//
// SKR exists on MAINNET only. Reading a balance is free and read-only, so the SKR check always uses
// mainnet RPC, independent of the cluster the rest of the app (score memos, badge) is configured for.
import { PublicKey } from '@solana/web3.js';

import { CLUSTER, RPC_IS_PUBLIC_DEFAULT, RPC_URL } from '../chain/config';

export const SKR_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3';
export const SKR_DECIMALS = 6;
export const SKR_CLUSTER = 'mainnet-beta' as const;
/** SKR is a mainnet token: an override must be https and can never be a devnet/testnet endpoint. */
export function resolveSkrRpc(override: string | undefined, mainnetRpc?: string): string {
  const o = override?.trim() || mainnetRpc?.trim();
  if (!o) return 'https://api.mainnet-beta.solana.com';
  if (!/^https:\/\//i.test(o)) throw new Error('EXPO_PUBLIC_SKR_RPC must be an https URL.');
  if (/devnet|testnet/i.test(o)) throw new Error('EXPO_PUBLIC_SKR_RPC must be a MAINNET endpoint: SKR does not exist on devnet.');
  return o;
}
// In a mainnet build with a configured provider the SKR read uses that same provider (one RPC to configure).
export const SKR_RPC: string = resolveSkrRpc(process.env.EXPO_PUBLIC_SKR_RPC, CLUSTER === 'mainnet-beta' && !RPC_IS_PUBLIC_DEFAULT ? RPC_URL : undefined);

/** A mint must be a valid 32-byte address; anything else is a configuration error, never a guess. */
export function validMintAddress(mint: string | null | undefined): mint is string {
  if (!mint) return false;
  try {
    return new PublicKey(mint).toBytes().length === 32;
  } catch {
    return false;
  }
}
