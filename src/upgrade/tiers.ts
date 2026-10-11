// Badge upgrade tiers and eligibility (shared by the app and the issuer backend).
//
// Eligibility is derived ONLY from verified onchain score records (the same
// uniqueVerifiedSurvivingRugs the free Rug Hunter badge uses), never from a local counter.
// Paying never changes eligibility, scores or rankings: it only mints a cosmetic tier badge.
import type { AchievementProgress } from '../badge/achievement';

export interface UpgradeTier {
  tier: 1 | 2 | 3;
  name: string;
  /** Unique verified surviving rugs required. */
  requiredRugs: number;
  /** Price in the payment token's base units (SKR has 6 decimals). */
  priceBaseUnits: bigint;
}

/**
 * PRICES ARE PLACEHOLDERS: the business owner has not set them yet. They are only used with the
 * devnet test token until a real price is decided. Change them here, in one place.
 */
export const TIERS: readonly UpgradeTier[] = Object.freeze([
  { tier: 1, name: 'Rug Hunter I', requiredRugs: 3, priceBaseUnits: 10_000_000n },
  { tier: 2, name: 'Rug Hunter II', requiredRugs: 7, priceBaseUnits: 25_000_000n },
  { tier: 3, name: 'Rug Hunter III', requiredRugs: 15, priceBaseUnits: 50_000_000n },
]);

/**
 * Flip to true ONLY when the prices above are the real, final prices. While false, the app does not
 * show any price, and does not offer the upgrade button: the upgrade system is "not active yet".
 */
export const PRICES_ARE_FINAL = false;

export const tierByNumber = (n: number): UpgradeTier | null => TIERS.find((t) => t.tier === n) ?? null;

export type TierStatus = 'LOCKED' | 'ELIGIBLE' | 'OWNED';

export interface TierView {
  tier: UpgradeTier;
  status: TierStatus;
  /** Unique rugs survived so far (capped at what this tier needs, for display "x / n"). */
  have: number;
}

/**
 * A tier is ELIGIBLE when the verified unique-rug count reaches its requirement and the wallet does
 * not already own it. Tiers are independent: owning tier 1 is not required to buy tier 2.
 */
export function tierViews(progress: AchievementProgress, owned: readonly number[]): TierView[] {
  return TIERS.map((tier) => ({
    tier,
    have: Math.min(progress.count, tier.requiredRugs),
    status: owned.includes(tier.tier) ? 'OWNED' : progress.count >= tier.requiredRugs ? 'ELIGIBLE' : 'LOCKED',
  }));
}

export function formatPrice(base: bigint, decimals = 6): string {
  const unit = 10n ** BigInt(decimals);
  const frac = (base % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${base / unit}.${frac}` : `${base / unit}`;
}
