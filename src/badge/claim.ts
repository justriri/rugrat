// Claiming the badge, as a pure orchestration over injected dependencies (so every path is testable
// without a device). The eligibility check ALWAYS re-reads the chain: nothing the client stored or
// passed in can make it eligible, and the minted attributes come from that fresh result.
import type { Replay } from '../game/types';
import type { Cluster } from '../chain/config';
import { ChainError, classifyError } from '../chain/errors';
import type { VerifiedChainRun } from '../chain/verifyTx';
import { AchievementProgress, uniqueVerifiedSurvivingRugs } from './achievement';

export interface BadgeClaim {
  wallet: string;
  /** The Metaplex Core asset address. */
  assetAddress: string;
  /** The mint transaction (null when the badge was found already minted, e.g. after a reinstall). */
  signature: string | null;
  network: Cluster;
  rugsSurvived: number;
  claimedAt: number;
}

export function claimFor(claims: readonly BadgeClaim[], wallet: string, network: Cluster): BadgeClaim | null {
  return claims.find((c) => c.wallet === wallet && c.network === network) ?? null;
}

export interface ClaimDeps {
  cluster: Cluster;
  replays: readonly Replay[];
  now: () => number;
  /** Verified score records read from the chain for this wallet. */
  fetchVerifiedRuns: (wallet: string) => Promise<VerifiedChainRun[]>;
  /** The wallet's badge asset address if it already exists onchain, else null. */
  existingBadge: (wallet: string) => Promise<string | null>;
  /** Wallet signs and sends the mint. */
  mint: (wallet: string, progress: AchievementProgress) => Promise<{ assetAddress: string; signature: string }>;
  save: (claims: BadgeClaim[]) => void;
}

export type ClaimOutcome =
  | { ok: true; claim: BadgeClaim }
  | { ok: false; reason: 'NOT_ELIGIBLE'; progress: AchievementProgress }
  | { ok: false; reason: 'ALREADY_CLAIMED'; claim: BadgeClaim }
  | { ok: false; reason: 'ERROR'; error: ChainError };

export async function claimBadge(wallet: string, getClaims: () => BadgeClaim[], deps: ClaimDeps): Promise<ClaimOutcome> {
  const local = claimFor(getClaims(), wallet, deps.cluster);
  if (local) return { ok: false, reason: 'ALREADY_CLAIMED', claim: local };
  try {
    const progress = uniqueVerifiedSurvivingRugs(await deps.fetchVerifiedRuns(wallet), wallet, deps.replays);
    if (!progress.unlocked) return { ok: false, reason: 'NOT_ELIGIBLE', progress };

    const existing = await deps.existingBadge(wallet);
    if (existing) {
      const claim: BadgeClaim = { wallet, assetAddress: existing, signature: null, network: deps.cluster, rugsSurvived: progress.count, claimedAt: deps.now() };
      deps.save([...getClaims(), claim]);
      return { ok: false, reason: 'ALREADY_CLAIMED', claim };
    }
    const { assetAddress, signature } = await deps.mint(wallet, progress);
    const claim: BadgeClaim = { wallet, assetAddress, signature, network: deps.cluster, rugsSurvived: progress.count, claimedAt: deps.now() };
    deps.save([...getClaims(), claim]);
    return { ok: true, claim };
  } catch (e) {
    return { ok: false, reason: 'ERROR', error: classifyError(e) };
  }
}
