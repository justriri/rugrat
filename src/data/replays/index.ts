import type { Replay } from '../../game/types';
import { demoReplay } from '../demoReplay';
import { barronReplay } from './barron';
import { hawkReplay } from './hawk';
import { libraReplay } from './libra';
import { melaniaReplay } from './melania';

export { demoReplay, libraReplay };

/**
 * The internal catalogue of real historical replays. Each one is the same Replay contract: real
 * token metadata, real price ticks, real wallet events, a data-driven signal and a documented
 * collapse. Adding a rug means adding its processed JSON and listing it here.
 */
export const REPLAYS: readonly Replay[] = Object.freeze([libraReplay, barronReplay, melaniaReplay, hawkReplay]);

export function getReplay(id: string): Replay | undefined {
  return REPLAYS.find((r) => r.id === id);
}

/**
 * A default replay for tooling and tests ONLY (scripts that need some replay when none is named).
 * The app never uses it: the player always picks a rug, and there is no fallback to this one.
 */
export const toolingDefaultReplay: Replay = libraReplay;
export const activeReplay = toolingDefaultReplay;
