// One-time DEVNET setup for testing upgrades without real SKR.
//   npm run server:setup-devnet
// Creates: an issuer key, a treasury key, a throwaway 6-decimal test token standing in for SKR, and
// the Metaplex Core collection the tier badges belong to. Prints the env vars the server and the
// app need. Never use these keys or this token on mainnet.
import { createCollection, mplCore } from '@metaplex-foundation/mpl-core';
import { createSignerFromKeypair, generateSigner, signerIdentity } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
if (/mainnet/.test(RPC)) throw new Error('This script is for devnet only.');
const DIR = 'server/.keys';
mkdirSync(DIR, { recursive: true });

function loadOrCreate(file: string): Keypair {
  if (existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
  const kp = Keypair.generate();
  writeFileSync(file, JSON.stringify([...kp.secretKey]));
  return kp;
}

(async () => {
  const conn = new Connection(RPC, 'confirmed');
  const issuer = loadOrCreate(`${DIR}/issuer.json`);
  const treasury = loadOrCreate(`${DIR}/treasury.json`);
  if ((await conn.getBalance(issuer.publicKey)) < 0.5 * LAMPORTS_PER_SOL) {
    console.log('requesting a devnet airdrop for the issuer...');
    const sig = await conn.requestAirdrop(issuer.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
  }
  const mint = await createMint(conn, issuer, issuer.publicKey, null, 6);
  const treasuryAta = await getOrCreateAssociatedTokenAccount(conn, issuer, mint, treasury.publicKey);
  const issuerAta = await getOrCreateAssociatedTokenAccount(conn, issuer, mint, issuer.publicKey);
  await mintTo(conn, issuer, mint, issuerAta.address, issuer, 1_000_000_000n); // 1000 test tokens to hand out
  const umi = createUmi(RPC).use(mplCore());
  umi.use(signerIdentity(createSignerFromKeypair(umi, fromWeb3JsKeypair(issuer))));
  const collection = generateSigner(umi);
  await createCollection(umi, { collection, name: 'Rug Hunter Tiers (devnet)', uri: 'data:application/json,%7B%22name%22%3A%22Rug%20Hunter%20Tiers%22%7D' }).sendAndConfirm(umi);

  console.log('\n# --- server environment ---');
  console.log(`RPC_URL=${RPC}`);
  console.log(`ISSUER_KEYPAIR_FILE=${DIR}/issuer.json`);
  console.log(`COLLECTION=${collection.publicKey}`);
  console.log(`PAYMENT_MINT=${mint.toBase58()}`);
  console.log(`TREASURY=${treasury.publicKey.toBase58()}`);
  console.log(`ASSET_SECRET=${randomBytes(32).toString('hex')}`);
  console.log('\n# --- app environment (EXPO_PUBLIC_*) ---');
  console.log('EXPO_PUBLIC_ISSUER_URL=<where you run the server>');
  console.log(`EXPO_PUBLIC_PAYMENT_MINT=${mint.toBase58()}`);
  console.log(`EXPO_PUBLIC_TREASURY=${treasury.publicKey.toBase58()}`);
  console.log(`\nTest tokens are in the issuer's token account ${issuerAta.address.toBase58()}; send some to your test wallet.`);
  void treasuryAta;
})().catch((e) => {
  console.error('setup failed:', e.message);
  process.exit(1);
});
