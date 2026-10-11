// Mainnet-preparation safety checks. Deterministic and OFFLINE: they read configuration and source,
// and call pure functions. (The live hosted-asset / SKR-mint checks are `npm run check:live`.)
// Nothing here talks to a network or signs anything.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Keypair } from '@solana/web3.js';

import { buildBadgeInstructions, badgeSeedMessage } from '../src/badge/mint';
import { BADGE_NAME } from '../src/badge/metadata';
import { uniqueVerifiedSurvivingRugs } from '../src/badge/achievement';
import { progressCacheApplies } from '../src/chain/chainState';
import { APP_IDENTITY, CLUSTER, IDENTITY_ICON, IDENTITY_URI, MWA_CHAIN, MWA_CHAIN_ID, RPC_IS_PUBLIC_DEFAULT, RPC_URL, explorerAddressUrl, explorerTxUrl, resolveCluster, resolveRpcUrl } from '../src/chain/config';
import { REPLAYS } from '../src/data/replays';
import { PAYOUT_GATE } from '../src/prize/pool';
import { SKR_CLUSTER, SKR_MINT, resolveSkrRpc } from '../src/skr/config';
import { isHolderBalance } from '../src/skr/status';
import { describeUpgradeConfig, upgradeAvailability } from '../src/upgrade/config';
import { PRICES_ARE_FINAL } from '../src/upgrade/tiers';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};
const throws = (f: () => unknown) => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));

const eas = JSON.parse(read('eas.json')).build as Record<string, { env?: Record<string, string>; environment?: string }>;
const prodEnv = eas.production.env ?? {};
const previewEnv = eas.preview.env ?? {};
const WALLET = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const TREAS = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();

console.log('\n== development vs production network ==');
check(resolveCluster('devnet', false) === 'devnet' && resolveCluster('mainnet-beta', false) === 'mainnet-beta', 'both clusters resolve in a release build when set explicitly');
check(throws(() => resolveCluster(undefined, false)) && throws(() => resolveCluster('', false)) && throws(() => resolveCluster('  ', false)), 'a RELEASE build with no cluster configured refuses to start (no silent devnet fallback)');
check(throws(() => resolveCluster('mainnet', false)) && throws(() => resolveCluster('Mainnet-Beta', true)) && throws(() => resolveCluster('testnet', true)), 'a misspelled or unsupported cluster is an error, in development too (it used to fall back to devnet)');
check(resolveCluster(undefined, true) === 'devnet' && CLUSTER === 'devnet', 'development with nothing set uses devnet (and the test environment counts as development)');
check(prodEnv.EXPO_PUBLIC_SOLANA_CLUSTER === 'mainnet-beta', 'the EAS production profile builds for mainnet-beta');
check(previewEnv.EXPO_PUBLIC_SOLANA_CLUSTER === 'devnet', 'the EAS preview profile (test APKs) is explicitly devnet');
check(Object.values(prodEnv).every((v) => !/devnet|testnet|localhost|127\.0\.0\.1/i.test(v)), 'no production environment value mentions devnet, testnet or localhost');
check(resolveRpcUrl('mainnet-beta', undefined).url === 'https://api.mainnet-beta.solana.com' && resolveRpcUrl('devnet', undefined).url === 'https://api.devnet.solana.com', 'default RPC per cluster');
check(throws(() => resolveRpcUrl('mainnet-beta', 'https://api.devnet.solana.com')) && throws(() => resolveRpcUrl('mainnet-beta', 'https://x.testnet.example')) && throws(() => resolveRpcUrl('devnet', 'https://mainnet.helius-rpc.example')), 'an RPC pointing at the wrong cluster is rejected (production can never silently use devnet)');
check(throws(() => resolveRpcUrl('mainnet-beta', 'http://insecure.example')) && resolveRpcUrl('mainnet-beta', 'https://rpc.example/x').isPublicDefault === false, 'an RPC override must be https; a real override is not "public default"');
check(resolveRpcUrl('mainnet-beta', undefined).isPublicDefault === true && RPC_IS_PUBLIC_DEFAULT === true && RPC_URL.startsWith('https://api.'), 'the app says plainly when it is on the public (non-production-grade) RPC: production RPC provider is PENDING');
check(!('EXPO_PUBLIC_SOLANA_RPC' in prodEnv), 'no production RPC is configured yet (pending a provider) and none is faked');
check(!Object.values(prodEnv).some((v) => /api[-_]?key|apikey|[?&]key=/i.test(v)), 'no RPC API key in the production configuration');

