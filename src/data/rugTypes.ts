import type { RugType } from '../game/types';

/**
 * Player-facing words for each internal rug type. This is presentation only: the type itself is
 * metadata on every replay in the catalogue; nothing about any individual token is copied here.
 */
export interface RugTypeInfo {
  label: string;
  /** One line shown on the rug card. */
  blurb: string;
  color: string;
}

const INFO: Record<RugType, RugTypeInfo> = {
  FAST_DUMP: { label: 'FAST DUMP', blurb: 'A rapid pump, then a sharp collapse. You get minutes, not hours.', color: '#e5483f' },
  SLOW_BLEED: { label: 'SLOW BLEED', blurb: 'The price drifts down after the peak. Easy to stay too long.', color: '#f7c53b' },
  DEV_EXIT: { label: 'DEV EXIT', blurb: 'The creator wallet moves a large share of supply during the collapse.', color: '#4fd35f' },
  UNCLASSIFIED: { label: 'HISTORICAL REPLAY', blurb: 'A real collapse, replayed from the on-chain record.', color: '#4aa3ff' },
};

export function rugTypeInfo(type: RugType): RugTypeInfo {
  return INFO[type];
}
