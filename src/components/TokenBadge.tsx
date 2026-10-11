import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import type { Replay } from '../game/types';
import { colors, mono } from '../theme';

/** The token's real logo; if there is none (or it fails to load) a plain letter badge, never a made-up logo. */
export function TokenBadge({ replay, size = 30 }: { replay: Replay; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (replay.logoUrl && !failed) {
    return <Image source={{ uri: replay.logoUrl }} style={[styles.base, box]} onError={() => setFailed(true)} />;
  }
  return (
    <View style={[styles.base, styles.fallback, box]}>
      <Text style={[styles.letter, { fontSize: size * 0.5 }]}>{replay.symbol.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: colors.panel },
  fallback: { alignItems: 'center', justifyContent: 'center' },
  letter: { color: colors.gold, fontFamily: mono, fontWeight: '900' },
});
