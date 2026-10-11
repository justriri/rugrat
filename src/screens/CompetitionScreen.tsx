import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CompetitionTab } from '../app/nav';
import { ScreenFrame } from '../components/ScreenFrame';
import { WalletBar } from '../components/WalletBar';
import { BadgePanel } from './BadgePanel';
import { SkrPanel } from './SkrPanel';
import { useChain } from '../chain/ChainContext';
import { CHAIN_BADGE_LABEL } from '../chain/labels';
import { compareOnRug } from '../competition/compare';
import { useCompetition } from '../competition/CompetitionContext';
import { DEMO_FRIEND_IDS } from '../competition/demo';
import { buildLeaderboard } from '../competition/leaderboard';
import type { RunResult } from '../competition/result';
import { bestPerRug, computeStats } from '../competition/stats';
import { REPLAYS } from '../data/replays';
import { fmtElapsed, fmtSpan } from '../game/timeline';
import { colors, fmtPct, mono } from '../theme';

const TABS: { id: CompetitionTab; label: string }[] = [
  { id: 'LEADERBOARD', label: 'BOARD' },
  { id: 'FRIENDS', label: 'FRIENDS' },
  { id: 'STATS', label: 'STATS' },
  { id: 'BADGE', label: 'BADGE' },
  { id: 'SKR', label: 'SKR' },
];
const VERDICT_LABEL = { CLEAN_EXIT: 'CLEAN', LATE_EXIT: 'LATE', RUGGED: 'RUGGED' } as const;
const VERDICT_COLOR = { CLEAN_EXIT: colors.green, LATE_EXIT: colors.gold, RUGGED: colors.red } as const;

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** LOCAL until every result counted for you is recorded onchain. Never shown for DEMO players. */
function StatusBadge({ verified }: { verified: boolean }) {
  return (
    <View style={[styles.demo, { backgroundColor: verified ? colors.green : colors.panelEdge }]}>
      <Text style={[styles.demoText, !verified && { color: colors.text }]}>{verified ? CHAIN_BADGE_LABEL.ONCHAIN_VERIFIED : CHAIN_BADGE_LABEL.LOCAL}</Text>
    </View>
  );
}

function DemoBadge() {
  return (
    <View style={styles.demo}>
      <Text style={styles.demoText}>DEMO</Text>
    </View>
  );
}

const rugName = (id: string) => REPLAYS.find((r) => r.id === id)?.symbol ?? id;
const startOf = (id: string) => REPLAYS.find((r) => r.id === id)?.replayStart ?? 0;

// ------------------------------------------------------------------ leaderboard
function LeaderboardTab() {
  const { players, you } = useCompetition();
  const chain = useChain();
  const [filter, setFilter] = useState<string>('ALL');
  const rows = useMemo(() => buildLeaderboard(players, filter), [players, filter]);
  const youRanked = rows.some((r) => r.isYou);
  const counted = bestPerRug(filter === 'ALL' ? you.runs : you.runs.filter((r) => r.rugId === filter));
  const youVerified = counted.length > 0 && counted.every((r) => chain.badgeOf(r.runId) === 'ONCHAIN_VERIFIED');
  return (
    <View style={styles.pane}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="ALL RUGS" active={filter === 'ALL'} onPress={() => setFilter('ALL')} />
        {REPLAYS.map((r) => (
          <Chip key={r.id} label={r.symbol} active={filter === r.id} onPress={() => setFilter(r.id)} />
        ))}
      </ScrollView>
      <View style={[styles.row, styles.head]}>
        <Text style={[styles.hc, { width: 28 }]}>#</Text>
        <Text style={[styles.hc, { flex: 1 }]}>PLAYER</Text>
        <Text style={[styles.hc, styles.num]}>SCORE</Text>
        <Text style={[styles.hc, styles.num2]}>SURV</Text>
        <Text style={[styles.hc, styles.num2]}>CLEAN</Text>
      </View>
      <ScrollView>
        {rows.map((r) => (
          <View key={r.playerId} style={[styles.row, r.isYou && styles.you]}>
            <Text style={[styles.cell, { width: 28 }]}>{r.rank}</Text>
            <View style={[styles.nameCell, { flex: 1 }]}>
              <Text style={[styles.cell, r.isYou && styles.cellYou]} numberOfLines={1}>
                {r.name}
              </Text>
              {r.demo && <DemoBadge />}
              {r.isYou && <StatusBadge verified={youVerified} />}
            </View>
            <Text style={[styles.cell, styles.num, styles.score]}>{r.score}</Text>
            <Text style={[styles.cell, styles.num2]}>{r.rugsSurvived}</Text>
            <Text style={[styles.cell, styles.num2]}>{r.cleanExits}</Text>
          </View>
        ))}
        {!youRanked && <Text style={styles.hint}>Play {filter === 'ALL' ? 'a rug' : `$${rugName(filter)}`} to get on the board.</Text>}
        <Text style={styles.note}>Ranked by skill score only: surviving, exiting before the signal, staying in while safe. Money never counts. DEMO players are mock data, not real users.</Text>
      </ScrollView>
    </View>
  );
}

