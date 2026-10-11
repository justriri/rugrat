// Read-only SKR balance detection. One RPC read per check, no transaction, no signature, no keys.
import { validMintAddress } from './config';

export type SkrReadError = 'INVALID_MINT' | 'NETWORK_MISMATCH' | 'RPC_FAILURE' | 'READ_FAILED';

export type SkrReading =
  /** `raw` is in base units (6 decimals); `accounts` is how many token accounts hold it. */
  | { ok: true; raw: bigint; accounts: number }
  | { ok: false; error: SkrReadError };

/** The slice of a web3.js Connection the check needs (easy to fake in tests). */
export interface SkrConnection {
  getParsedTokenAccountsByOwner(owner: any, filter: { mint: any }): Promise<{ value: { account: { data: any } }[] }>;
  getAccountInfo(address: any): Promise<unknown | null>;
}

export interface SkrDeps {
  connection: SkrConnection;
  /** Builds the PublicKey form web3.js wants (injected so tests need no web3.js). */
  toKey: (address: string) => any;
}

/**
 * The wallet's SKR in base units, summed over all its SKR token accounts.
 *  - no token account at all  -> ok, raw 0 (a wallet that never held SKR);
 *  - the mint is not found on this RPC -> NETWORK_MISMATCH (wrong cluster configured);
 *  - the RPC throws -> RPC_FAILURE; an unreadable account shape -> READ_FAILED;
 *  - a bad mint configuration -> INVALID_MINT (nothing is called).
 */
export async function readSkrBalance(wallet: string, mint: string, deps: SkrDeps): Promise<SkrReading> {
  if (!validMintAddress(mint)) return { ok: false, error: 'INVALID_MINT' };
  let res;
  try {
    res = await deps.connection.getParsedTokenAccountsByOwner(deps.toKey(wallet), { mint: deps.toKey(mint) });
  } catch {
    return { ok: false, error: 'RPC_FAILURE' };
  }
  let raw = 0n;
  try {
    for (const { account } of res.value) {
      const amount = account.data?.parsed?.info?.tokenAmount?.amount;
      if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return { ok: false, error: 'READ_FAILED' };
      raw += BigInt(amount);
    }
  } catch {
    return { ok: false, error: 'READ_FAILED' };
  }
  if (res.value.length === 0) {
    // either the wallet never held SKR, or this RPC is on a cluster where the mint does not exist
    try {
      if ((await deps.connection.getAccountInfo(deps.toKey(mint))) === null) return { ok: false, error: 'NETWORK_MISMATCH' };
    } catch {
      return { ok: false, error: 'RPC_FAILURE' };
    }
  }
  return { ok: true, raw, accounts: res.value.length };
}

/** "123.45" from base units; trims trailing zeros, no floating point. */
export function formatSkr(raw: bigint, decimals = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole.toLocaleString('en-US')}.${frac.slice(0, 4)}` : whole.toLocaleString('en-US');
}
