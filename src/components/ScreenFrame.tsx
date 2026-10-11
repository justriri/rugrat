import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, mono } from '../theme';

/** Shared chrome for the menu screens: safe-area padding, a back button and a title. */
export function ScreenFrame({ title, onBack, children }: { title: string; onBack?: () => void; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} hitSlop={12} style={styles.back} accessibilityLabel="Back">
            <Text style={styles.backText}>‹ BACK</Text>
          </Pressable>
        ) : (
          <View style={styles.back} />
        )}
        <Text style={styles.title}>{title}</Text>
        <View style={styles.back} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 10 },
  back: { width: 70 },
  backText: { color: colors.muted, fontFamily: mono, fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  title: { color: colors.text, fontFamily: mono, fontSize: 16, fontWeight: '900', letterSpacing: 2 },
});
