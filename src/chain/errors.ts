// Maps whatever the wallet / RPC / network throws to a small set of player-facing cases.
// A failed onchain step never touches the saved run; it only produces one of these.
export type ChainErrorCode =
  | 'WALLET_NOT_INSTALLED'
  | 'CONNECT_REJECTED'
  | 'TX_REJECTED'
  | 'INSUFFICIENT_FUNDS'
  | 'RPC_FAILURE'
  | 'NETWORK_FAILURE'
  | 'ALREADY_RECORDED'
  | 'MALFORMED_MEMO'
  | 'INTERRUPTED'
  | 'UNKNOWN';

export interface ChainError {
  code: ChainErrorCode;
  message: string;
}

export const CHAIN_MESSAGES: Record<ChainErrorCode, string> = {
  WALLET_NOT_INSTALLED: 'No Solana wallet app was found on this device.',
  CONNECT_REJECTED: 'Wallet connection was cancelled. Your result is saved.',
  TX_REJECTED: 'Transaction was declined. Your result is saved and still counts locally.',
  INSUFFICIENT_FUNDS: 'Not enough SOL in the wallet to pay the network fee. Your result is saved.',
  RPC_FAILURE: 'The Solana network did not accept the request. Your result is saved; try again.',
  NETWORK_FAILURE: 'No network connection. Your result is saved; try again when online.',
  ALREADY_RECORDED: 'Already recorded',
  MALFORMED_MEMO: 'The score record could not be built. Your result is saved.',
  INTERRUPTED: 'The transaction was interrupted. Check the wallet; your result is saved.',
  UNKNOWN: 'Something went wrong. Your result is saved.',
};

/** Thrown by our own code with an explicit case. */
export class ChainFailure extends Error {
  constructor(readonly code: ChainErrorCode, detail?: string) {
    super(detail ?? CHAIN_MESSAGES[code]);
    this.name = 'ChainFailure';
  }
}

export function classifyError(e: unknown): ChainError {
  if (e instanceof ChainFailure) return { code: e.code, message: CHAIN_MESSAGES[e.code] };
  const err = e as { code?: unknown; name?: unknown; message?: unknown } | null;
  const text = `${err?.name ?? ''} ${err?.message ?? e ?? ''}`.toLowerCase();
  const code = String(err?.code ?? '');
  let c: ChainErrorCode = 'UNKNOWN';
  if (/found no installed wallet|no wallet|wallet not found|activitynotfound|no_wallet/.test(text)) c = 'WALLET_NOT_INSTALLED';
  else if (/declined|rejected|cancel|user denied|access_denied/.test(text) || code === 'ERROR_AUTHORIZATION_FAILED') {
    c = /authoriz|connect/.test(text) && !/transaction|sign/.test(text) ? 'CONNECT_REJECTED' : 'TX_REJECTED';
  } else if (/insufficient funds|insufficient lamports|attempt to debit an account but found no record/.test(text)) c = 'INSUFFICIENT_FUNDS';
  else if (/network request failed|failed to fetch|enotfound|econnreset|etimedout|offline|no internet/.test(text)) c = 'NETWORK_FAILURE';
  else if (/429|too many requests|rpc|503|502|500|blockhash|node is behind|timeout|timed out|unable to confirm|block height exceeded/.test(text)) c = 'RPC_FAILURE';
  else if (/interrupt|abort|session closed|disconnected/.test(text)) c = 'INTERRUPTED';
  return { code: c, message: CHAIN_MESSAGES[c] };
}