// ------------------------------------------------------------------ friends
function RunLine({ run }: { run: RunResult | null; label: string }) {
  if (!run) return <Text style={styles.cell}>not played</Text>;
  return (
    <View>
      <Text style={[styles.cmpVerdict, { color: VERDICT_COLOR[run.verdict] }]}>{VERDICT_LABEL[run.verdict]}</Text>
      <Text style={styles.cmpScore}>{run.score}</Text>
      <Text style={styles.cmpSmall}>{run.exitTimestamp !== null ? `out ${fmtElapsed(run.exitTimestamp - startOf(run.rugId))}` : 'held'}</Text>
      <Text style={styles.cmpSmall}>in for {fmtSpan(run.survivalSeconds)}</Text>
    </View>
  );
}

function FriendsTab() {
  const { players, you } = useCompetition();
  const friends = useMemo(
    () =>
      players
        .filter((p) => DEMO_FRIEND_IDS.includes(p.playerId))
        .map((p) => ({ p, s: computeStats(p.runs) }))
        .sort((a, b) => b.s.totalScore - a.s.totalScore || (a.p.name < b.p.name ? -1 : 1)),
    [players],
  );
  const mine = computeStats(you.runs);
  const [friendId, setFriendId] = useState<string>(friends[0]?.p.playerId ?? '');
  const [rugId, setRugId] = useState<string>(REPLAYS[0].id);
  const friend = friends.find((f) => f.p.playerId === friendId)?.p;
  const cmp = friend ? compareOnRug(you, friend, rugId) : null;
  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={[styles.card, styles.you]}>
        <Text style={styles.cardTitle}>YOU</Text>
        <Text style={styles.big}>Score: {mine.totalScore}</Text>
        <Text style={styles.cell}>Rugs survived: {mine.rugsSurvived}</Text>
        <Text style={styles.cell}>Clean exits: {mine.cleanExits}</Text>
      </View>
      <Text style={styles.section}>FRIENDS</Text>
      {friends.map(({ p, s }) => (
        <Pressable key={p.playerId} onPress={() => setFriendId(p.playerId)} style={[styles.friend, friendId === p.playerId && styles.friendActive]}>
          <View style={styles.nameCell}>
            <Text style={styles.cell}>{p.name}</Text>
            {p.demo && <DemoBadge />}
          </View>
          <Text style={[styles.cell, styles.score]}>{s.totalScore}</Text>
        </Pressable>
      ))}
      <Text style={styles.section}>SAME-RUG COMPARISON</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {REPLAYS.map((r) => (
          <Chip key={r.id} label={r.symbol} active={rugId === r.id} onPress={() => setRugId(r.id)} />
        ))}
      </ScrollView>
      {cmp && cmp.ok ? (
        <View style={styles.card}>
          <Text style={styles.note}>
            Same rug (${rugName(rugId)}), same {cmp.startingPaperSol} paper SOL start.
          </Text>
          <View style={styles.cmp}>
            <View style={styles.cmpCol}>
              <Text style={styles.cardTitle}>YOU</Text>
              <RunLine run={cmp.you} label="you" />
            </View>
            <View style={styles.cmpCol}>
              <Text style={styles.cardTitle}>{friend?.name}</Text>
              <RunLine run={cmp.friend} label="friend" />
            </View>
          </View>
          <Text style={[styles.big, { textAlign: 'center' }]}>{cmp.winner === 'tie' ? 'TIE' : cmp.winner === 'you' ? 'YOU WIN THIS RUG' : `${friend?.name.toUpperCase()} WINS THIS RUG`}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          {cmp && !cmp.ok && cmp.reason === 'NO_YOU' ? `Play $${rugName(rugId)} to compare with ${friend?.name}.` : cmp && !cmp.ok && cmp.reason === 'NO_FRIEND' ? `${friend?.name} has not played $${rugName(rugId)}.` : 'These runs did not start from the same paper balance, so they cannot be compared.'}
        </Text>
      )}
      <Text style={styles.note}>Friends are local demo data for now. A real identity can replace them later.</Text>
    </ScrollView>
  );
}

