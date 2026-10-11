// The player's paper-trading state. Pure and deterministic: every function takes the replay
// moment (clock timestamp + the price held at that moment) and returns a new state. Nothing here
// reads a clock, a timer or a live price.

export const STARTING_PAPER_SOL = 10;

/** The replay moment a trade happens at. Always taken from the replay clock. */
export interface TradeMoment {
  /** Exact replay clock timestamp (epoch seconds, may be fractional) when the player acted. */
  timestamp: number;
  /** The tick whose price is in force at that timestamp. */
  tickIndex: number;
  /** Price of that tick (USD per token). */
  price: number;
}

export interface PlayerState {
  /** Paper SOL held as cash. */
  paperSol: number;
  /** Tokens held. */
  tokens: number;
  /** Average entry price (USD per token); equals the buy price while a single buy is supported. */
  entryPrice: number | null;
  /** Paper SOL spent on the buy. */
  solSpent: number;
  buyTimestamp: number | null;
  buyTickIndex: number | null;
  buyPrice: number | null;
  sellTimestamp: number | null;
  sellTickIndex: number | null;
  sellPrice: number | null;
  /** Paper SOL received from the sell. */
  proceedsSol: number | null;
  realizedPnlSol: number;
  realizedPnlPct: number | null;
  /** True once the player has sold. One entry and one exit per replay. */
  exited: boolean;
}

export function newPlayer(): PlayerState {
  return {
    paperSol: STARTING_PAPER_SOL,
    tokens: 0,
    entryPrice: null,
    solSpent: 0,
    buyTimestamp: null,
    buyTickIndex: null,
    buyPrice: null,
    sellTimestamp: null,
    sellTickIndex: null,
    sellPrice: null,
    proceedsSol: null,
    realizedPnlSol: 0,
    realizedPnlPct: null,
    exited: false,
  };
}

export const isHolding = (p: PlayerState) => p.tokens > 0;
export const canBuy = (p: PlayerState) => !p.exited && p.tokens === 0 && p.paperSol > 0;
export const canSell = (p: PlayerState) => !p.exited && p.tokens > 0;

/** Spend all paper SOL at the replay price: tokens = SOL * (USD per SOL) / (USD per token). */
export function applyBuy(p: PlayerState, at: TradeMoment, paperSolUsd: number): PlayerState {
  if (!canBuy(p)) return p;
  const solSpent = p.paperSol;
  return {
    ...p,
    paperSol: 0,
    tokens: (solSpent * paperSolUsd) / at.price,
    entryPrice: at.price,
    solSpent,
    buyTimestamp: at.timestamp,
    buyTickIndex: at.tickIndex,
    buyPrice: at.price,
  };
}

/** Sell every token at the replay price: SOL = tokens * (USD per token) / (USD per SOL). */
export function applySell(p: PlayerState, at: TradeMoment, paperSolUsd: number): PlayerState {
  if (!canSell(p)) return p;
  const proceedsSol = (p.tokens * at.price) / paperSolUsd;
  return {
    ...p,
    paperSol: p.paperSol + proceedsSol,
    tokens: 0,
    sellTimestamp: at.timestamp,
    sellTickIndex: at.tickIndex,
    sellPrice: at.price,
    proceedsSol,
    realizedPnlSol: proceedsSol - p.solSpent,
    realizedPnlPct: (proceedsSol / p.solSpent - 1) * 100,
    exited: true,
  };
}

/** Paper-SOL value of what the player holds right now, at the current replay price. */
export function currentValueSol(p: PlayerState, price: number, paperSolUsd: number): number {
  return (p.tokens * price) / paperSolUsd;
}

/** Cash plus the live value of any holding. */
export function totalSol(p: PlayerState, price: number, paperSolUsd: number): number {
  return p.paperSol + currentValueSol(p, price, paperSolUsd);
}
