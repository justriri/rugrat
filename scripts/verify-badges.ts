// Badge catalogue and SKR affordability verification. Part of `npm run verify:replay`.
// Pure logic only: no network, no wallet. It proves the Badge screen's states are derived from real
// progress, never invented; it does not prove an onchain mint (that needs a device / network test).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AchievementProgress, badgeStatus, RUG_HUNTER_REQUIRED, uniqueVerifiedSurvivingRugs } from '../src/badge/achievement';
import { affordability, badgeCatalogue, skrHolderStatus } from '../src/badge/catalogue';
import { REPLAYS } from '../src/data/replays';
import { SkrState } from '../src/skr/status';
import { TIERS, tierViews } from '../src/upgrade/tiers';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};

const prog = (n: number): AchievementProgress => ({ required: RUG_HUNTER_REQUIRED, counted: [], count: n, unlocked: n >= RUG_HUNTER_REQUIRED });
const DISC: SkrState = { kind: 'DISCONNECTED' };
const mk = (n: number, o: { claimed?: boolean; owned?: number[]; active?: boolean; skr?: SkrState } = {}) => {
  const p = prog(n);
  const badge = badgeStatus(p, !!o.claimed);
  return badgeCatalogue({ progress: p, badge, tiers: tierViews(p, o.owned ?? []), upgradesActive: !!o.active, skr: o.skr ?? DISC, catalogueSize: REPLAYS.length });
};
const get = (c: ReturnType<typeof mk>, id: string) => c.find((e) => e.id === id)!;

console.log('\n== Rug Hunter states follow verified progress ==');
{
  check(get(mk(0), 'rug-hunter').status === 'LOCKED' && get(mk(2), 'rug-hunter').status === 'LOCKED', 'below 3 unique rugs the badge is LOCKED');
  check(get(mk(2), 'rug-hunter').progress?.have === 2 && get(mk(2), 'rug-hunter').progress?.need === 3, 'progress shows 2 / 3');
  check(get(mk(3), 'rug-hunter').status === 'READY', '3 unique rugs: READY to claim');
  check(get(mk(3, { claimed: true }), 'rug-hunter').status === 'EARNED', 'once claimed: EARNED');
  check(get(mk(4), 'rug-hunter').progress?.have === 3, 'progress is capped at what the badge needs');
  check(get(mk(0, { claimed: true }), 'rug-hunter').status === 'EARNED', 'a claim found for the wallet shows EARNED even if progress has not loaded');
  const real = uniqueVerifiedSurvivingRugs([], 'W', REPLAYS);
  const c = badgeCatalogue({ progress: real, badge: 'LOCKED', tiers: tierViews(real, []), upgradesActive: false, skr: DISC, catalogueSize: 4 });
  check(real.count === 0 && get(c, 'rug-hunter').status === 'LOCKED', 'no verified runs (demo, local or none): LOCKED');
}

console.log('\n== tiers are honest about availability ==');
{
  check(TIERS.length === 3 && ['rug-hunter-1', 'rug-hunter-2', 'rug-hunter-3'].every((id) => mk(0).some((e) => e.id === id)), 'three upgrade tiers are listed');
  check(get(mk(3), 'rug-hunter-1').status === 'COMING_SOON', 'eligible but upgrades inactive: COMING_SOON, not buyable');
  check(get(mk(3, { active: true }), 'rug-hunter-1').status === 'READY', 'eligible and upgrades active: READY');
  check(get(mk(2, { active: true }), 'rug-hunter-1').status === 'LOCKED', 'not enough rugs: LOCKED');
  check(get(mk(3, { owned: [1], active: true }), 'rug-hunter-1').status === 'EARNED', 'an owned tier is EARNED');
  check(!get(mk(3), 'rug-hunter-1').condition.includes('SKR') && get(mk(3, { active: true }), 'rug-hunter-1').condition.includes('SKR'), 'a price/SKR cost is shown only when upgrades are active');
  check(/catalogue has 4/.test(get(mk(0), 'rug-hunter-2').note ?? '') && /catalogue has 4/.test(get(mk(0), 'rug-hunter-3').note ?? ''), 'tiers II and III say the catalogue is too small today');
  check(!/catalogue has/.test(get(mk(0), 'rug-hunter-1').note ?? ''), 'tier I is reachable and says so');
  check(mk(0).filter((e) => e.kind === 'ONCHAIN_NFT').length === 4 && get(mk(0), 'skr-holder').kind === 'IN_GAME', 'only Rug Hunter and its tiers are NFTs; SKR Holder is an in-game status');
}

