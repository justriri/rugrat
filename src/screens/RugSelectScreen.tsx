import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GameButton } from '../components/GameButton';
import { TokenBadge } from '../components/TokenBadge';
import { getReplay } from '../data/replays';
import { rugTypeInfo } from '../data/rugTypes';
import type { Difficulty } from '../game/ReplayEngine';
import { HISTORICAL_NOTICE } from '../copy/notice';
import { fmtHistory } from '../menu/worlds';
import { mono } from '../theme';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2025-02-14" -> "Feb 14, 2025" (no Intl: it is not reliable on every JS engine). */
export function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

const DIFFICULTY_TEXT: Record<Difficulty, string> = {
  easy: 'Wallet tags are shown while you play.',
  hard: 'Wallet identities stay hidden until the end.',
};
const ENTER_MS = 700;

/**
 * The world-selection overlay, drawn over the shared 3D scene. Nothing about a world is shown until
 * it is chosen; then its details (all read from the replay registry), EASY / HARD and PLAY appear.
 */
export function RugSelectScreen({ selectedId, onSelect, onStart, onEnter, onBack }: { selectedId: string | null; onSelect: (id: string | null) => void; onStart: (replayId: string, difficulty: Difficulty) => void; onEnter: (replayId: string) => void; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const replay = selectedId ? getReplay(selectedId) : undefined;
  const [difficulty, setDifficulty] = useState<Difficulty>('easy');
  const [entering, setEntering] = useState(false);
  const slide = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    Animated.timing(slide, { toValue: replay ? 1 : 0, duration: 280, easing: Easing.out(Easing.back(1.1)), useNativeDriver: true }).start();
  }, [replay, slide]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const play = () => {
    if (!replay || entering) return;
    setEntering(true);
    onEnter(replay.id);
    Animated.timing(fade, { toValue: 1, duration: ENTER_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }).start();
    timer.current = setTimeout(() => onStart(replay.id, difficulty), ENTER_MS);
  };

  const info = replay ? rugTypeInfo(replay.rugType) : null;
  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={[styles.header, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityLabel="Back">
          <Text style={styles.backText}>‹ BACK</Text>
        </Pressable>
        <Text style={styles.title}>{replay ? '' : 'THE VILLAGE'}</Text>
        <View style={styles.back} />
      </View>
      {!replay && <Text style={[styles.hint, { bottom: insets.bottom + 26 }]}>TAP A BUILDING · SWIPE TO BROWSE</Text>}

      {replay && info && (
        <Animated.View
          style={[styles.panel, { paddingBottom: insets.bottom + 14, transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [380, 0] }) }] }]}
          pointerEvents="auto"
        >
          <View style={styles.nameRow}>
            <TokenBadge replay={replay} size={46} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {replay.name}
              </Text>
              <Text style={styles.symbol}>${replay.symbol}</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: info.color }]}>
              <Text style={styles.badgeText}>{info.label}</Text>
            </View>
          </View>
          <View style={styles.facts}>
            <Text style={styles.fact}>{fmtDate(replay.date)}</Text>
            <Text style={styles.fact}>{fmtHistory(replay.replayEnd - replay.replayStart)} of history</Text>
            <Text style={styles.fact}>{replay.events.length} wallet events</Text>
          </View>
          <Text style={styles.blurb}>{info.blurb}</Text>
          <Text style={styles.notice}>{HISTORICAL_NOTICE}</Text>
          <View style={styles.modes}>
            {(['easy', 'hard'] as const).map((d) => (
              <Pressable key={d} onPress={() => setDifficulty(d)} style={[styles.mode, difficulty === d && (d === 'easy' ? styles.modeEasy : styles.modeHard)]} accessibilityLabel={d.toUpperCase()}>
                <Text style={[styles.modeText, difficulty === d && styles.modeTextOn]}>{d.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.modeNote}>{DIFFICULTY_TEXT[difficulty]}</Text>
          <GameButton label="PLAY" onPress={play} height={64} fontSize={28} pulse={!entering} disabled={entering} />
        </Animated.View>
      )}
      <Animated.View pointerEvents={entering ? 'auto' : 'none'} style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, { backgroundColor: '#8fd6ff', opacity: fade }]} />
    </View>
  );
}

const outline = { textShadowColor: '#0c1118', textShadowOffset: { width: 2, height: 2 }, textShadowRadius: 0 } as const;
const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14 },
  back: { width: 84, backgroundColor: 'rgba(12,17,24,0.7)', borderRadius: 8, paddingVertical: 7, alignItems: 'center' },
  backText: { color: '#fff4dc', fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  title: { color: '#fff4dc', fontFamily: mono, fontSize: 14, fontWeight: '900', letterSpacing: 2, ...outline },
  hint: { position: 'absolute', alignSelf: 'center', color: '#fff4dc', fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1, ...outline },
  panel: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#2a1c10', borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 5, borderColor: '#ffd04a', paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { color: '#fff4dc', fontFamily: mono, fontSize: 20, fontWeight: '900' },
  symbol: { color: '#ffd04a', fontFamily: mono, fontSize: 14, fontWeight: '900' },
  badge: { borderRadius: 5, paddingHorizontal: 7, paddingVertical: 4 },
  badgeText: { color: '#0c1118', fontFamily: mono, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  facts: { gap: 2 },
  fact: { color: '#e9dcc3', fontFamily: mono, fontSize: 13, fontWeight: '700' },
  blurb: { color: '#b9a98a', fontFamily: mono, fontSize: 11, lineHeight: 15 },
  notice: { color: '#8f8068', fontFamily: mono, fontSize: 9, lineHeight: 12 },
  modes: { flexDirection: 'row', gap: 8, marginTop: 2 },
  mode: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', backgroundColor: '#3b2a18', borderWidth: 3, borderColor: '#1a1008' },
  modeEasy: { backgroundColor: '#5be06c' },
  modeHard: { backgroundColor: '#ef5a4f' },
  modeText: { color: '#b9a98a', fontFamily: mono, fontSize: 14, fontWeight: '900', letterSpacing: 2 },
  modeTextOn: { color: '#0c1118' },
  modeNote: { color: '#b9a98a', fontFamily: mono, fontSize: 10, marginBottom: 4 },
});
