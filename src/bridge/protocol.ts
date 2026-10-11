import type { TerrainColumn, WalletAction, WalletTag } from '../game/types';

/** React Native -> WebView (Three.js scene). */
export type HostMessage =
  | { type: 'START_REPLAY'; terrain: TerrainColumn[] }
  /** The replay clock crossed tick `index`. Sent for every tick, in order, none skipped. */
  | { type: 'PRICE_TICK'; index: number }
  /** Continuous clock sync (throttled). The scene renders this; it never keeps its own timeline. */
  | {
      type: 'REPLAY_CLOCK';
      index: number;
      frac: number;
      timestamp: number;
      price: number;
      progress: number;
      speed: number;
    }
  | { type: 'BUY'; index: number }
  /** `pnlPct` is the already-computed realised P/L, for presentation only (sound and a label). */
  | { type: 'SELL'; index: number; pnlPct?: number }
  | { type: 'SHOW_RUG' }
  /** Presentation only: mute or unmute the scene's sound. */
  | { type: 'SET_MUTED'; muted: boolean }
  /** Presentation only (SKR holder perks): the character skin and arena look. Never affects play. */
  | { type: 'SET_COSMETICS'; characterSkin: 'DEFAULT' | 'SKR'; arena: 'DEFAULT' | 'SKR' }
  /**
   * A wallet event at the moment the replay clock reaches its timestamp. `tag` is null when the
   * identity is hidden (hard mode): the scene then draws a neutral NPC and never learns the label.
   */
  | {
      type: 'WALLET_EVENT';
      id: string;
      tag: WalletTag | null;
      action: WalletAction;
      amount?: number;
      amountUnit?: string;
      /** Reveal only: this is the verdict's first qualifying SMART SELL; the scene highlights it. */
      signal?: boolean;
      /** Banner text for the signal wallet, e.g. "SMART WALLET EXIT". */
      signalLabel?: string;
      /** Reveal only: higher survives the character cap longer. */
      priority?: number;
    }
  /** Reveal only: a labelled marker at the current column. */
  | { type: 'MARK'; kind: 'COLLAPSE' | 'HELD' }
  | { type: 'RESET' };

/** WebView (Three.js scene) -> React Native. */
export type WebMessage =
  | { type: 'READY' }
  | { type: 'PLAYER_TAPPED' }
  /** The market stall was tapped: cash out. */
  | { type: 'STALL_TAPPED' }
  | { type: 'ERROR'; message: string };

/**
 * Host messages are wrapped with a sequence number. Android delivers WebView messages on
 * `document` and iOS on `window`; the scene listens on both and drops repeats by `seq`.
 */
export interface HostEnvelope {
  seq: number;
  msg: HostMessage;
}

export function encodeHostMessage(seq: number, msg: HostMessage): string {
  const envelope: HostEnvelope = { seq, msg };
  return JSON.stringify(envelope);
}

export function decodeWebMessage(raw: string): WebMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed && typeof parsed.type === 'string') return parsed as WebMessage;
  } catch {
    // ignore non-JSON noise
  }
  return null;
}
