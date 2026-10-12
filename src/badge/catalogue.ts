// The badge catalogue the Badge screen shows: every badge Rugrat has, what earns it, and its real
// state. Pure (no React, no network): the screen only renders what this returns.
//
// Honesty rules encoded here:
//  - a badge is ONCHAIN_NFT only when a Metaplex Core asset is actually minted for it; the SKR holder
//    status is IN_GAME (live, derived from the wallet's balance, not an NFT and not stored);
//  - progress comes only from onchain-verified score records (AchievementProgress);
//  - a paid upgrade is READY only when upgrades are really active (issuer + treasury + final prices).
import { RUG_HUNTER_REQUIRED, AchievementProgress, BadgeStatus } from './achievement';
import { SkrState } from '../skr/status';
import { TierView, formatPrice } from '../upgrade/tiers';

export type BadgeKind = 'ONCHAIN_NFT' | 'IN_GAME';
export type CatalogueStatus = 'LOCKED' | 'READY' | 'EARNED' | 'COMING_SOON' | 'UNKNOWN';

export interface BadgeEntry {
  id: string;
  name: string;
  kind: BadgeKind;
  status: CatalogueStatus;
  /** How it is earned, in plain words. */
  condition: string;
  /** Progress toward the condition, when it has a count. */
  progress: { have: number; need: number } | null;
  /** Extra honest context (why it is not available, what it is not). */
  note: string | null;
}

export interface CatalogueInput {
  progress: AchievementProgress;
  badge: BadgeStatus;
  tiers: readonly TierView[];
  /** True only when an issuer, a payment token, a treasury and FINAL prices are all in place. */
  upgradesActive: boolean;
  skr: SkrState;
  /** How many real rugs the catalogue holds (a tier needing more can never be reached yet). */
  catalogueSize: number;
}

export function skrHolderStatus(skr: SkrState): CatalogueStatus {
  if (skr.kind === 'HOLDER') return 'EARNED';
  if (skr.kind === 'LOCKED' || skr.kind === 'DISCONNECTED') return 'LOCKED';
  if (skr.kind === 'ERROR') return skr.lastKnown ? (skr.lastKnown.holder ? 'EARNED' : 'LOCKED') : 'UNKNOWN';
  return 'UNKNOWN'; // UNCHECKED: connected, first read not finished
}

export function badgeCatalogue(i: CatalogueInput): BadgeEntry[] {
  const out: BadgeEntry[] = [];
  out.push({
    id: 'rug-hunter',
    name: 'Rug Hunter',
    kind: 'ONCHAIN_NFT',
    status: i.badge === 'CLAIMED' ? 'EARNED' : i.badge === 'UNLOCKED' ? 'READY' : 'LOCKED',
    condition: `Survive ${RUG_HUNTER_REQUIRED} different real rugs (clean or late exit). Only scores recorded onchain count.`,
    progress: { have: Math.min(i.progress.count, RUG_HUNTER_REQUIRED), need: RUG_HUNTER_REQUIRED },
    note: 'A non-transferable Metaplex Core badge, minted to your wallet when you claim it.',
  });
  for (const v of i.tiers) {
    const unreachable = v.tier.requiredRugs > i.catalogueSize;
    let status: CatalogueStatus;
    if (v.status === 'OWNED') status = 'EARNED';
    else if (v.status === 'ELIGIBLE') status = i.upgradesActive ? 'READY' : 'COMING_SOON';
    else status = 'LOCKED';
    out.push({
      id: `rug-hunter-${v.tier.tier}`,
      name: v.tier.name,
      kind: 'ONCHAIN_NFT',
      status,
      condition: `Survive ${v.tier.requiredRugs} different real rugs${i.upgradesActive ? ` and pay ${formatPrice(v.tier.priceBaseUnits)} SKR` : ''}.`,
      progress: { have: Math.min(i.progress.count, v.tier.requiredRugs), need: v.tier.requiredRugs },
      note: unreachable
        ? `Needs ${v.tier.requiredRugs} rugs; the catalogue has ${i.catalogueSize} so far.`
        : i.upgradesActive
          ? 'Cosmetic only. Never changes score, rank or prizes.'
          : 'Paid SKR upgrades are not active yet; no price is set.',
    });
  }
  out.push({
    id: 'skr-holder',
    name: 'SKR Holder',
    kind: 'IN_GAME',
    status: skrHolderStatus(i.skr),
    condition: 'Hold any SKR in the connected wallet.',
    progress: null,
    note: 'Read live from your wallet balance. An in-game status that unlocks the SKR skin and twilight arena; not an NFT.',
  });
  return out;
}

// ---- can this wallet pay for an upgrade? ----

export type Affordability =
  | { kind: 'OK'; balance: bigint }
  | { kind: 'INSUFFICIENT'; balance: bigint; short: bigint }
  /** Balance not known (disconnected, not read yet, or the read failed with no earlier reading). */
  | { kind: 'UNKNOWN' };

/** Whether the last SKR reading covers `price` (base units). Unknown is never treated as enough. */
export function affordability(skr: SkrState, price: bigint): Affordability {
  let balance: bigint | null = null;
  if (skr.kind === 'HOLDER') balance = skr.raw;
  else if (skr.kind === 'LOCKED') balance = 0n;
  else if (skr.kind === 'ERROR' && skr.lastKnown) balance = skr.lastKnown.raw;
  if (balance === null) return { kind: 'UNKNOWN' };
  return balance >= price ? { kind: 'OK', balance } : { kind: 'INSUFFICIENT', balance, short: price - balance };
}
