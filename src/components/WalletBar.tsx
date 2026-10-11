import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useChain } from '../chain/ChainContext';
import { CLUSTER, shortAddress } from '../chain/config';
import type { ChainError } from '../chain/errors';
import { colors, mono } from '../theme';

/** Optional wallet connection: connect, see the shortened address, disconnect. */
export function WalletBar() {
  const { session, connecting, connect, disconnect } = useChain();
  const [error, setError] = useState<ChainError | null>(null);
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <Text style={styles.addr} numberOfLines={1}>
          {session ? `${shortAddress(session.address)} · ${CLUSTER}` : 'No wallet connected (optional)'}
        </Text>
        <Pressable
          style={[styles.btn, connecting && styles.dim]}
          disabled={connecting}
          onPress={async () => {
            setError(null);
            if (session) await disconnect();
            else setError(await connect());
          }}
        >
          <Text style={styles.btnText}>{session ? 'DISCONNECT' : 'CONNECT WALLET'}</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error}>{error.message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 14, marginBottom: 8, gap: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.panel, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, gap: 8 },
  addr: { color: colors.text, fontFamily: mono, fontSize: 11, fontWeight: '700', flex: 1 },
  btn: { backgroundColor: colors.gold, borderRadius: 5, paddingHorizontal: 10, paddingVertical: 6 },
  dim: { opacity: 0.6 },
  btnText: { color: '#0c1118', fontFamily: mono, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  error: { color: colors.red, fontFamily: mono, fontSize: 11 },
});
