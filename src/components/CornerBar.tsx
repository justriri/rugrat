import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, mono } from '../theme';

/** Bottom-right of the game view: back to the rug list, and the sound toggle. */
export function CornerBar({ muted, onToggleMute, onExit }: { muted: boolean; onToggleMute: () => void; onExit: () => void }) {
  return (
    <View style={styles.bar}>
      <Pressable style={styles.btn} onPress={onExit} hitSlop={10} accessibilityLabel="Back to the rug list">
        <Text style={styles.text}>‹ RUGS</Text>
      </Pressable>
      <Pressable style={styles.btn} onPress={onToggleMute} hitSlop={10} accessibilityLabel={muted ? 'Unmute sound' : 'Mute sound'}>
        <Text style={styles.text}>{muted ? 'SOUND OFF' : 'SOUND ON'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', right: 8, bottom: 8, flexDirection: 'row', gap: 6 },
  btn: { backgroundColor: 'rgba(12,17,24,0.7)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  text: { color: colors.muted, fontFamily: mono, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
});
