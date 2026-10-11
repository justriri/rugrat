import { StyleSheet, Text, View } from 'react-native';

import type { GameSnapshot } from '../game/ReplayEngine';
import type { Replay } from '../game/types';
import { TokenBadge } from './TokenBadge';
import { colors, fmtPct, fmtPrice, fmtSol, mono } from '../theme';

/** I have 10 SOL -> I bought -> I am holding -> I can sell. */
function status(state: GameSnapshot): { text: string; color: string } {
  const p = state.player;
  if (p.exited) {
    const pct = p.realizedPnlPct ?? 0;
    return { text: `SOLD ${fmtPct(pct)}`, color: pct >= 0 ? colors.green : colors.red };
  }
  if (state.holding) {
    const pct = state.unrealizedPnlPct ?? 0;
    return { text: `HOLDING ${fmtPct(pct)}`, color: pct >= 0 ? colors.green : colors.red };
  }
  return { text: 'READY TO BUY', color: colors.muted };
}

export function Hud({ replay, state }: { replay: Replay; state: GameSnapshot }) {
  const s = status(state);
  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.pill, styles.tokenPill]}>
        <TokenBadge key={replay.id} replay={replay} size={30} />
        <View>
          <Text style={styles.label} numberOfLines={1}>
            ${replay.symbol}
          </Text>
          <Text style={styles.value}>{fmtPrice(state.clock.price)}</Text>
        </View>
      </View>
      <View style={styles.pill}>
        <Text style={styles.label}>PAPER SOL</Text>
        <Text style={[styles.value, { color: colors.gold }]}>{fmtSol(state.totalSol)}</Text>
        <Text style={[styles.status, { color: s.color }]}>{s.text}</Text>
      </View>
      {state.rugActive && state.phase !== 'exited' && state.phase !== 'finished' && (
        <View style={[styles.pill, styles.rug]}>
          <Text style={styles.rugText}>RUG!</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
  },
  pill: {
    backgroundColor: 'rgba(12,17,24,0.78)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  tokenPill: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: colors.muted, fontFamily: mono, fontSize: 10, fontWeight: '700' },
  value: { color: colors.text, fontFamily: mono, fontSize: 16, fontWeight: '800' },
  status: { fontFamily: mono, fontSize: 11, fontWeight: '800' },
  rug: { backgroundColor: colors.red, marginLeft: 'auto' },
  rugText: { color: '#fff', fontFamily: mono, fontWeight: '900', fontSize: 18 },
});
