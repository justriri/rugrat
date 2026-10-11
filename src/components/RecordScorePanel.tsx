import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChain } from '../chain/ChainContext';
import { CLUSTER, explorerTxUrl, shortAddress } from '../chain/config';
import { CHAIN_BADGE_LABEL, RECORDED_EXPLAINER } from '../chain/labels';
import type { ChainError } from '../chain/errors';
import type { RunResult } from '../competition/result';
import { colors, mono } from '../theme';

/**
 * Optional "record this score onchain" step, shown after a run has ended. The run is already saved
 * locally; nothing here can change or remove it, and the game never requires it.
 */
export function RecordScorePanel({ run }: { run: RunResult }) {
  const chain = useChain();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ChainError | null>(null);
  const rec = chain.recordOf(run.runId);
  const net = CLUSTER === 'devnet' ? 'Solana devnet' : 'Solana';

  const connect = async () => {
    setError(null);
    setError(await chain.connect());
  };
  const record = async () => {
    setError(null);
    setBusy(true);
    const out = await chain.recordScore(run);
    setBusy(false);
    if (!out.ok) setError(out.error);
  };
  const open = (sig: string) => void Linking.openURL(explorerTxUrl(sig)).catch(() => undefined);

  if (rec) {
    return (
      <View style={styles.box}>
        <Text style={[styles.status, { color: rec.status === 'ONCHAIN_VERIFIED' ? colors.green : colors.gold }]}>
          {rec.status === 'ONCHAIN_VERIFIED' ? CHAIN_BADGE_LABEL.ONCHAIN_VERIFIED : `${CHAIN_BADGE_LABEL.SUBMITTED} · NOT YET CONFIRMED`}
        </Text>
        <Text style={styles.small}>{error?.code === 'ALREADY_RECORDED' ? 'Already recorded' : 'Score recorded'} · {net}</Text>
        <Text style={styles.small}>{RECORDED_EXPLAINER}</Text>
        <Text style={styles.small} selectable>
          tx {shortAddress(rec.signature)}
        </Text>
        <Pressable style={styles.link} onPress={() => open(rec.signature)}>
          <Text style={styles.linkText}>VIEW TRANSACTION</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.box}>
      <Text style={styles.status}>LOCAL RESULT</Text>
      {chain.session ? (
        <>
          <Text style={styles.small}>
            Record score onchain: writes this result as a memo on {net}, signed by {shortAddress(chain.session.address)}. Costs only the network fee.
          </Text>
          <Pressable style={[styles.btn, busy && styles.dim]} onPress={record} disabled={busy}>
            {busy ? <ActivityIndicator color="#0c1118" /> : <Text style={styles.btnText}>RECORD SCORE ONCHAIN</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.small}>Your result is saved on this device. Connect a wallet if you want to record it onchain (optional).</Text>
          <Pressable style={[styles.btn, chain.connecting && styles.dim]} onPress={connect} disabled={chain.connecting}>
            <Text style={styles.btnText}>CONNECT WALLET</Text>
          </Pressable>
        </>
      )}
      {error && <Text style={styles.error}>{error.message}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.panel, borderRadius: 8, padding: 10, gap: 6, marginTop: 6 },
  status: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  small: { color: colors.text, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  error: { color: colors.red, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  btn: { backgroundColor: colors.gold, borderRadius: 6, paddingVertical: 10, alignItems: 'center' },
  dim: { opacity: 0.6 },
  btnText: { color: '#0c1118', fontFamily: mono, fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  link: { paddingVertical: 4 },
  linkText: { color: colors.green, fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
