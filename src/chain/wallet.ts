// The one wallet integration: Solana Mobile Wallet Adapter. Everything that needs the player's
// signature (score memo, badge mint) goes through here. Optional: nothing in the game calls it
// unless the player asks.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { transact, Web3MobileWallet } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import { APP_IDENTITY, MEMO_PROGRAM_ID, MWA_CHAIN, RPC_URL } from './config';
import { ChainFailure } from './errors';
import type { ParsedTxLike } from './verifyTx';

export interface WalletSession {
  address: string;
  authToken: string;
  label?: string;
}

const KEY = 'rugreplay.wallet';
let connection: Connection | null = null;
export function getConnection(): Connection {
  if (!connection) connection = new Connection(RPC_URL, 'confirmed');
  return connection;
}

export async function loadSession(): Promise<WalletSession | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as WalletSession;
    return typeof s.address === 'string' && typeof s.authToken === 'string' ? s : null;
  } catch {
    return null;
  }
}
async function saveSession(s: WalletSession | null): Promise<void> {
  try {
    if (s) await AsyncStorage.setItem(KEY, JSON.stringify(s));
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // remembering the wallet is a convenience only
  }
}

const toAddress = (b64: string) => new PublicKey(Buffer.from(b64, 'base64')).toBase58();

/** Opens the wallet app to pick an account. Rejects with a ChainFailure-classifiable error. */
export async function connectWallet(): Promise<WalletSession> {
  const session = await transact(async (wallet) => {
    const auth = await wallet.authorize({ identity: APP_IDENTITY, chain: MWA_CHAIN });
    const account = auth.accounts[0];
    if (!account) throw new ChainFailure('CONNECT_REJECTED');
    return { address: toAddress(account.address), authToken: auth.auth_token, label: account.label } as WalletSession;
  });
  await saveSession(session);
  return session;
}

export async function disconnectWallet(session: WalletSession | null): Promise<void> {
  await saveSession(null);
  if (!session) return;
  try {
    await transact(async (wallet) => {
      await wallet.deauthorize({ auth_token: session.authToken });
    });
  } catch {
    // already disconnected locally; the wallet app may simply not be reachable
  }
}

/** Reconnects to the same wallet inside an open session, refreshing the token. */
async function authorizeSame(wallet: Web3MobileWallet, session: WalletSession): Promise<WalletSession> {
  let auth;
  try {
    auth = await wallet.reauthorize({ auth_token: session.authToken, identity: APP_IDENTITY });
  } catch {
    auth = await wallet.authorize({ identity: APP_IDENTITY, chain: MWA_CHAIN });
  }
  const account = auth.accounts.find((a) => toAddress(a.address) === session.address);
  if (!account) throw new ChainFailure('CONNECT_REJECTED', 'The wallet no longer exposes the connected account.');
  const next = { ...session, authToken: auth.auth_token };
  void saveSession(next);
  return next;
}

/** Wallet signs and sends one transaction. `build` runs with a fresh blockhash. Returns the signature. */
export async function signAndSend(session: WalletSession, build: (blockhash: string, lastValidBlockHeight: number) => Transaction | Promise<Transaction>): Promise<string> {
  const conn = getConnection();
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = await build(blockhash, lastValidBlockHeight);
  const signature = await transact(async (wallet) => {
    await authorizeSame(wallet, session);
    const [sig] = await wallet.signAndSendTransactions({ transactions: [tx] });
    return sig;
  });
  try {
    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch {
    // sent but not yet confirmed here: the caller keeps the signature and can verify later
  }
  return signature;
}

/** Wallet signs an arbitrary message (used to derive a private, per-wallet badge address). */
export async function signMessageBytes(session: WalletSession, message: Uint8Array): Promise<Uint8Array> {
  return transact(async (wallet) => {
    await authorizeSame(wallet, session);
    const [signed] = await wallet.signMessages({ addresses: [Buffer.from(new PublicKey(session.address).toBytes()).toString('base64')], payloads: [message] });
    return signed;
  });
}

export function memoInstruction(memo: string, wallet: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: wallet, isSigner: true, isWritable: false }],
    data: Buffer.from(memo, 'utf8'),
  });
}

/** Sends the score memo, signed by the connected wallet. No SOL moves except the network fee. */
export async function sendMemo(session: WalletSession, memo: string): Promise<string> {
  const payer = new PublicKey(session.address);
  return signAndSend(session, (blockhash, lastValidBlockHeight) => new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(memoInstruction(memo, payer)));
}

export async function fetchParsedTx(signature: string): Promise<ParsedTxLike | null> {
  return (await getConnection().getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })) as unknown as ParsedTxLike | null;
}

/** Wallet signs and sends a transaction that was built elsewhere (for example by the issuer). */
export async function signAndSendPrepared(session: WalletSession, tx: Transaction): Promise<string> {
  const conn = getConnection();
  const signature = await transact(async (wallet) => {
    await authorizeSame(wallet, session);
    const [sig] = await wallet.signAndSendTransactions({ transactions: [tx] });
    return sig;
  });
  try {
    if (tx.recentBlockhash && tx.lastValidBlockHeight) await conn.confirmTransaction({ signature, blockhash: tx.recentBlockhash, lastValidBlockHeight: tx.lastValidBlockHeight }, 'confirmed');
  } catch {
    // sent but not yet confirmed here; the badge shows up on the next refresh
  }
  return signature;
}