console.log('\n== wallet (Mobile Wallet Adapter) ==');
check(MWA_CHAIN_ID.devnet === 'solana:devnet' && MWA_CHAIN_ID['mainnet-beta'] === 'solana:mainnet' && MWA_CHAIN === MWA_CHAIN_ID[CLUSTER], 'MWA chain ids: solana:devnet and solana:mainnet (not solana:mainnet-beta)');
const wallet = strip(read('src/chain/wallet.ts'));
check(!/solana:\$\{/.test(wallet) && (wallet.match(/chain: MWA_CHAIN/g) ?? []).length === 2, 'both authorize calls use the configured chain id');
check(IDENTITY_URI === 'https://rugrat-badge.expo.app' && IDENTITY_ICON === 'rugrat.png' && (IDENTITY_ICON as string) !== 'rug-hunter.png', 'wallet identity: Rugrat icon on the controlled HTTPS host, not the Rug Hunter badge');
check(/rugrat\.png/.test(read('scripts/make-icons.mjs')) && read('scripts/check-live.mjs').includes('IDENTITY_ICON'), 'the identity icon is generated from the Rugrat artwork and verified live by check:live');

console.log('\n== explorer links ==');
check(explorerTxUrl('SIG', 'mainnet-beta') === 'https://explorer.solana.com/tx/SIG' && explorerAddressUrl('ADDR', 'mainnet-beta') === 'https://explorer.solana.com/address/ADDR', 'mainnet links have no cluster parameter');
check(explorerTxUrl('SIG', 'devnet') === 'https://explorer.solana.com/tx/SIG?cluster=devnet' && explorerAddressUrl('ADDR', 'devnet') === 'https://explorer.solana.com/address/ADDR?cluster=devnet', 'devnet links carry ?cluster=devnet');
const uiSrc = [...walk('src/screens'), ...walk('src/components'), ...walk('src/skr'), ...walk('src/badge'), ...walk('src/upgrade')].filter((f) => /\.tsx?$/.test(f));
check(uiSrc.every((f) => !/cluster=devnet|explorer\.solana\.com/.test(strip(read(f)))), 'no UI or feature code hard-codes an explorer URL: they all come from config.ts');

console.log('\n== SKR on mainnet ==');
check(SKR_MINT === 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3', 'the SKR mint is exactly the verified address');
check(SKR_CLUSTER === 'mainnet-beta' && resolveSkrRpc(undefined) === 'https://api.mainnet-beta.solana.com', 'the SKR check always reads a mainnet endpoint');
check(throws(() => resolveSkrRpc('https://api.devnet.solana.com')) && throws(() => resolveSkrRpc('http://x.example')), 'an SKR RPC override can never be devnet or plain http');
check(isHolderBalance(1n) && !isHolderBalance(0n), 'holder rule unchanged: balance above zero');
check(Object.values(prodEnv).every((v) => v !== SKR_MINT) && read('src/skr/config.ts').split('SKRbvo6').length === 2, 'the mint is defined in exactly one source file');

console.log('\n== treasury, issuer, upgrades ==');
check(!('EXPO_PUBLIC_TREASURY' in prodEnv) && !('EXPO_PUBLIC_ISSUER_URL' in prodEnv) && !('EXPO_PUBLIC_PAYMENT_MINT' in prodEnv) && !('EXPO_PUBLIC_TREASURY' in previewEnv) && !('EXPO_PUBLIC_ISSUER_URL' in previewEnv), 'no build profile configures a treasury, issuer or payment mint');
const prodUpgrade = upgradeAvailability({ ISSUER_URL: prodEnv.EXPO_PUBLIC_ISSUER_URL ?? null, PAYMENT_MINT: prodEnv.EXPO_PUBLIC_PAYMENT_MINT ?? null, TREASURY: prodEnv.EXPO_PUBLIC_TREASURY ?? null }, 'mainnet-beta');
check(!prodUpgrade.available, 'with the production profile\'s configuration, SKR upgrades are NOT available');
check(!upgradeAvailability({ ISSUER_URL: 'https://issuer.example', PAYMENT_MINT: MINT, TREASURY: null }, 'mainnet-beta').available, 'no upgrade without a treasury (even with an issuer and a token)');
check(!upgradeAvailability({ ISSUER_URL: null, PAYMENT_MINT: MINT, TREASURY: TREAS }, 'mainnet-beta').available, 'no upgrade without an issuer (even with a treasury and a token)');
check(!upgradeAvailability({ ISSUER_URL: 'https://issuer.example', PAYMENT_MINT: SKR_MINT, TREASURY: 'not-an-address' }, 'mainnet-beta').available, 'an invalid treasury address is treated as not configured');
check(!upgradeAvailability({ ISSUER_URL: 'https://issuer.example', PAYMENT_MINT: MINT, TREASURY: TREAS }, 'mainnet-beta').available, 'on mainnet the payment token must be SKR: any other mint is refused');
check(!upgradeAvailability({ ISSUER_URL: 'http://issuer.example', PAYMENT_MINT: SKR_MINT, TREASURY: TREAS }, 'mainnet-beta').available, 'on mainnet the issuer must be https');
check(upgradeAvailability({ ISSUER_URL: 'https://issuer.example', PAYMENT_MINT: SKR_MINT, TREASURY: TREAS }, 'mainnet-beta').available, 'the configuration check itself accepts a complete, valid mainnet configuration (the UI is still gated by PRICES_ARE_FINAL)');
const d = describeUpgradeConfig({ ISSUER_URL: null, PAYMENT_MINT: null, TREASURY: null });
check(d.treasury === 'NOT_CONFIGURED' && d.issuer === 'NOT_CONFIGURED', 'an unset treasury / issuer reads NOT_CONFIGURED, never an address');
check(PRICES_ARE_FINAL === false && /upgradesActive = avail\.available && PRICES_ARE_FINAL/.test(read('src/screens/BadgePanel.tsx')), 'upgrades stay "not active yet": no price, no upgrade button');
check(!/DefaultTreasury|TREASURY\s*=\s*['"][1-9A-HJ-NP-Za-km-z]{32,44}['"]/.test(strip(read('src/upgrade/config.ts'))), 'there is no default treasury address in the code');

console.log('\n== prize pool ==');
check(PAYOUT_GATE.enabled === false && PAYOUT_GATE.legalReviewConfirmed === false && Object.isFrozen(PAYOUT_GATE), 'the payout gate is off, frozen');
check(!/process\.env/.test(strip(walk('src/prize').map(read).join('\n'))), 'no environment variable can turn the prize pool on');
check(walk('src').filter((f) => !f.startsWith('src/prize/') && /\.tsx?$/.test(f)).every((f) => !/from '\.\.?\/(\.\.\/)?prize\//.test(read(f))), 'nothing in the app imports the prize pool');

console.log('\n== Rug Hunter badge on mainnet (no transaction) ==');
{
  const progress = uniqueVerifiedSurvivingRugs([], '', REPLAYS);
  const asset = Keypair.fromSeed(new Uint8Array(32).fill(9));
  const onDev = buildBadgeInstructions(WALLET, asset, { ...progress, count: 3, unlocked: true }, 'https://api.devnet.solana.com');
  const onMain = buildBadgeInstructions(WALLET, asset, { ...progress, count: 3, unlocked: true }, 'https://api.mainnet-beta.solana.com');
  check(onDev.length === 1 && onMain.length === 1 && onDev[0].programId.toBase58() === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d' && onDev[0].programId.equals(onMain[0].programId), 'the Core instruction uses the same program id on both networks');
  check(Buffer.from(onDev[0].data).equals(Buffer.from(onMain[0].data)) && onDev[0].keys.length === onMain[0].keys.length, 'the instruction (frozen + immutable + attributes) is byte-identical on both networks: nothing depends on the RPC');
  check(new TextDecoder().decode(badgeSeedMessage(WALLET, 'devnet')) === `Rug Replay: Rug Hunter badge v1\nWallet: ${WALLET}\nNetwork: devnet`, 'the devnet badge address derivation is unchanged');
  check(new TextDecoder().decode(badgeSeedMessage(WALLET, 'mainnet-beta')).endsWith('Network: mainnet-beta') && new TextDecoder().decode(badgeSeedMessage(WALLET, 'mainnet-beta')) !== new TextDecoder().decode(badgeSeedMessage(WALLET, 'devnet')), 'the badge address is network-dependent BY DESIGN (the signed message names the network), so mainnet and devnet badges never collide');
  check(BADGE_NAME === 'Rug Hunter' && prodEnv.EXPO_PUBLIC_BADGE_METADATA_URI === 'https://rugrat-badge.expo.app/rug-hunter.json' && previewEnv.EXPO_PUBLIC_BADGE_METADATA_URI === prodEnv.EXPO_PUBLIC_BADGE_METADATA_URI, 'the hosted badge metadata URL is the same for both networks');
  check(progressCacheApplies({ cluster: 'devnet' }, 'devnet') && !progressCacheApplies({ cluster: 'devnet' }, 'mainnet-beta') && progressCacheApplies({}, 'devnet') && !progressCacheApplies({}, 'mainnet-beta') && !progressCacheApplies(null, 'devnet'), 'cached badge progress from devnet is never shown on mainnet (older entries count as devnet)');
}

console.log('\n== the production profile, end to end ==');
{
  const cluster = resolveCluster(prodEnv.EXPO_PUBLIC_SOLANA_CLUSTER, false);
  const rpc = resolveRpcUrl(cluster, prodEnv.EXPO_PUBLIC_SOLANA_RPC);
  check(cluster === 'mainnet-beta' && MWA_CHAIN_ID[cluster] === 'solana:mainnet', 'production resolves to mainnet-beta with the MWA chain id solana:mainnet');
  check(rpc.url.startsWith('https://') && !/devnet|testnet/i.test(rpc.url), 'the production RPC is https and not a devnet/testnet endpoint');
  check(eas.production.environment === 'production' && !('environment' in eas.preview), 'production reads the EAS "production" environment (where the RPC provider URL is stored); preview does not');
  check(Object.keys(prodEnv).every((k) => ['EXPO_PUBLIC_BADGE_METADATA_URI', 'EXPO_PUBLIC_SOLANA_CLUSTER', 'EXPO_PUBLIC_SOLANA_RPC'].includes(k)), 'the production profile carries only the cluster, the badge metadata URL and (when set) the RPC: nothing that activates payments');
  check(explorerTxUrl('S', cluster) === 'https://explorer.solana.com/tx/S' && !/cluster=/.test(explorerAddressUrl('A', cluster)), 'production explorer links are plain mainnet links');
  const provider = 'https://mainnet.rpc-provider.example/v1/KEY';
  check(resolveRpcUrl('mainnet-beta', provider).url === provider && resolveSkrRpc(undefined, provider) === provider && resolveSkrRpc(undefined) === 'https://api.mainnet-beta.solana.com', 'once a production provider URL is supplied, the memo/badge reads AND the SKR check use it; without one the SKR check uses the public mainnet RPC');
  check(APP_IDENTITY.name === 'Rugrat' && `${APP_IDENTITY.uri}/${APP_IDENTITY.icon}` === 'https://rugrat-badge.expo.app/rugrat.png', 'production wallet identity: name Rugrat, icon https://rugrat-badge.expo.app/rugrat.png');
  const app = JSON.parse(read('app.json')).expo;
  check(app.android.package === 'com.rugreplay.app' && app.android.versionCode >= 2 && app.name === 'Rugrat', 'production app: Rugrat, package com.rugreplay.app, version code above the earlier preview APKs');
  check(/const SHOW_DEBUG_PANEL = __DEV__;/.test(strip(read('src/screens/GameScreen.tsx'))), 'the debug panel (and with it the speed control) is development-only');
  check(PAYOUT_GATE.enabled === false && PRICES_ARE_FINAL === false, 'production: prize payouts and upgrade prices are off');
}

console.log('\n== no secrets in configuration or client code ==');
{
  const configFiles = ['eas.json', 'app.json', 'package.json', '.env.example', 'README.md', 'docs/MAINNET.md', 'server/README.md'];
  const clientFiles = [...walk('src'), 'App.tsx', 'index.ts'].filter((f) => /\.tsx?$/.test(f));
  const all = [...configFiles, ...clientFiles, ...walk('server').filter((f) => /\.(ts|md)$/.test(f)), ...walk('webview/src')];
  const keyArray = /\[(\s*\d{1,3}\s*,){60,}/;
  const b58Secret = /\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/;
  const bad = all.filter((f) => {
    const t = read(f);
    return keyArray.test(t) || b58Secret.test(t) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t);
  });
  check(bad.length === 0, `no private key (byte array, base58 secret or PEM) in configuration, client code, server or docs${bad.length ? ': ' + bad.join(', ') : ''}`);
  const envFiles = [JSON.stringify(eas), read('.env.example')];
  const assigned = [...Object.entries({ ...prodEnv, ...previewEnv }), ...read('.env.example').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string])];
  const secretish = assigned.filter(([k, v]) => /SECRET|PRIVATE|SEED|MNEMONIC|KEYPAIR|PASSWORD/i.test(k) && v.trim() !== '');
  check(secretish.length === 0, 'no environment variable named like a secret (secret / private / seed / mnemonic / keypair / password) has a value');
  const seedWords = all.filter((f) => /\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b(?=["'`\n])/.test(read(f).split('\n').filter((l) => /(mnemonic|seed|phrase|recovery)/i.test(l) && /["'`]\s*[a-z]{3,8}( [a-z]{3,8}){11,}/.test(l)).join('\n')));
  check(seedWords.length === 0, 'no seed phrase (a quoted run of 12+ words next to "seed" / "mnemonic") in any config, client or doc file');
  check(!/EXPO_PUBLIC_[A-Z_]*(SECRET|PRIVATE|SEED|KEYPAIR)/i.test(envFiles.join('\n') + clientFiles.map(read).join('\n')), 'no EXPO_PUBLIC_ variable is named like a secret (they would be baked into the app)');
  check(!/ISSUER_KEYPAIR|ASSET_SECRET/.test(strip(clientFiles.filter((f) => !f.endsWith('upgrade/issuer.ts')).map(read).join('\n'))), 'the issuer key and asset secret are never referenced by app code');
}

console.log(`\nMAINNET PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