// ------------------------------------------------------------------ my stats
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function StatsTab() {
  const { you } = useCompetition();
  const chain = useChain();
  const s = computeStats(you.runs);
  const best = bestPerRug(you.runs);
  if (you.runs.length === 0) return <Text style={[styles.hint, { padding: 14 }]}>No runs yet. Play a rug and your stats will show up here.</Text>;
  return (
    <ScrollView contentContainerStyle={styles.paneScroll}>
      <View style={styles.card}>
        <StatRow label="Best Survival Score" value={`${s.bestSurvivalScore}`} />
        <StatRow label="Rugs Survived" value={`${s.rugsSurvived} of ${s.rugsPlayed}`} />
        <StatRow label="Clean Exits" value={`${s.cleanExits}`} />
        <StatRow label="Late Exits" value={`${s.lateExits}`} />
        <StatRow label="Rugs Rugged" value={`${s.rugsRugged}`} />
        <StatRow label="Best P/L %" value={s.bestPnlPct === null ? '-' : fmtPct(s.bestPnlPct)} />
        <StatRow label="Fastest Successful Exit" value={s.fastestSuccessfulExit ? `${fmtSpan(s.fastestSuccessfulExit.seconds)} on $${s.fastestSuccessfulExit.rugSymbol}` : '-'} />
      </View>
      <Text style={styles.section}>BEST RESULT PER RUG</Text>
      {best.map((r) => (
        <View key={r.rugId} style={styles.friend}>
          <Text style={styles.cell}>${r.rugSymbol}</Text>
          <Text style={[styles.cell, { color: VERDICT_COLOR[r.verdict] }]}>{VERDICT_LABEL[r.verdict]}</Text>
          <Text style={[styles.cell, styles.score]}>{r.score}</Text>
          <StatusBadge verified={chain.badgeOf(r.runId) === 'ONCHAIN_VERIFIED'} />
        </View>
      ))}
      <Text style={styles.note}>Each rug counts once, using your best score on it.</Text>
    </ScrollView>
  );
}

export function CompetitionScreen({ tab, onTab, onBack }: { tab: CompetitionTab; onTab: (t: CompetitionTab) => void; onBack: () => void }) {
  return (
    <ScreenFrame title="COMPETITION" onBack={onBack}>
      <WalletBar />
      <View style={styles.tabs}>
        {TABS.map((t) => (
          <Pressable key={t.id} onPress={() => onTab(t.id)} style={[styles.tab, tab === t.id && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t.id && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 'LEADERBOARD' && <LeaderboardTab />}
      {tab === 'FRIENDS' && <FriendsTab />}
      {tab === 'STATS' && <StatsTab />}
      {tab === 'BADGE' && <BadgePanel />}
      {tab === 'SKR' && <SkrPanel />}
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  pane: { flex: 1, paddingHorizontal: 14 },
  paneScroll: { paddingHorizontal: 14, paddingBottom: 24, gap: 10 },
  tabs: { flexDirection: 'row', paddingHorizontal: 14, gap: 6, marginBottom: 10 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 6, backgroundColor: colors.panel, alignItems: 'center' },
  tabActive: { backgroundColor: colors.gold },
  tabText: { color: colors.muted, fontFamily: mono, fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  tabTextActive: { color: '#0c1118' },
  chips: { gap: 6, paddingVertical: 4, paddingRight: 14 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: colors.panel },
  chipActive: { backgroundColor: colors.green },
  chipText: { color: colors.text, fontFamily: mono, fontSize: 11, fontWeight: '800' },
  chipTextActive: { color: '#0c1118' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 6, borderBottomWidth: 1, borderBottomColor: colors.panelEdge },
  head: { marginTop: 6 },
  hc: { color: colors.muted, fontFamily: mono, fontSize: 10, fontWeight: '800' },
  cell: { color: colors.text, fontFamily: mono, fontSize: 13, fontWeight: '700' },
  cellYou: { color: colors.gold },
  nameCell: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  num: { width: 60, textAlign: 'right' },
  num2: { width: 46, textAlign: 'right' },
  score: { color: colors.gold, fontWeight: '900' },
  you: { backgroundColor: 'rgba(247,197,59,0.1)', borderRadius: 6 },
  demo: { backgroundColor: colors.muted, borderRadius: 3, paddingHorizontal: 4, paddingVertical: 1 },
  demoText: { color: '#0c1118', fontFamily: mono, fontSize: 8, fontWeight: '900' },
  hint: { color: colors.gold, fontFamily: mono, fontSize: 12, paddingVertical: 10 },
  note: { color: colors.muted, fontFamily: mono, fontSize: 10, lineHeight: 15, paddingVertical: 8 },
  section: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '900', letterSpacing: 2, marginTop: 6 },
  card: { backgroundColor: colors.panel, borderRadius: 8, padding: 12, gap: 4 },
  cardTitle: { color: colors.muted, fontFamily: mono, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  big: { color: colors.text, fontFamily: mono, fontSize: 18, fontWeight: '900' },
  friend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.panel, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10 },
  friendActive: { borderWidth: 2, borderColor: colors.gold },
  cmp: { flexDirection: 'row', gap: 12, marginVertical: 6 },
  cmpCol: { flex: 1, gap: 2 },
  cmpVerdict: { fontFamily: mono, fontSize: 14, fontWeight: '900' },
  cmpScore: { color: colors.text, fontFamily: mono, fontSize: 24, fontWeight: '900' },
  cmpSmall: { color: colors.muted, fontFamily: mono, fontSize: 10 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.panelEdge },
  statLabel: { color: colors.muted, fontFamily: mono, fontSize: 12, fontWeight: '700' },
  statValue: { color: colors.text, fontFamily: mono, fontSize: 13, fontWeight: '900' },
});
