import { useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useChain } from '../chain/ChainContext';
import { formatSkr } from '../skr/balance';
import { SKR_DECIMALS } from '../skr/config';
import { useSkr } from '../skr/SkrContext';
import { SKR_ERROR_TEXT } from '../skr/status';
import { colors, mono } from '../theme';

const SKR_PURPLE = '#9945ff';

function Perk({ title, text, on }: { title: string; text: string; on: boolean }) {
  return (
    <View style={[styles.perk, on && styles.perkOn]}>
      <Text style={[styles.perkTitle, { color: on ? colors.green : colors.muted }]}>{on ? '✓ ' : '🔒 '}{title}</Text>
      <Text style={styles.small}>{text}</Text>
    </View>
  );
}

/** SKR holder section: balance, status and the two cosmetic perks. Read-only; no transaction. */
export function SkrPanel() {
  const { session } = useChain();
  const { state, perks, checking, refresh } = useSkr();

  // reading once when the section opens (not polling)
  useEffect(() => {
    if (session) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const holder = state.kind === 'HOLDER' || (state.kind === 'ERROR' && state.lastKnown?.holder === true);
  const raw = state.kind === 'HOLDER' ? state.raw : state.kind === 'ERROR' ? state.lastKnown?.raw : undefined;

  return (
    <ScrollView contentContainerStyle={styles.pane}>
      <View style={[styles.card, holder && styles.cardOn]}>
        {state.kind === 'DISCONNECTED' ? (
          <>
            <Text style={styles.title}>SKR HOLDER LOCKED</Text>
            <Text style={styles.small}>CONNECT WALLET TO CHECK SKR</Text>
            <Text style={styles.small}>Use the wallet bar above. Playing never needs a wallet or SKR.</Text>
          </>
        ) : holder ? (
          <>
            <Text style={[styles.title, { color: colors.green }]}>SKR HOLDER ✓</Text>
            <Text style={styles.big}>SKR BALANCE: {raw !== undefined ? formatSkr(raw, SKR_DECIMALS) : '-'} SKR</Text>
          </>
        ) : state.kind === 'LOCKED' ? (
          <>
            <Text style={styles.title}>SKR HOLDER LOCKED</Text>
            <Text style={styles.big}>SKR BALANCE: 0 SKR</Text>
            <Text style={styles.small}>Hold SKR to unlock exclusive content.</Text>
          </>
        ) : (
          <>
            <Text style={styles.title}>SKR HOLDER LOCKED</Text>
            <Text style={styles.small}>{state.kind === 'ERROR' ? 'Could not check your SKR yet.' : 'Checking your SKR…'}</Text>
          </>
        )}
        {state.kind === 'ERROR' && <Text style={styles.error}>{SKR_ERROR_TEXT[state.error]}</Text>}
        {session && (
          <Pressable style={[styles.btn, checking && styles.dim]} onPress={() => void refresh()} disabled={checking}>
            {checking ? <ActivityIndicator color="#0c1118" /> : <Text style={styles.btnText}>REFRESH SKR BALANCE</Text>}
          </Pressable>
        )}
      </View>

      <Text style={styles.section}>HOLDER PERKS</Text>
      <Perk title="SKR RUGRAT SKIN" text="A purple and green Rugrat with a headband." on={perks.characterSkin} />
      <Perk title="SKR TWILIGHT ARENA" text="A starry twilight sky for every replay." on={perks.arena} />
      <Text style={styles.note}>
        Perks are cosmetic only. SKR never changes your score, verdict, trading or ranking, and it is never needed to play. Any SKR balance above zero counts; the check only reads your balance, it never sends a transaction.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pane: { paddingHorizontal: 14, paddingBottom: 24, gap: 10 },
  card: { backgroundColor: colors.panel, borderRadius: 8, padding: 12, gap: 6, borderWidth: 2, borderColor: 'transparent' },
  cardOn: { borderColor: SKR_PURPLE },
  title: { color: colors.muted, fontFamily: mono, fontSize: 16, fontWeight: '900' },
  big: { color: colors.text, fontFamily: mono, fontSize: 16, fontWeight: '900' },
  small: { color: colors.muted, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  error: { color: colors.red, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  section: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginTop: 4 },
  perk: { backgroundColor: colors.panel, borderRadius: 6, padding: 12, gap: 3 },
  perkOn: { borderLeftWidth: 4, borderLeftColor: SKR_PURPLE },
  perkTitle: { fontFamily: mono, fontSize: 13, fontWeight: '900' },
  note: { color: colors.muted, fontFamily: mono, fontSize: 10, lineHeight: 15 },
  btn: { backgroundColor: colors.gold, borderRadius: 6, paddingVertical: 10, alignItems: 'center', marginTop: 4 },
  dim: { opacity: 0.6 },
  btnText: { color: '#0c1118', fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
