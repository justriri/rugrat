// The issuer: builds the ONE atomic transaction for a tier upgrade. Runs on the backend (it needs
// the issuer key), but is plain code with injected dependencies so it is fully testable.
//
//   [ transferChecked: wallet's payment token -> treasury ]
//   [ memo: what this payment is for ]
//   [ Metaplex Core create: the tier badge, in the issuer's collection, soulbound ]
//
// Payment and badge are in the same transaction, so a player can never pay without receiving the
// badge or receive it without paying. The issuer partially signs (collection authority + asset
// key); the player signs last as fee payer, so the wallet shows exactly these instructions.
import { createNoopSigner, createSignerFromKeypair, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createHmac } from 'node:crypto';

import { uniqueVerifiedSurvivingRugs } from '../badge/achievement';
import type { Replay } from '../game/types';
import { MEMO_PROGRAM_ID } from '../chain/config';
import type { VerifiedChainRun } from '../chain/verifyTx';
import { upgradeMemoText } from './memoText';
import { UpgradeTier, tierByNumber } from './tiers';

export interface IssuerConfig {
  issuer: Keypair;
  /** The Metaplex Core collection the tier badges belong to (its update authority is `issuer`). */
  collection: string;
  /** The payment token (SKR on mainnet; a throwaway test token on devnet). */
  paymentMint: string;
  paymentDecimals: number;
  /** The wallet whose token account receives payments. */
  treasury: string;
  /** Secret used to derive each (wallet, tier) badge address, so a tier can be minted once. */
  assetSecret: string;
  rpcUrl: string;
  replays: readonly Replay[];
}

export interface IssuerDeps {
  fetchVerifiedRuns: (wallet: string) => Promise<VerifiedChainRun[]>;
  /** True if an account already exists at this address (the tier badge was already minted). */
  accountExists: (address: string) => Promise<boolean>;
  latestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
}

export type PrepareResult =
  | { ok: true; transaction: string; tier: number; amount: string; assetAddress: string; treasuryToken: string; paymentMint: string; collection: string }
  | { ok: false; code: 'BAD_REQUEST' | 'NOT_ELIGIBLE' | 'ALREADY_OWNED' | 'UNAVAILABLE'; message: string };

/** The badge address for (wallet, tier): derived from a server secret, so it cannot be predicted or squatted. */
export function tierAssetKeypair(secret: string, wallet: string, tier: number): Keypair {
  return Keypair.fromSeed(createHmac('sha256', secret).update(`rugreplay/tier/v1|${wallet}|${tier}`).digest());
}

export const upgradeMemo = upgradeMemoText;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function tierAttributes(tier: UpgradeTier, rugs: number) {
  return [
    { key: 'Achievement', value: 'Rug Hunter' },
    { key: 'Tier', value: String(tier.tier) },
    { key: 'Rugs Survived', value: String(rugs) },
    { key: 'Game', value: 'Rug Replay' },
    { key: 'Non-Demo', value: 'true' },
  ];
}

export async function prepareUpgrade(cfg: IssuerConfig, deps: IssuerDeps, req: { wallet: unknown; tier: unknown }): Promise<PrepareResult> {
  if (typeof req.wallet !== 'string' || !BASE58.test(req.wallet) || typeof req.tier !== 'number') return { ok: false, code: 'BAD_REQUEST', message: 'Invalid request.' };
  const tier = tierByNumber(req.tier);
  if (!tier) return { ok: false, code: 'BAD_REQUEST', message: 'Unknown tier.' };
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(req.wallet);
  } catch {
    return { ok: false, code: 'BAD_REQUEST', message: 'Invalid wallet.' };
  }

  // 1. eligibility: re-derived from the chain here, never taken from the client
  let progress;
  try {
    progress = uniqueVerifiedSurvivingRugs(await deps.fetchVerifiedRuns(wallet.toBase58()), wallet.toBase58(), cfg.replays);
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'Could not read the chain. Try again.' };
  }
  if (progress.count < tier.requiredRugs) return { ok: false, code: 'NOT_ELIGIBLE', message: `Needs ${tier.requiredRugs} unique verified surviving rugs (you have ${progress.count}).` };

  // 2. once per tier per wallet
  const asset = tierAssetKeypair(cfg.assetSecret, wallet.toBase58(), tier.tier);
  try {
    if (await deps.accountExists(asset.publicKey.toBase58())) return { ok: false, code: 'ALREADY_OWNED', message: 'This tier was already minted for this wallet.' };
  } catch {
    return { ok: false, code: 'UNAVAILABLE', message: 'Could not read the chain. Try again.' };
  }

  // 3. build the atomic transaction
  const mint = new PublicKey(cfg.paymentMint);
  const treasury = new PublicKey(cfg.treasury);
  const from = getAssociatedTokenAddressSync(mint, wallet);
  const to = getAssociatedTokenAddressSync(mint, treasury, true);

  const umi = createUmi(cfg.rpcUrl).use(mplCore());
  umi.use(signerIdentity(createNoopSigner(publicKey(wallet.toBase58()))));
  const assetSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(asset));
  const authority = createSignerFromKeypair(umi, fromWeb3JsKeypair(cfg.issuer));
  const createIxs = create(umi, {
    asset: assetSigner,
    owner: publicKey(wallet.toBase58()),
    authority,
    collection: { publicKey: publicKey(cfg.collection), oracles: [], lifecycleHooks: [] },
    name: tier.name,
    uri: process.env.BADGE_TIER_METADATA_URI && /^https?:\/\//.test(process.env.BADGE_TIER_METADATA_URI) ? process.env.BADGE_TIER_METADATA_URI : `data:application/json,${encodeURIComponent(JSON.stringify({ name: tier.name }))}`,
    plugins: [
      { type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'None' } },
      { type: 'Attributes', attributeList: tierAttributes(tier, progress.count), authority: { type: 'None' } },
    ],
  })
    .getInstructions()
    .map(toWeb3JsInstruction);

  const { blockhash, lastValidBlockHeight } = await deps.latestBlockhash();
  const tx = new Transaction({ feePayer: wallet, blockhash, lastValidBlockHeight });
  tx.add(
    // the treasury's token account is created by the payer only if missing (idempotent)
    createAssociatedTokenAccountIdempotentInstruction(wallet, to, treasury, mint),
    createTransferCheckedInstruction(from, mint, to, wallet, tier.priceBaseUnits, cfg.paymentDecimals),
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM_ID), keys: [{ pubkey: wallet, isSigner: true, isWritable: false }], data: Buffer.from(upgradeMemo(wallet.toBase58(), tier.tier), 'utf8') }),
    ...createIxs,
  );
  tx.partialSign(cfg.issuer, asset);
  return {
    ok: true,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    tier: tier.tier,
    amount: tier.priceBaseUnits.toString(),
    assetAddress: asset.publicKey.toBase58(),
    treasuryToken: to.toBase58(),
    paymentMint: cfg.paymentMint,
    collection: cfg.collection,
  };
}
