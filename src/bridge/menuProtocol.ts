// Messages between React Native and the MENU scene (the home and world-selection WebView).
// Separate from the gameplay protocol on purpose: the menu scene knows nothing about trading,
// replays' clocks or scores. It is told which worlds exist and which one is selected.
import type { RugType } from '../game/types';

/** What the menu scene needs to draw one world. Derived from the replay registry, never stored. */
export interface MenuWorld {
  id: string;
  symbol: string;
  rugType: RugType;
  /** Position in the catalogue; picks the world's accent colour. */
  index: number;
  /** The replay's real price path, downsampled to 0..1 (log scale) for the miniature chart. */
  profile: number[];
  /** +1 when the step rose, -1 when it fell (same length as `profile`). */
  steps: number[];
}

export type MenuMode = 'home' | 'worlds';

/** React Native -> menu scene. */
export type MenuHostMessage =
  | { type: 'INIT'; worlds: MenuWorld[]; mode: MenuMode }
  | { type: 'MODE'; mode: MenuMode }
  /** null clears the selection. */
  | { type: 'SELECT'; id: string | null }
  /** The real token logo as a data URI (fetched by the app, so the scene never makes a network request). */
  | { type: 'LOGO'; id: string; dataUri: string }
  /** The player pressed PLAY on the selected world: zoom in. */
  | { type: 'ENTER'; id: string }
  | { type: 'PAUSE'; paused: boolean };

/** Menu scene -> React Native. */
export type MenuWebMessage =
  | { type: 'READY' }
  | { type: 'WORLD_TAPPED'; id: string }
  /** A horizontal swipe on the world screen: +1 next, -1 previous. */
  | { type: 'SWIPE'; dir: 1 | -1 }
  | { type: 'ERROR'; message: string };

export interface MenuHostEnvelope {
  seq: number;
  msg: MenuHostMessage;
}

export const encodeMenuMessage = (seq: number, msg: MenuHostMessage): string => JSON.stringify({ seq, msg } satisfies MenuHostEnvelope);

export function decodeMenuMessage(raw: string): MenuWebMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    if (parsed && typeof parsed.type === 'string') return parsed as MenuWebMessage;
  } catch {
    // ignore noise
  }
  return null;
}
