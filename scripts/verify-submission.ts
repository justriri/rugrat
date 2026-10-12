// Submission-facing fixes: debug panel, SKR price honesty, onchain wording, disclaimer, fair-play lock,
// icon / splash configuration, wallet identity, and that old onchain identifiers were NOT renamed.
// Part of `npm run verify:replay`. UI components are checked by their source (RN screens cannot be
// rendered here); the engine rules are checked by running the real engine.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { badgeSeedMessage } from '../src/badge/mint';
import { BADGE_DESCRIPTION, badgeAttributes } from '../src/badge/metadata';
import { uniqueVerifiedSurvivingRugs } from '../src/badge/achievement';
import { CHAIN_BADGE_LABEL, RECORDED_EXPLAINER } from '../src/chain/labels';
import { APP_IDENTITY, IDENTITY_ICON, IDENTITY_URI } from '../src/chain/config';
import { MEMO_PREFIX } from '../src/chain/memo';
import { buildRunResult } from '../src/competition/result';
import { HISTORICAL_NOTICE, LABEL_NOTE } from '../src/copy/notice';
import { REPLAYS } from '../src/data/replays';
import { ReplayEngine } from '../src/game/ReplayEngine';
import { signalEvent } from '../src/game/verdict';
import { PRICES_ARE_FINAL, TIERS, tierViews } from '../src/upgrade/tiers';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const uiFiles = [...walk('src/screens'), ...walk('src/components')].filter((f) => f.endsWith('.tsx'));
const pngInfo = (p: string) => {
  const b = readFileSync(join(root, p));
  return { sig: b.slice(1, 4).toString(), w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] };
};

