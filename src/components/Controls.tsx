import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { GameSnapshot } from '../game/ReplayEngine';
import { colors, mono } from '../theme';

interface Props {
  state: GameSnapshot;
  onBuy: () => void;
  onSell: () => void;
}

export function Controls({ state, onBuy, onSell }: Props) {
  return (
    <View style={styles.row}>
      <Button label="BUY" enabled={state.canBuy} face={colors.green} edge={colors.greenDark} onPress={onBuy} />
      <Button label="SELL" enabled={state.canSell} face={colors.red} edge={colors.redDark} onPress={onSell} />
    </View>
  );
}

function Button(p: {
  label: string;
  enabled: boolean;
  face: string;
  edge: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={p.onPress}
      disabled={!p.enabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: p.face, borderBottomColor: p.edge },
        !p.enabled && styles.off,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.text}>{p.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  btn: {
    flex: 1,
    height: 56,
    borderRadius: 6,
    borderBottomWidth: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  off: { opacity: 0.3 },
  pressed: { transform: [{ translateY: 3 }], borderBottomWidth: 3 },
  text: { color: '#0c1118', fontFamily: mono, fontSize: 22, fontWeight: '900', letterSpacing: 2 },
});
