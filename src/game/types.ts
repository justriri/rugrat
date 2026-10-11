export type WalletTag = 'DEV' | 'INSIDER' | 'SMART' | 'WHALE' | 'LIQUIDITY';
export type WalletAction = 'BUY' | 'SELL' | 'SUPPLY_MOVE' | 'LIQUIDITY_REMOVAL';

/** Timestamps everywhere are unix epoch SECONDS (the historical source's own clock). */
export interface PriceTick {
  timestamp: number;
  price: number;
}

/**
 * One real, timestamped wallet action. `tag` is a neutral label from the curated dataset and is
 * optional: a wallet that could not be confidently classified is left untagged. Full addresses
 * and the evidence for each tag live in the provenance file, keyed by `id`; the replay only
 * carries the shortened display form.
 */
export interface ReplayEvent {
  /** Stable id, also the key into the provenance record (see data/processed). */
  id: string;
  timestamp: number;
  /** Shortened address for display, e.g. "8xK...91Q". Never the full address. */
  wallet: string;
  tag?: WalletTag;
  action: WalletAction;
  /** Size of the action, when known, in `amountUnit`. */
  amount?: number;
  /** 'USD', or the token's own symbol for token amounts. */
  amountUnit?: string;
  /**
   * Estimated USD value of a token-denominated event: tokens times the replay price in force at
   * the event's timestamp. Lets size rules (like the verdict signal) apply to supply moves.
   */
  valueUsd?: number;
}

/**
 * The replay data contract. Real historical data and the demo both load as this shape
 * (see parseReplay). Ticks and events must be sorted by timestamp.
 */
/** Internal classification of how the collapse unfolded. Never shown as the token's name. */
export type RugType = 'FAST_DUMP' | 'SLOW_BLEED' | 'DEV_EXIT' | 'UNCLASSIFIED';

/**
 * The warning the verdict is measured against: the earliest event matching this rule is the
 * "signal". It is data-driven per replay; the verdict engine knows nothing about any token.
 */
export interface SignalRule {
  tag: WalletTag;
  action: WalletAction;
  /** Minimum USD size for an event to qualify. */
  minUsd: number;
  /** Why this rule is meaningful for this rug (documented with the replay). */
  description: string;
}

export interface Replay {
  id: string;
  /** Short display token, e.g. the symbol. */
  token: string;
  /** Real token name from the token's metadata (never a generic label). */
  name: string;
  symbol: string;
  /** Real mint address. */
  mint: string;
  /** Logo URL from the token's metadata, or null when no reliable logo exists (the UI falls back). */
  logoUrl: string | null;
  /** Where the logo URL came from. */
  logoSource: string | null;
  rugType: RugType;
  /** Historical date of the rug (UTC, YYYY-MM-DD). */
  date: string;
  /** First and last tick timestamps (epoch seconds). Must equal the ticks. */
  replayStart: number;
  replayEnd: number;
  signal: SignalRule;
  /** Why rugTimestamp was chosen. Documented per replay, never hardcoded in the engine. */
  collapseReason: string;
  /** Free-form provenance, shown nowhere in the game but kept with the data. */
  source?: string;
  /** Provenance and processing notes written by the preprocessing script. */
  meta?: Record<string, unknown>;
  ticks: PriceTick[];
  events: ReplayEvent[];
  /** Timestamp of the first tick of the collapse. */
  rugTimestamp: number;
  /**
   * Default playback multiplier. 1 = historical timing, 60 = one historical minute per real
   * second. A global multiplier only; it never reorders or retimes anything.
   */
  playbackSpeed: number;
  /**
   * Paper-trading conversion: USD value of 1 SOL, held constant for the replay. Prices are USD per
   * token, so tokens = solSpent * paperSolUsd / price.
   */
  paperSolUsd: number;
}

export type Direction = 'up' | 'down' | 'flat';

/** One voxel column of the price chart. One column per price tick, in tick order. */
export interface TerrainColumn {
  index: number;
  timestamp: number;
  price: number;
  /** Height of the column in whole blocks. Always >= 1. */
  level: number;
  /** Price direction relative to the previous tick (drives the top block colour). */
  dir: Direction;
}
