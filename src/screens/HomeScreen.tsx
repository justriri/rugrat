import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CompetitionTab } from '../app/nav';
import { GameButton } from '../components/GameButton';
import { WalletChip } from '../components/WalletChip';
import { mono } from '../theme';

const TILES: { tab: CompetitionTab; icon: string; label: string }[] = [
  { tab: 'LEADERBOARD', icon: '🏆', label: 'BOARD' },
  { tab: 'FRIENDS', icon: '🤝', label: 'FRIENDS' },
  { tab: 'STATS', icon: '📊', label: 'STATS' },
  { tab: 'BADGE', icon: '🎖️', label: 'BADGE' },
  { tab: 'SKR', icon: '🪙', label: 'SKR' },
];

/**
 * The home overlay, drawn over the 3D scene. The scene IS the screen: RUGRAT, the little world and
 * its crowd. All that is added here is the tagline, a big PLAY and a row of small secondary tiles.
 */
export function HomeScreen({ onPlay, onCompetition }: { onPlay: () => void; onCompetition: (tab: CompetitionTab) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 14 }]} pointerEvents="box-none">
      <View style={styles.top} pointerEvents="box-none">
        <WalletChip />
      </View>
      <View style={styles.bottom} pointerEvents="box-none">
        <Text style={styles.tag}>Real Solana rugs. Paper money.</Text>
        <Text style={[styles.tag, styles.tag2]}>Can you get out in time?</Text>
        <GameButton label="PLAY" onPress={onPlay} height={78} fontSize={34} pulse style={styles.play} />
        <View style={styles.tiles}>
          {TILES.map((t) => (
            <Pressable key={t.tab} style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]} onPress={() => onCompetition(t.tab)} accessibilityLabel={t.label}>
              <Text style={styles.tileIcon}>{t.icon}</Text>
              <Text style={styles.tileLabel}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const outline = { textShadowColor: '#0c1118', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 0 } as const;
const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, justifyContent: 'space-between', paddingHorizontal: 18 },
  top: { alignItems: 'flex-end' },
  bottom: { gap: 6, alignItems: 'stretch' },
  tag: { color: '#fff4dc', fontFamily: mono, fontSize: 16, fontWeight: '900', textAlign: 'center', letterSpacing: 0.5, ...outline },
  tag2: { color: '#ffd04a', marginBottom: 10 },
  play: { alignSelf: 'center', width: '82%' },
  tiles: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 14 },
  tile: { width: 62, paddingVertical: 8, borderRadius: 10, alignItems: 'center', backgroundColor: 'rgba(90,58,28,0.92)', borderWidth: 3, borderColor: 'rgba(12,17,24,0.85)', borderBottomWidth: 6 },
  tilePressed: { transform: [{ translateY: 3 }], borderBottomWidth: 3 },
  tileIcon: { fontSize: 20 },
  tileLabel: { color: '#fff4dc', fontFamily: mono, fontSize: 9, fontWeight: '900', letterSpacing: 0.5, marginTop: 2 },
});