console.log('\n== 1. debug panel is development-only ==');
{
  const g = strip(read('src/screens/GameScreen.tsx'));
  check(/const SHOW_DEBUG_PANEL = __DEV__;/.test(g) && !/SHOW_DEBUG_PANEL\s*=\s*true/.test(g), 'the debug panel is shown only when __DEV__ (false in every release / EAS build)');
  check(/\{SHOW_DEBUG_PANEL && \(\s*<DebugPanel/.test(g), 'the panel is rendered only behind that flag');
  const speedUse = uiFiles.filter((f) => /\bsetSpeed\b/.test(strip(read(f))));
  check(speedUse.length === 1 && speedUse[0].endsWith('GameScreen.tsx') && (g.match(/game\.setSpeed/g) ?? []).length === 1 && /const cycleSpeed = \(\) => \{[\s\S]*?game\.setSpeed/.test(g) && /onCycleSpeed=\{cycleSpeed\}/.test(g), 'the only playback-speed control in the UI is the debug panel\'s');
  check(uiFiles.every((f) => !/setDifficulty/.test(strip(read(f))) || f.endsWith('GameScreen.tsx') || f.endsWith('RugSelectScreen.tsx')), 'difficulty is set only by the world card and the game screen\'s start-up call');
  check(/export function DebugPanel/.test(read('src/components/DebugPanel.tsx')), 'the debug panel still exists for development');
}

console.log('\n== 2. fair-play lock (real engine) ==');
{
  const r = REPLAYS[0];
  const mk = () => new ReplayEngine(r, () => {}, () => 0);
  const finish = (e: ReplayEngine) => { for (let g = 0; e.getSnapshot().phase !== 'finished' && g < 1e6; g++) e.advanceForTest(1000); };

  const a = mk();
  a.setDifficulty('hard');
  a.start();
  a.advanceForTest(3000);
  a.setDifficulty('easy');
  check(a.getSnapshot().difficulty === 'hard' && !a.getSnapshot().tagsVisible, 'difficulty cannot be switched once the run has started (HARD stays HARD, tags stay hidden)');
  finish(a);
  a.setDifficulty('easy');
  check(a.getSnapshot().difficulty === 'hard', 'it also stays locked after the run ends');
  a.reset();
  check(a.getSnapshot().difficulty === 'hard', 'PLAY AGAIN keeps the same difficulty');
  a.dispose();

  const e = mk();
  e.setDifficulty('hard');
  e.start();
  check(e.getSnapshot().fairRun === true, 'a run at the intended speed is a fair run');
  e.setSpeed(r.playbackSpeed * 4);
  check(e.getSnapshot().fairRun === false, 'changing the playback speed mid-run makes it not fair');
  e.setSpeed(r.playbackSpeed);
  check(e.getSnapshot().fairRun === false, 'putting the speed back does not make the run fair again');
  e.reset();
  check(e.getSnapshot().fairRun === true, 'a fresh run at the intended speed is fair again');
  e.dispose();

  const slow = mk();
  slow.setSpeed(r.playbackSpeed * 0.5);
  slow.start();
  check(slow.getSnapshot().fairRun === false, 'starting a run at a slowed speed is not fair');
  slow.dispose();
  const fast = mk();
  fast.setSpeed(r.playbackSpeed);
  fast.start();
  check(fast.getSnapshot().fairRun === true, 'setting the default speed explicitly is still fair');
  fast.dispose();

  // scoring and results are untouched by any of this
  const sig = signalEvent(r)!;
  const buyAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.2;
  const sellAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.6;
  const play = (speedMult: number) => {
    const x = mk();
    x.setSpeed(r.playbackSpeed * speedMult);
    x.start();
    const speed = r.playbackSpeed * speedMult;
    // land exactly on the target timestamp whatever the speed (like the engine suite does)
    const adv = (t: number) => { for (let g = 0; g < 1e6; g++) { const ms = ((t - x.getSnapshot().clock.timestamp) / speed) * 1000; if (ms <= 1e-6) break; x.advanceForTest(Math.min(200, ms)); } };
    adv(buyAt); x.buy(); adv(sellAt); x.sell(); x.watchWhatHappened(); finish(x);
    const s = x.getSnapshot();
    x.dispose();
    return { fair: s.fairRun, res: JSON.stringify(buildRunResult(r, s.player, 'you')) };
  };
  const base = play(1);
  const quad = play(4);
  check(base.fair && !quad.fair && base.res === quad.res, 'the score and result are identical at any speed; only the fairness flag differs');

  const g = strip(read('src/screens/GameScreen.tsx'));
  check(/decided && result && game\.state\.fairRun &&/.test(g), 'the game screen records a run for competition only if it was a fair run');
  check(/extra=\{result && game\.state\.fairRun \?/.test(g), 'the "record onchain" step is offered only for fair runs');
}

console.log('\n== 3. placeholder SKR prices are not shown as real ==');
{
  check(PRICES_ARE_FINAL === false, 'prices are flagged as not final');
  const b = strip(read('src/screens/BadgePanel.tsx'));
  check(/const upgradesActive = avail\.available && PRICES_ARE_FINAL;/.test(b), 'the screen derives "active" from the flag and the configuration');
  // the price/upgrade rendering moved from BadgePanel into the pure badge catalogue; the guarantees are the same
  const cat = strip(read('src/badge/catalogue.ts'));
  check(/upgradesActive \? ` and pay \$\{formatPrice\(v\.tier\.priceBaseUnits\)\} SKR` : ''/.test(cat) && !/formatPrice/.test(b), 'a price is rendered only when upgrades are active (catalogue); the screen never prints one itself');
  check(/ELIGIBLE'\) status = i\.upgradesActive \? 'READY' : 'COMING_SOON'/.test(cat) && /e\.status === 'READY' && !!session/.test(b) && /COMING SOON/.test(b), 'the UPGRADE button exists only for READY (active) tiers; otherwise COMING SOON');
  check(!/(10|25|50)\s*SKR/.test(uiFiles.map((f) => strip(read(f))).join('\n')), 'no literal placeholder price appears in any screen');
  check(/Badge upgrades are not active yet/.test(b), 'the screen says badge upgrades are not active yet');
  check(TIERS.length === 3 && tierViews(uniqueVerifiedSurvivingRugs([], '', REPLAYS), []).every((v) => v.status === 'LOCKED'), 'the tier logic itself is unchanged');
}

console.log('\n== 4. onchain wording ==');
{
  check(CHAIN_BADGE_LABEL.ONCHAIN_VERIFIED === 'RECORDED ONCHAIN' && CHAIN_BADGE_LABEL.LOCAL === 'LOCAL' && CHAIN_BADGE_LABEL.SUBMITTED === 'SUBMITTED', 'status labels: LOCAL / SUBMITTED / RECORDED ONCHAIN');
  const code = uiFiles.map((f) => [f, strip(read(f))] as const);
  const old = code.filter(([, t]) => /ONCHAIN VERIFIED|verified onchain|onchain verified|ONCHAIN_VERIFIED['"`]\s*\?\s*['"`]/i.test(t.replace(/=== 'ONCHAIN_VERIFIED'/g, '')));
  check(old.length === 0, `no screen or component shows "ONCHAIN VERIFIED" or "verified onchain"${old.length ? ' (' + old.map((o) => o[0]).join(', ') + ')' : ''}`);
  const usesLabel = ['src/screens/CompetitionScreen.tsx', 'src/screens/BadgePanel.tsx', 'src/components/RecordScorePanel.tsx'].every((f) => /CHAIN_BADGE_LABEL/.test(read(f)));
  check(usesLabel, 'Competition / My Stats, Badge and the run result all take the wording from the one shared label map');
  check(/does not prove the run was played/i.test(RECORDED_EXPLAINER), 'the result screen explains what "recorded" does and does not mean');
  check(/export type ChainStatus = 'SUBMITTED' \| 'ONCHAIN_VERIFIED'/.test(read('src/chain/chainState.ts')), 'the stored status values are unchanged (saved data stays compatible)');
}

console.log('\n== 5. historical-data disclaimer ==');
{
  const n = HISTORICAL_NOTICE.toLowerCase();
  check(/historical/.test(n) && /practice replay/.test(n) && /derived/.test(n) && /not verified identities/.test(n) && /not affiliated/.test(n) && /dev, insider, smart, whale/.test(n), 'the notice says: practice replay, historical data, derived labels (DEV/INSIDER/SMART/WHALE), not verified identities, not affiliated');
  check(HISTORICAL_NOTICE.length <= 260 && LABEL_NOTE.length <= 70, 'the notice is short');
  check(/\{HISTORICAL_NOTICE\}/.test(read('src/screens/RugSelectScreen.tsx')), 'the full notice is shown on the world card');
  check(/\{LABEL_NOTE\}/.test(read('src/components/WalletFeed.tsx')) && /\{LABEL_NOTE\}/.test(read('src/components/ResultSheet.tsx')), 'the short note is shown on the wallet feed and the Reveal legend');
  check(!/FLAGGED/.test(read('src/components/WalletFeed.tsx')), 'the feed no longer says "FLAGGED" (it implied an accusation)');
}

console.log('\n== 6. app icon and splash ==');
{
  const cfg = JSON.parse(read('app.json')).expo;
  const icon = pngInfo(cfg.icon.replace('./', ''));
  check(icon.sig === 'PNG' && icon.w === 1024 && icon.h === 1024 && icon.colorType === 2, 'the launcher icon is a 1024x1024 opaque PNG');
  const fg = pngInfo(cfg.android.adaptiveIcon.foregroundImage.replace('./', ''));
  check(fg.sig === 'PNG' && fg.w === 1024 && fg.h === 1024 && fg.colorType === 6 && /^#[0-9a-f]{6}$/i.test(cfg.android.adaptiveIcon.backgroundColor), 'the adaptive-icon foreground is a 1024x1024 PNG with transparency, over a solid background colour');
  const splash = cfg.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'expo-splash-screen');
  check(!!splash && splash[1].image === './assets/splash-icon.png' && /^#[0-9a-f]{6}$/i.test(splash[1].backgroundColor) && pngInfo('assets/splash-icon.png').colorType === 6, 'the splash screen is configured with the Rugrat image on a solid colour');
  const pkg = JSON.parse(read('package.json'));
  check(!!pkg.dependencies['expo-splash-screen'], 'the (first-party) splash module is a dependency');
  check(cfg.android.package === 'com.rugreplay.app' && cfg.slug === 'rug-replay' && cfg.name === 'Rugrat', 'package name and slug are unchanged; the app is named Rugrat');
  check(/<rect x="1.6" y="0.6"/.test(read('assets/rugrat.svg')) && /f08a24/i.test(read('assets/rugrat.svg')), 'the artwork is the game\'s own character and colours (assets/rugrat.svg)');
}

console.log('\n== 7. wallet identity ==');
{
  const host = new URL(IDENTITY_URI).host;
  const easHost = new URL(JSON.parse(read('eas.json')).build.preview.env.EXPO_PUBLIC_BADGE_METADATA_URI).host;
  check(IDENTITY_URI.startsWith('https://') && !/rugreplay\.app/.test(IDENTITY_URI) && host === easHost, 'the identity URI is HTTPS on the host we already control (the Rugrat Expo site), not the old unowned domain');
  check(!/^https?:/.test(IDENTITY_ICON) && (IDENTITY_ICON as string) !== 'rug-hunter.png' && new URL(IDENTITY_ICON, IDENTITY_URI).href === 'https://rugrat-badge.expo.app/rugrat.png' && pngInfo('badge/site/rugrat.png').w === 512, 'the identity icon is the Rugrat app icon (rugrat.png), a relative path to a file we host, not the Rug Hunter badge');
  check(APP_IDENTITY.name === 'Rugrat' && APP_IDENTITY.uri === IDENTITY_URI && APP_IDENTITY.icon === IDENTITY_ICON, 'the identity sent to the wallet uses those values');
}

console.log('\n== 8. onchain identifiers were NOT renamed ==');
{
  check(MEMO_PREFIX === 'rugreplay/1', 'memo prefix unchanged');
  check(new TextDecoder().decode(badgeSeedMessage('W', 'devnet')).startsWith('Rug Replay: Rug Hunter badge v1\nWallet: W'), 'badge address seed message unchanged (addresses stay the same)');
  check(BADGE_DESCRIPTION === 'Earned by surviving 3 unique historical rug pulls in Rug Replay.' && badgeAttributes({ count: 3, required: 3, counted: [], unlocked: true }).some((a) => a.key === 'Game' && a.value === 'Rug Replay'), 'badge description and the Game attribute unchanged');
  const keys = ['src/competition/store.ts', 'src/chain/store.ts', 'src/chain/wallet.ts'].map(read).join('\n');
  check(['rugreplay.runs', 'rugreplay.chainRecords', 'rugreplay.badgeClaims', 'rugreplay.badgeProgress', 'rugreplay.wallet'].every((k) => keys.includes(`'${k}'`)), 'local storage keys unchanged (saved runs and records stay readable)');
}

console.log(`\nSUBMISSION PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
