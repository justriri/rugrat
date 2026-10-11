// What the app concludes from an SKR reading, and what that unlocks. Pure and cosmetic-only:
// nothing here is read by scoring, the verdict, trading, the leaderboard or any competition code.
import type { SkrReadError, SkrReading } from './balance';

export type SkrState =
  | { kind: 'DISCONNECTED' }
  /** Connected, nothing read yet. */
  | { kind: 'UNCHECKED' }
  | { kind: 'HOLDER'; raw: bigint; stale: boolean }
  | { kind: 'LOCKED'; hasAccount: boolean }
  /** The balance could not be read; `lastKnown` is the last good reading for this same wallet. */
  | { kind: 'ERROR'; error: SkrReadError; lastKnown: { holder: boolean; raw: bigint } | null };

export interface SkrPerks {
  characterSkin: boolean;
  arena: boolean;
}
export const NO_PERKS: SkrPerks = { characterSkin: false, arena: false };

/** Any non-zero SKR balance is a holder: no invented minimum. */
export const isHolderBalance = (raw: bigint) => raw > 0n;

/**
 * Folds a new reading into the state. A failed read never takes a perk away by itself (the player
 * may just be offline) and never grants one that was not already proven for this wallet; only a
 * successful read of zero removes it.
 */
export function nextSkrState(wallet: string | null, reading: SkrReading | null, previous: SkrState): SkrState {
  if (!wallet) return { kind: 'DISCONNECTED' };
  if (!reading) return previous.kind === 'DISCONNECTED' ? { kind: 'UNCHECKED' } : previous;
  if (reading.ok) {
    return isHolderBalance(reading.raw) ? { kind: 'HOLDER', raw: reading.raw, stale: false } : { kind: 'LOCKED', hasAccount: reading.accounts > 0 };
  }
  const lastKnown = previous.kind === 'HOLDER' ? { holder: true, raw: previous.raw } : previous.kind === 'LOCKED' ? { holder: false, raw: 0n } : previous.kind === 'ERROR' ? previous.lastKnown : null;
  return { kind: 'ERROR', error: reading.error, lastKnown };
}

export function perksFor(state: SkrState): SkrPerks {
  const holder = state.kind === 'HOLDER' || (state.kind === 'ERROR' && state.lastKnown?.holder === true);
  return holder ? { characterSkin: true, arena: true } : NO_PERKS;
}

/** Real wallet holders only: DEMO players have no wallet and are never holders. */
export function isSkrHolderPlayer(player: { demo: boolean }, state: SkrState): boolean {
  return !player.demo && perksFor(state).characterSkin;
}

export const SKR_ERROR_TEXT: Record<SkrReadError, string> = {
  INVALID_MINT: 'SKR is not configured correctly in this build.',
  NETWORK_MISMATCH: 'SKR was not found on the network being checked.',
  RPC_FAILURE: "Couldn't reach the network to check SKR. The game works as normal.",
  READ_FAILED: "Couldn't read your SKR balance. The game works as normal.",
};
