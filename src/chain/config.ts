// Onchain configuration. Nothing here is a secret (every EXPO_PUBLIC_* value is compiled into the
// app and is public).
//
// DEVELOPMENT vs PRODUCTION
//   - A development run (`expo start`) with nothing configured uses devnet: a test run costs nothing.
//   - A RELEASE build must say which cluster it is for. If EXPO_PUBLIC_SOLANA_CLUSTER is missing or
//     not exactly "devnet" / "mainnet-beta", the app refuses to start rather than silently using
//     devnet (or guessing mainnet). The EAS profiles in eas.json set it explicitly:
//       preview    -> devnet        (test APKs)
//       production -> mainnet-beta
//   - An RPC override that points at the wrong cluster (a devnet URL in a mainnet build, or the
//     reverse) is rejected the same way.
// NOTE: keep the literal `process.env.EXPO_PUBLIC_...` references: Metro inlines them by name.
export type Cluster = 'devnet' | 'mainnet-beta';

/** False in every release / EAS build. In plain Node (the test scripts) it counts as development. */
export const isDevelopmentBuild: boolean = typeof __DEV__ === 'undefined' ? true : __DEV__;

export function resolveCluster(raw: string | undefined, isDev: boolean): Cluster {
  const v = raw?.trim();
  if (v === 'devnet' || v === 'mainnet-beta') return v;
  if (v) throw new Error(`EXPO_PUBLIC_SOLANA_CLUSTER must be "devnet" or "mainnet-beta" (got "${v}").`);
  if (isDev) return 'devnet';
  throw new Error('EXPO_PUBLIC_SOLANA_CLUSTER is not set in a release build; refusing to guess a network. Set it in eas.json.');
}

const PUBLIC_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

/**
 * The RPC endpoint for a cluster. With no override it is Solana's PUBLIC endpoint, which is rate
 * limited and NOT production-grade (`isPublicDefault` says so). An override must be https and must
 * not obviously belong to the other cluster. Keys in RPC URLs are visible in the app bundle: use a
 * provider restriction (allow-list) or a proxy, never an unrestricted private key.
 */
export function resolveRpcUrl(cluster: Cluster, override: string | undefined): { url: string; isPublicDefault: boolean } {
  const o = override?.trim();
  if (!o) return { url: PUBLIC_RPC[cluster], isPublicDefault: true };
  if (!/^https:\/\//i.test(o)) throw new Error('EXPO_PUBLIC_SOLANA_RPC must be an https URL.');
  if (cluster === 'mainnet-beta' && /devnet|testnet/i.test(o)) throw new Error('EXPO_PUBLIC_SOLANA_RPC points at devnet/testnet in a mainnet-beta build.');
  if (cluster === 'devnet' && /mainnet/i.test(o)) throw new Error('EXPO_PUBLIC_SOLANA_RPC points at mainnet in a devnet build.');
  return { url: o, isPublicDefault: false };
}

export const CLUSTER: Cluster = resolveCluster(process.env.EXPO_PUBLIC_SOLANA_CLUSTER, isDevelopmentBuild);
const rpc = resolveRpcUrl(CLUSTER, process.env.EXPO_PUBLIC_SOLANA_RPC);
export const RPC_URL: string = rpc.url;
/** True while the app is using Solana's public RPC (fine for development, pending a provider for production). */
export const RPC_IS_PUBLIC_DEFAULT: boolean = rpc.isPublicDefault;

/**
 * Mobile Wallet Adapter 2.0 chain identifiers (CAIP-2 style). Note mainnet is "solana:mainnet",
 * not "solana:mainnet-beta".
 */
export const MWA_CHAIN_ID: Record<Cluster, 'solana:devnet' | 'solana:mainnet'> = { devnet: 'solana:devnet', 'mainnet-beta': 'solana:mainnet' };
export const MWA_CHAIN = MWA_CHAIN_ID[CLUSTER];

/**
 * How the app introduces itself in the wallet's connect dialog. The uri must be a site WE control:
 * the Expo-hosted static site (project rugrat-badge) that also serves the badge metadata. The icon
 * is the Rugrat app icon, hosted there (resolved relative to the uri, per the wallet-adapter spec).
 * When a dedicated Rugrat domain exists, change these two lines.
 */
export const IDENTITY_URI = 'https://rugrat-badge.expo.app';
export const IDENTITY_ICON = 'rugrat.png';
export const APP_IDENTITY = { name: 'Rugrat', uri: IDENTITY_URI, icon: IDENTITY_ICON } as const;

export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// Mainnet links have no cluster parameter; every other cluster gets its own.
const clusterQuery = (cluster: Cluster) => (cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`);
export function explorerTxUrl(signature: string, cluster: Cluster = CLUSTER): string {
  return `https://explorer.solana.com/tx/${signature}${clusterQuery(cluster)}`;
}
export function explorerAddressUrl(address: string, cluster: Cluster = CLUSTER): string {
  return `https://explorer.solana.com/address/${address}${clusterQuery(cluster)}`;
}

export const shortAddress = (a: string) => (a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);
