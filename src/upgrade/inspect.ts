// Client-side safety check of the transaction the issuer sends back. The wallet is only asked to
// sign if the transaction does EXACTLY what the app expects, judged against the app's OWN config
// (treasury, payment token, price), never against what the server claims. A compromised or buggy
// server therefore cannot make the app ask for a different payment.
import { ASSOCIATED_TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, Transaction } from '@solana/web3.js';

import { MEMO_PROGRAM_ID } from '../chain/config';
import { upgradeMemoText } from './memoText';

export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

export interface Expectation {
  wallet: string;
  tier: number;
  paymentMint: string;
  paymentDecimals: number;
  treasury: string;
  amount: bigint;
}

export type Inspection = { ok: true; tx: Transaction } | { ok: false; reason: string };

export function inspectUpgradeTransaction(base64: string, exp: Expectation): Inspection {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(base64, 'base64'));
  } catch {
    return { ok: false, reason: 'unreadable transaction' };
  }
  const wallet = new PublicKey(exp.wallet);
  const mint = new PublicKey(exp.paymentMint);
  const treasury = new PublicKey(exp.treasury);
  const from = getAssociatedTokenAddressSync(mint, wallet);
  const to = getAssociatedTokenAddressSync(mint, treasury, true);

  if (!tx.feePayer || !tx.feePayer.equals(wallet)) return { ok: false, reason: 'fee payer is not your wallet' };
  const allowed = new Set([ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58(), MEMO_PROGRAM_ID, MPL_CORE_PROGRAM]);
  if (tx.instructions.some((i) => !allowed.has(i.programId.toBase58()))) return { ok: false, reason: 'unexpected program in transaction' };

  const transfers = tx.instructions.filter((i) => i.programId.equals(TOKEN_PROGRAM_ID));
  if (transfers.length !== 1) return { ok: false, reason: 'expected exactly one token instruction' };
  try {
    const d = decodeTransferCheckedInstruction(transfers[0], TOKEN_PROGRAM_ID);
    if (!d.keys.source.pubkey.equals(from) || !d.keys.destination.pubkey.equals(to) || !d.keys.mint.pubkey.equals(mint) || !d.keys.owner.pubkey.equals(wallet)) return { ok: false, reason: 'payment accounts differ from the expected ones' };
    if (d.data.amount !== exp.amount || d.data.decimals !== exp.paymentDecimals) return { ok: false, reason: 'payment amount differs from the tier price' };
  } catch {
    return { ok: false, reason: 'token instruction is not a checked transfer' };
  }

  const atas = tx.instructions.filter((i) => i.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  for (const a of atas) {
    // only "create the treasury's token account if missing", paid for by the player
    if (a.keys.length < 4 || !a.keys[1].pubkey.equals(to) || !a.keys[2].pubkey.equals(treasury) || !a.keys[3].pubkey.equals(mint)) return { ok: false, reason: 'unexpected token account instruction' };
  }

  const memos = tx.instructions.filter((i) => i.programId.toBase58() === MEMO_PROGRAM_ID);
  if (memos.length !== 1 || memos[0].data.toString('utf8') !== upgradeMemoText(exp.wallet, exp.tier)) return { ok: false, reason: 'memo does not match this upgrade' };

  const core = tx.instructions.filter((i) => i.programId.toBase58() === MPL_CORE_PROGRAM);
  if (core.length !== 1) return { ok: false, reason: 'expected exactly one badge instruction' };
  // the badge must be owned by the player's wallet
  if (!core[0].keys.some((k) => k.pubkey.equals(wallet))) return { ok: false, reason: 'badge is not for your wallet' };
  return { ok: true, tx };
}
