// Fetches each world's REAL token logo and hands it to the menu scene as a data URI, so the scene
// itself never makes a network request (and is not blocked by image hosts' CORS rules). Logos are
// cached on the device; a logo that cannot be fetched is simply skipped and the scene keeps its
// letter fallback. Nothing is invented.
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Replay } from '../game/types';

const KEY = 'rugrat.logos.v1';
const MAX_CACHED_BYTES = 250_000;

async function readCache(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const d = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}
async function writeCache(c: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    // cache only
  }
}

async function fetchDataUri(url: string, timeoutMs = 12_000): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || 'image/png';
    if (!/^image\//.test(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Calls `onLogo` for each replay that has a logo: first from the cache (instantly), then from the
 * network (with two retries) for any that are missing. Safe to call more than once.
 */
export async function loadLogos(replays: readonly Replay[], onLogo: (id: string, dataUri: string) => void, isAlive: () => boolean = () => true): Promise<void> {
  const cache = await readCache();
  const missing: Replay[] = [];
  for (const r of replays) {
    if (!r.logoUrl) continue;
    const cached = cache[r.id];
    if (cached) onLogo(r.id, cached);
    else missing.push(r);
  }
  let changed = false;
  await Promise.all(
    missing.map(async (r) => {
      for (let attempt = 0; attempt < 3 && isAlive(); attempt++) {
        const uri = await fetchDataUri(r.logoUrl as string);
        if (uri) {
          if (!isAlive()) return;
          onLogo(r.id, uri);
          if (uri.length < MAX_CACHED_BYTES) {
            cache[r.id] = uri;
            changed = true;
          }
          return;
        }
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }),
  );
  if (changed) await writeCache(cache);
}
