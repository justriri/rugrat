import { FlatList, StyleSheet, Text, View } from 'react-native';

import type { FeedItem } from '../game/ReplayEngine';
import { LABEL_NOTE } from '../copy/notice';
import { fmtElapsed } from '../game/timeline';
import type { WalletAction, WalletTag } from '../game/types';
import { colors, mono } from '../theme';

const TAG_COLOR: Record<WalletTag, string> = {
  DEV: colors.red,
  INSIDER: '#ff9f43',
  SMART: colors.blue,
  WHALE: '#b48cff',
  LIQUIDITY: '#3dd6d0',
};

const ACTION_LABEL: Record<WalletAction, string> = {
  BUY: 'BUY',
  SELL: 'SELL',
  SUPPLY_MOVE: 'SUPPLY MOVE',
  LIQUIDITY_REMOVAL: 'LIQUIDITY REMOVAL',
};

const ACTION_COLOR: Record<WalletAction, string> = {
  BUY: colors.green,
  SELL: colors.red,
  SUPPLY_MOVE: colors.gold,
  LIQUIDITY_REMOVAL: colors.red,
};

/** Wallet addresses are shown with the first characters visible and the rest faded out. */
function BlurredAddress({ wallet }: { wallet: string }) {
  const head = wallet.slice(0, 2);
  return (
    <View style={styles.addr}>
      <Text style={styles.addrHead}>{head}</Text>
      {[0.5, 0.4, 0.32, 0.25, 0.18, 0.12, 0.08].map((o, i) => (
        <View key={i} style={[styles.fuzz, { opacity: o }]} />
      ))}
    </View>
  );
}

function fmtAmount(e: FeedItem['event']): string {
  if (e.amount === undefined) return '';
  const n = e.amount;
  const short = n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);
  return e.amountUnit === 'USD' ? `$${short}` : `${short} ${e.amountUnit ?? ''}`.trim();
}

export function WalletFeed({
  items,
  startTs,
  tagsVisible,
}: {
  items: FeedItem[];
  startTs: number;
  tagsVisible: boolean;
}) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>
        WALLET ACTIVITY<Text style={styles.titleNote}>  ·  {LABEL_NOTE}</Text>
      </Text>
      <FlatList
        data={items}
        keyExtractor={(i) => i.key}
        ListEmptyComponent={<Text style={styles.empty}>Watching the wallets...</Text>}
        renderItem={({ item }) => {
          const e = item.event;
          const flaggedTag = e.tag === 'DEV' || e.tag === 'INSIDER' || e.tag === 'SMART';
          // Hard mode hides identity until the reveal: no address, no tag.
          const showTag = tagsVisible && e.tag !== undefined;
          // important clues stand out; hidden in hard mode so nothing leaks before the reveal
          const important = tagsVisible && ((e.tag === 'SMART' && e.action === 'SELL') || e.tag === 'DEV' || e.action === 'LIQUIDITY_REMOVAL' || e.tag === 'LIQUIDITY');
          return (
            <View style={[styles.row, important && styles.rowImportant]}>
              <Text style={styles.time}>{fmtElapsed(e.timestamp - startTs)}</Text>
              <BlurredAddress wallet={tagsVisible ? e.wallet : '??'} />
              {showTag && e.tag && (
                <View style={[styles.tag, { backgroundColor: TAG_COLOR[e.tag] }]}>
                  <Text style={styles.tagText}>{flaggedTag ? `${e.tag} · NOTABLE` : e.tag}</Text>
                </View>
              )}
              {!tagsVisible && (
                <View style={[styles.tag, { backgroundColor: colors.muted }]}>
                  <Text style={styles.tagText}>???</Text>
                </View>
              )}
              <Text style={[styles.action, { color: ACTION_COLOR[e.action] }]} numberOfLines={1}>
                {ACTION_LABEL[e.action]}
              </Text>
              <Text style={styles.amount}>{fmtAmount(e)}</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.panel, paddingHorizontal: 10, paddingTop: 8 },
  title: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '800', marginBottom: 4 },
  titleNote: { fontWeight: '500', fontSize: 9 },
  empty: { color: colors.muted, fontFamily: mono, fontSize: 12, paddingVertical: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.panelEdge,
  },
  rowImportant: { backgroundColor: 'rgba(247,197,59,0.12)', borderLeftWidth: 4, borderLeftColor: colors.gold, paddingLeft: 4 },
  time: { color: colors.muted, fontFamily: mono, fontSize: 10, width: 44 },
  addr: { flexDirection: 'row', alignItems: 'center', gap: 2, width: 60 },
  addrHead: { color: colors.text, fontFamily: mono, fontSize: 12, fontWeight: '700' },
  fuzz: { width: 4, height: 10, borderRadius: 2, backgroundColor: colors.text },
  tag: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  tagText: { color: '#0c1118', fontFamily: mono, fontSize: 9, fontWeight: '900' },
  action: { flex: 1, fontFamily: mono, fontSize: 11, fontWeight: '800' },
  amount: { color: colors.text, fontFamily: mono, fontSize: 12, fontWeight: '700' },
});
