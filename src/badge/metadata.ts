// Badge metadata. Public and free of anything sensitive: no wallet address, no balances, no run
// ids. Built only from verified progress, never from client-supplied numbers.
import { ACHIEVEMENT_VERSION, AchievementProgress } from './achievement';

export const BADGE_NAME = 'Rug Hunter';
export const BADGE_DESCRIPTION = 'Earned by surviving 3 unique historical rug pulls in Rug Replay.';

export interface BadgeAttribute {
  key: string;
  value: string;
}

export function badgeAttributes(progress: AchievementProgress): BadgeAttribute[] {
  return [
    { key: 'Achievement', value: 'Rug Hunter' },
    { key: 'Rugs Survived', value: String(progress.count) },
    { key: 'Game', value: 'Rug Replay' },
    { key: 'Achievement Version', value: String(ACHIEVEMENT_VERSION) },
    { key: 'Non-Demo', value: 'true' },
  ];
}

/**
 * The offchain metadata URI. Set EXPO_PUBLIC_BADGE_METADATA_URI to a hosted copy of
 * badge/rug-hunter.json (it carries the image). Without it the badge still mints with a tiny
 * inline JSON (name + description, no image); the real attributes live ONCHAIN in the asset itself.
 */
export function badgeMetadataUri(configured: string | undefined = process.env.EXPO_PUBLIC_BADGE_METADATA_URI): string {
  if (configured && /^https?:\/\//.test(configured)) return configured;
  return `data:application/json,${encodeURIComponent(JSON.stringify({ name: BADGE_NAME, description: BADGE_DESCRIPTION }))}`;
}
