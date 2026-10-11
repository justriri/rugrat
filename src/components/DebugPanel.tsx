import { Pressable, StyleSheet, Text } from 'react-native';

import type { GameSnapshot } from '../game/ReplayEngine';
import { fmtElapsed, startTimestamp } from '../game/timeline';
import type { Replay } from '../game/types';
import { mono } from '../theme';

/** Development readout of the replay clock. Tap to cycle playback speed. */
export function DebugPanel({
  replay,
  state,
  onCycleSpeed,
}: {
  replay: Replay;
  state: GameSnapshot;
  onCycleSpeed: () => void;
}) {
  const c = state.clock;
  const iso = new Date(c.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return (
    <Pressable style={styles.box} onPress={onCycleSpeed}>
      <Text style={styles.text}>rug: {replay.name} ({replay.id})</Text>
      <Text style={styles.text}>
        mode: {state.difficulty.toUpperCase()} (locked once the run starts){state.fairRun ? '' : ' · NOT RECORDED: speed altered'}
      </Text>
      <Text style={styles.text}>
        {replay.symbol} · {replay.rugType} · {state.phase} · {state.speed}x
      </Text>
      <Text style={styles.text}>
        {iso} UTC ({fmtElapsed(c.timestamp - startTimestamp(replay))})
      </Text>
      <Text style={styles.text}>
        buy {state.player.buyTimestamp ?? '-'} @ {state.player.buyPrice ?? '-'} | sell{' '}
        {state.player.sellTimestamp ?? '-'} @ {state.player.sellPrice ?? '-'}
      </Text>
      <Text style={styles.text}>
        price {c.price} · tick {c.index}/{state.tickCount - 1} · {(c.progress * 100).toFixed(1)}% · ev {state.feed.length}/{replay.events.length}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  text: { color: '#cfe8ff', fontFamily: mono, fontSize: 9 },
  toggle: { color: '#ffd76a' },
});
