import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useChain } from '../chain/ChainContext';
import { shortAddress } from '../chain/config';
import { mono } from '../theme';

/** A small wallet pill for the home screen: connect, see the short address, disconnect. Optional. */
export function WalletChip() {
  const { session, connecting, connect, disconnect } = useChain();
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={styles.wrap}>
      <Pressable
        style={[styles.chip, session && styles.on, connecting && { opacity: 0.6 }]}
        disabled={connecting}
        onPress={async () => {
          setError(null);
          if (session) await disconnect();
          else setError((await connect())?.message ?? null);
        }}
        accessibilityLabel={session ? 'Disconnect wallet' : 'Connect wallet'}
      >
        <View style={[styles.dot, { backgroundColor: session ? '#4fd35f' : '#8b97a6' }]} />
        <Text style={styles.text}>{session ? shortAddress(session.address) : 'CONNECT WALLET'}</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end', gap: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(12,17,24,0.72)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' },
  on: { borderColor: '#4fd35f' },
  dot: { width: 8, height: 8, borderRadius: 2 },
  text: { color: '#fff4dc', fontFamily: mono, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  error: { color: '#fff', backgroundColor: 'rgba(156,42,36,0.9)', fontFamily: mono, fontSize: 10, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4, maxWidth: 220 },
});
