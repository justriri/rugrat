// The Metaplex Core side. Builds ONE transaction that creates the badge asset:
//   - owner: the player's wallet; update authority: the player's wallet, but metadata is made
//     immutable (ImmutableMetadata) so name/uri cannot be changed afterwards;
//   - PermanentFreezeDelegate { frozen: true } with NO authority: the asset is frozen forever, which
//     makes it non-transferable (Metaplex Core's documented "soulbound" pattern);
//   - Attributes (authority None, so they can never be edited): the achievement data, written from
//     the verified progress.
// The asset's address is derived from a signature only the wallet can produce, so it is stable per
// wallet (a second mint fails onchain because the account already exists) and nobody else can
// predict it in order to occupy it.
import { createSignerFromKeypair, createNoopSigner, publicKey, signerIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import { sha256 } from '@noble/hashes/sha2.js';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import { CLUSTER, RPC_URL } from '../chain/config';
import { getConnection, signAndSend, signMessageBytes, WalletSession } from '../chain/wallet';
import type { AchievementProgress } from './achievement';
import type { BadgeClaim } from './claim';
import { BADGE_NAME, badgeAttributes, badgeMetadataUri } from './metadata';

/** What the wallet is asked to sign to derive the badge address. Fixed, readable text. */
export function badgeSeedMessage(wallet: string, cluster: string = CLUSTER): Uint8Array {
  return new TextEncoder().encode(`Rug Replay: Rug Hunter badge v1\nWallet: ${wallet}\nNetwork: ${cluster}`);
}

/** Deterministic asset keypair from the wallet's signature over the seed message. */
export function assetKeypairFromSignature(signature: Uint8Array): Keypair {
  return Keypair.fromSeed(sha256(Uint8Array.from([...new TextEncoder().encode('rugreplay/rughunter/v1'), ...signature])));
}

/** The Core instructions for the badge (web3.js form), for a given asset keypair. */
export function buildBadgeInstructions(wallet: string, asset: Keypair, progress: AchievementProgress, rpcUrl: string = RPC_URL) {
  const umi = createUmi(rpcUrl).use(mplCore());
  umi.use(signerIdentity(createNoopSigner(publicKey(wallet))));
  const assetSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(asset));
  const builder = create(umi, {
    asset: assetSigner,
    owner: publicKey(wallet),
    name: BADGE_NAME,
    uri: badgeMetadataUri(),
    plugins: [
      { type: 'PermanentFreezeDelegate', frozen: true, authority: { type: 'None' } },
      { type: 'Attributes', attributeList: badgeAttributes(progress), authority: { type: 'None' } },
      { type: 'ImmutableMetadata' },
    ],
  });
  return builder.getInstructions().map(toWeb3JsInstruction);
}

async function resolveAssetKeypair(session: WalletSession): Promise<Keypair> {
  const sig = await signMessageBytes(session, badgeSeedMessage(session.address));
  return assetKeypairFromSignature(sig);
}

/** The badge address if it already exists onchain for this wallet (the wallet signs the seed message). */
export async function existingBadgeAddress(session: WalletSession): Promise<string | null> {
  const kp = await resolveAssetKeypair(session);
  const info = await getConnection().getAccountInfo(kp.publicKey, 'confirmed');
  return info ? kp.publicKey.toBase58() : null;
}

export async function mintBadge(session: WalletSession, progress: AchievementProgress): Promise<{ assetAddress: string; signature: string }> {
  const asset = await resolveAssetKeypair(session);
  const payer = new PublicKey(session.address);
  const signature = await signAndSend(session, (blockhash, lastValidBlockHeight) => {
    const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(...buildBadgeInstructions(session.address, asset, progress));
    tx.partialSign(asset);
    return tx;
  });
  return { assetAddress: asset.publicKey.toBase58(), signature };
}

export type { BadgeClaim };