console.log('\n== SKR Holder status ==');
{
  const H: SkrState = { kind: 'HOLDER', raw: 5n, stale: false };
  check(skrHolderStatus(DISC) === 'LOCKED', 'disconnected: LOCKED');
  check(skrHolderStatus({ kind: 'UNCHECKED' }) === 'UNKNOWN', 'connected, not read yet: UNKNOWN (never shown as earned)');
  check(skrHolderStatus({ kind: 'LOCKED', hasAccount: true }) === 'LOCKED' && skrHolderStatus({ kind: 'LOCKED', hasAccount: false }) === 'LOCKED', 'zero balance: LOCKED');
  check(skrHolderStatus(H) === 'EARNED', 'positive balance: EARNED');
  check(skrHolderStatus({ kind: 'ERROR', error: 'RPC_FAILURE', lastKnown: null }) === 'UNKNOWN', 'failed read with no earlier reading: UNKNOWN');
  check(skrHolderStatus({ kind: 'ERROR', error: 'RPC_FAILURE', lastKnown: { holder: true, raw: 5n } }) === 'EARNED', 'failed refresh keeps a proven holder');
  check(get(mk(0, { skr: H }), 'skr-holder').progress === null, 'SKR Holder has no fake progress counter');
}

console.log('\n== can the wallet afford an upgrade? ==');
{
  const price = TIERS[0].priceBaseUnits;
  check(affordability(DISC, price).kind === 'UNKNOWN' && affordability({ kind: 'UNCHECKED' }, price).kind === 'UNKNOWN', 'disconnected or unread: UNKNOWN, never assumed enough');
  const zero = affordability({ kind: 'LOCKED', hasAccount: false }, price);
  check(zero.kind === 'INSUFFICIENT' && zero.balance === 0n && zero.short === price, 'zero balance: INSUFFICIENT, short by the full price');
  const part = affordability({ kind: 'HOLDER', raw: price - 1n, stale: false }, price);
  check(part.kind === 'INSUFFICIENT' && part.short === 1n, 'one base unit short: INSUFFICIENT by exactly 1');
  check(affordability({ kind: 'HOLDER', raw: price, stale: false }, price).kind === 'OK', 'exact price: OK');
  check(affordability({ kind: 'HOLDER', raw: price * 3n, stale: false }, price).kind === 'OK', 'more than the price: OK');
  check(affordability({ kind: 'ERROR', error: 'RPC_FAILURE', lastKnown: null }, price).kind === 'UNKNOWN', 'failed read, nothing known: UNKNOWN');
  check(affordability({ kind: 'ERROR', error: 'RPC_FAILURE', lastKnown: { holder: false, raw: 0n } }, price).kind === 'INSUFFICIENT', 'failed refresh after a known zero: still INSUFFICIENT');
}

console.log('\n== wiring ==');
{
  const panel = readFileSync(join(__dirname, '..', 'src/screens/BadgePanel.tsx'), 'utf8');
  check(/badgeCatalogue\(/.test(panel) && /affordability\(/.test(panel), 'the Badge screen renders the catalogue and gates upgrades on affordability');
  check(/not an NFT/.test(panel), 'the screen labels in-game statuses as not NFTs');
  const tiers = readFileSync(join(__dirname, '..', 'src/upgrade/tiers.ts'), 'utf8');
  check(/PRICES_ARE_FINAL = false/.test(tiers), 'paid upgrades remain gated off until real prices are set (no price was invented)');
}

console.log(`\nBADGES PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
