import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { RUG_HUNTER_REQUIRED, uniqueVerifiedSurvivingRugs } from '../badge/achievement';
import { fetchOwnedTiers, upgradeTier } from '../upgrade/client';
import { upgradeAvailability } from '../upgrade/config';
import { formatPrice, PRICES_ARE_FINAL, tierViews } from '../upgrade/tiers';
import { useChain } from '../chain/ChainContext';
import { CHAIN_BADGE_LABEL } from '../chain/labels';
import { CLUSTER, explorerAddressUrl, explorerTxUrl, shortAddress } from '../chain/config';
import { REPLAYS } from '../data/replays';
import { colors, mono } from '../theme';

const STATUS_COLOR = { LOCKED: colors.muted, UNLOCKED: colors.gold, CLAIMED: colors.green } as const;
const VERDICT_LABEL = { CLEAN_EXIT: 'CLEAN', LATE_EXIT: 'LATE' } as const;

/** Rug Hunter: progress comes only from score records read back from the chain and checked against the game's rules. */
export function BadgePanel() {
  const chain = useChain();
  const { session, progress, badge, claim } = chain;
  const [busy, setBusy] = useState<'refresh' | 'claim' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [owned, setOwned] = useState<number[]>([]);
  const [upgrading, setUpgrading] = useState<number | null>(null);
  const avail = upgradeAvailability();
  // upgrades are offered (and priced) only once real prices are configured
  const upgradesActive = avail.available && PRICES_ARE_FINAL;
  const views = tierViews(progress ?? uniqueVerifiedSurvivingRugs([], '', REPLAYS), owned);
  useEffect(() => {
    if (session && avail.available) void fetchOwnedTiers(session).then(setOwned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.address]);
  const doUpgrade = async (tier: number) => {
    if (!session) return;
    setUpgrading(tier);
    setMessage(null);
    const out = await upgradeTier(session, tier);
    setUpgrading(null);
    if (out.ok) {
      setMessage('Upgrade complete. Your new badge is in your wallet.');
      void fetchOwnedTiers(session).then(setOwned);
    } else setMessage(out.message);
  };

  const refresh = async () => {
    setBusy('refresh');
    setMessage(null);
    const r = await chain.refreshProgress();
    setBusy(null);
    if (r.error) setMessage(r.error.message);
  };
  useEffect(() => {
    if (session) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.address]);

  const doClaim = async () => {
    setBusy('claim');
    setMessage(null);
    const out = await chain.claimBadge();
    setBusy(null);
    if (out.ok) setMessage('Badge claimed.');
    else if (out.reason === 'ALREADY_CLAIMED') setMessage('Already claimed. This wallet already has its Rug Hunter badge.');
    else if (out.reason === 'NOT_ELIGIBLE') setMessage(`Not unlocked yet: ${out.progress.count} / ${out.progress.required} unique rugs survived.`);
    else setMessage(out.error.message);
  };

  const count = progress?.count ?? 0;
  return (
    <ScrollView contentContainerStyle={styles.pane}>
      <View style={styles.card}>
        <Text style={styles.title}>🏆 RUG HUNTER</Text>
        <Text style={[styles.status, { color: STATUS_COLOR[badge] }]}>{badge}</Text>
        <Text style={styles.big}>
          {count} / {RUG_HUNTER_REQUIRED} unique rugs survived
        </Text>
        <Text style={styles.small}>Survive {RUG_HUNTER_REQUIRED} different real rugs (clean or late exit). Each rug counts once. Only scores recorded onchain count (each is checked against the game's rules); DEMO and rugged runs never do.</Text>
      </View>

      <Text style={styles.section}>RUGS COUNTED</Text>
      {REPLAYS.map((r) => {
        const c = progress?.counted.find((x) => x.rugId === r.id);
        return (
          <View key={r.id} style={styles.line}>
            <Text style={styles.cell}>${r.symbol}</Text>
            {c ? (
              <>
                <Text style={[styles.cell, { color: colors.green }]}>{VERDICT_LABEL[c.verdict]} · {c.score}</Text>
                <Text style={[styles.cell, { color: colors.green }]}>{CHAIN_BADGE_LABEL.ONCHAIN_VERIFIED}</Text>
              </>
            ) : (
              <Text style={styles.cell}>not counted yet</Text>
            )}
          </View>
        );
      })}

      {!session && <Text style={styles.hint}>{badge === 'LOCKED' ? 'Connect a wallet (above) to load your recorded runs.' : ''}</Text>}
      {!session && <Text style={styles.small}>You can play and earn progress without a wallet; record your scores onchain after each run, then connect to claim.</Text>}

      {!session && badge === 'UNLOCKED' && (
        <>
          <Text style={styles.unlocked}>🏆 RUG HUNTER UNLOCKED</Text>
          <Text style={styles.small}>You survived {count} unique rugs. Connect your wallet above to claim the badge.</Text>
        </>
      )}
      {session && badge === 'UNLOCKED' && (
        <>
          <Text style={styles.unlocked}>🏆 RUG HUNTER UNLOCKED</Text>
          <Text style={styles.small}>You survived {count} unique rugs.</Text>
          <Pressable style={[styles.btn, busy === 'claim' && styles.dim]} onPress={doClaim} disabled={busy !== null}>
            {busy === 'claim' ? <ActivityIndicator color="#0c1118" /> : <Text style={styles.btnText}>CLAIM RUG HUNTER BADGE</Text>}
          </Pressable>
          <Text style={styles.small}>Mints a non-transferable Metaplex Core badge to {shortAddress(session.address)} on Solana {CLUSTER}. Costs only the network fee (plus account rent).</Text>
        </>
      )}

      {badge === 'CLAIMED' && claim && (
        <View style={styles.card}>
          <Text style={[styles.status, { color: colors.green }]}>🏆 BADGE EARNED</Text>
          <Text style={styles.cell}>Rug Hunter</Text>
          <Text style={styles.small}>Rugs survived: {claim.rugsSurvived}</Text>
          <Text style={styles.small} selectable>
            Asset: {shortAddress(claim.assetAddress)}
          </Text>
          <Text style={styles.small}>Mint tx: {claim.signature ? shortAddress(claim.signature) : 'minted earlier (found onchain)'}</Text>
          <Text style={styles.small}>Verification: {claim.signature ? 'minted by this wallet, onchain' : 'found onchain at this wallet\'s badge address'}</Text>
          <Pressable style={styles.link} onPress={() => void Linking.openURL(explorerAddressUrl(claim.assetAddress)).catch(() => undefined)}>
            <Text style={styles.linkText}>VIEW ASSET</Text>
          </Pressable>
          {claim.signature && (
            <Pressable style={styles.link} onPress={() => void Linking.openURL(explorerTxUrl(claim.signature as string)).catch(() => undefined)}>
              <Text style={styles.linkText}>VIEW TRANSACTION</Text>
            </Pressable>
          )}
        </View>
      )}

      <Text style={styles.section}>BADGE UPGRADES</Text>
      {views.map((v) => (
        <View key={v.tier.tier} style={styles.line}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cell}>{v.tier.name}</Text>
            <Text style={styles.small}>
              {v.have} / {v.tier.requiredRugs} unique rugs{upgradesActive ? ` · ${formatPrice(v.tier.priceBaseUnits)} SKR` : ' · not active yet'}
            </Text>
          </View>
          {v.status === 'OWNED' ? (
            <Text style={[styles.cell, { color: colors.green }]}>OWNED</Text>
          ) : v.status === 'ELIGIBLE' && session && upgradesActive ? (
            <Pressable style={[styles.upBtn, upgrading !== null && styles.dim]} onPress={() => doUpgrade(v.tier.tier)} disabled={upgrading !== null}>
              {upgrading === v.tier.tier ? <ActivityIndicator color="#0c1118" /> : <Text style={styles.btnText}>UPGRADE</Text>}
            </Pressable>
          ) : (
            <Text style={styles.small}>{v.status === 'ELIGIBLE' ? (upgradesActive ? 'connect wallet' : 'COMING SOON') : 'LOCKED'}</Text>
          )}
        </View>
      ))}
      <Text style={styles.small}>
        {upgradesActive ? 'Upgrades are cosmetic badges only. They never change score, rank or prizes.' : 'Badge upgrades are not active yet. Prices have not been set.'}
        {' '}Eligibility comes from your runs recorded onchain. Tiers beyond the first need more rugs than the catalogue holds today.
      </Text>

      {session && (
        <Pressable style={[styles.ghost, busy !== null && styles.dim]} onPress={refresh} disabled={busy !== null}>
          {busy === 'refresh' ? <ActivityIndicator color={colors.text} /> : <Text style={styles.ghostText}>REFRESH FROM CHAIN</Text>}
        </Pressable>
      )}
      {message && <Text style={styles.hint}>{message}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pane: { paddingHorizontal: 14, paddingBottom: 24, gap: 10 },
  card: { backgroundColor: colors.panel, borderRadius: 8, padding: 12, gap: 5 },
  title: { color: colors.gold, fontFamily: mono, fontSize: 16, fontWeight: '900' },
  status: { fontFamily: mono, fontSize: 13, fontWeight: '900', letterSpacing: 2 },
  big: { color: colors.text, fontFamily: mono, fontSize: 18, fontWeight: '900' },
  small: { color: colors.muted, fontFamily: mono, fontSize: 11, lineHeight: 15 },
  section: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginTop: 4 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.panel, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  cell: { color: colors.text, fontFamily: mono, fontSize: 12, fontWeight: '700' },
  hint: { color: colors.gold, fontFamily: mono, fontSize: 12 },
  unlocked: { color: colors.gold, fontFamily: mono, fontSize: 16, fontWeight: '900' },
  btn: { backgroundColor: colors.gold, borderRadius: 6, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#0c1118', fontFamily: mono, fontSize: 13, fontWeight: '900', letterSpacing: 1 },
  ghost: { backgroundColor: colors.panel, borderRadius: 6, paddingVertical: 10, alignItems: 'center' },
  ghostText: { color: colors.text, fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
  dim: { opacity: 0.6 },
  upBtn: { backgroundColor: colors.gold, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center' },
  link: { paddingVertical: 4 },
  linkText: { color: colors.green, fontFamily: mono, fontSize: 12, fontWeight: '900', letterSpacing: 1 },
});
