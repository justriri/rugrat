import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { GameSnapshot } from '../game/ReplayEngine';
import { LABEL_NOTE } from '../copy/notice';
import { fmtElapsed, fmtSpan } from '../game/timeline';
import type { Verdict, VerdictResult } from '../game/verdict';
import { colors, fmtPct, fmtPrice, fmtSol, mono } from '../theme';

interface Props {
  state: GameSnapshot;
  startTimestamp: number;
  onReplay: () => void;
  onSell: () => void;
  onWatch: () => void;
  onReveal: () => void;
  /** Back to the rug list, to choose another rug. */
  onExit: () => void;
  /** The skill score for the run that just ended (null until the run is over). */
  score: number | null;
  /** Optional extra block shown with the final score (the onchain record step). */
  extra?: ReactNode;
}

const utc = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 19) + ' UTC';
const when = (ts: number, start: number) => `${utc(ts)} (${fmtElapsed(ts - start)})`;

const VERDICT_COLOR: Record<Verdict, string> = {
  CLEAN_EXIT: colors.green,
  LATE_EXIT: colors.gold,
  RUGGED: colors.red,
};
const VERDICT_TITLE: Record<Verdict, string> = {
  CLEAN_EXIT: 'CLEAN EXIT',
  LATE_EXIT: 'LATE EXIT',
  RUGGED: 'RUGGED',
};

function verdictCopy(v: VerdictResult): { line: string; detail: string | null } {
  const ahead = v.aheadOfSignalSeconds;
  if (v.verdict === 'CLEAN_EXIT') {
    return {
      line: `Out before the ${v.signalGroup}.`,
      detail: ahead !== null ? `You sold ${fmtSpan(ahead)} before the first ${v.signalGroup} signal.` : null,
    };
  }
  if (v.verdict === 'LATE_EXIT') {
    return {
      line: `You escaped, but the ${v.signalGroup} moved first.`,
      detail: ahead !== null ? `You sold ${fmtSpan(ahead)} after the first ${v.signalGroup} signal.` : null,
    };
  }
  return {
    line: v.heldThroughCollapse ? 'You stayed in through the collapse.' : 'You sold after the collapse.',
    detail: null,
  };
}

/**
 * Exit sheet (replay frozen, with the choice to watch on) and the end-of-run verdict screen.
 * Figures here come straight from the player's recorded trade; nothing changes after the sell.
 */
export function ResultSheet({ state, startTimestamp, onReplay, onSell, onWatch, onReveal, onExit, score, extra }: Props) {
  const p = state.player;

  // ---- the player just sold: result + the choice to watch what happened next
  if (state.phase === 'exited' && p.sellPrice !== null && p.sellTimestamp !== null && p.buyPrice !== null) {
    const pnl = p.realizedPnlPct ?? 0;
    const color = pnl >= 0 ? colors.green : colors.red;
    return (
      <View style={[styles.sheet, { borderTopColor: color }]}>
        <Text style={styles.title}>EXITED · REPLAY FROZEN</Text>
        <View style={styles.grid}>
          <Stat label="EXIT PRICE" value={fmtPrice(p.sellPrice)} />
          <Stat label="ENTRY PRICE" value={fmtPrice(p.buyPrice)} />
        </View>
        <View style={styles.grid}>
          <Stat label="P/L" value={`${fmtSol(p.realizedPnlSol)} SOL (${fmtPct(pnl)})`} color={color} />
          <Stat label="PAPER SOL BALANCE" value={fmtSol(p.paperSol)} color={colors.gold} />
        </View>
        <Stat label="EXIT TIME" value={when(p.sellTimestamp, startTimestamp)} />
        <Pressable style={styles.btn} onPress={onWatch}>
          <Text style={styles.btnText}>WATCH WHAT HAPPENED</Text>
        </Pressable>
        <EndButtons onReplay={onReplay} onExit={onExit} />
      </View>
    );
  }

  // ---- the Reveal is over: what actually happened, then the verdict again
  if (state.phase === 'revealed' && state.reveal) {
    const r = state.reveal;
    const v = state.verdict;
    const color = v ? VERDICT_COLOR[v.verdict] : colors.muted;
    return (
      <View style={[styles.sheet, { borderTopColor: color }]}>
        <Text style={styles.title}>WHAT HAPPENED</Text>
        <Stat
          label="YOUR EXIT"
          value={
            r.exit
              ? `${fmtPrice(r.exit.price)}  ·  ${when(r.exit.timestamp, startTimestamp)}`
              : r.heldThroughCollapse
                ? 'You held through the collapse'
                : 'You did not trade'
          }
        />
        <Stat
          label={`FIRST MAJOR ${(v ? v.signalGroup : 'signal').toUpperCase()} SIGNAL`}
          value={
            r.signal
              ? `${fmtPrice(r.signal.price)}  ·  ${when(r.signal.timestamp, startTimestamp)}`
              : 'none in this replay'
          }
        />
        <Stat label="COLLAPSE" value={`${fmtPrice(r.collapse.price)}  ·  ${when(r.collapse.timestamp, startTimestamp)}`} />
        {v && (
          <>
            <Text style={[styles.verdict, { color }]}>{VERDICT_TITLE[v.verdict]}</Text>
            <Text style={styles.note}>{verdictCopy(v).line}</Text>
          </>
        )}
        {score !== null && <Stat label="SKILL SCORE" value={`${score} / 1000`} color={colors.gold} />}
        {score !== null && extra}
        <EndButtons onReplay={onReplay} onExit={onExit} />
      </View>
    );
  }

  // ---- the run ended: verdict
  if (state.phase === 'finished') {
    const v = state.verdict;
    if (v) {
      const color = VERDICT_COLOR[v.verdict];
      const copy = verdictCopy(v);
      return (
        <View style={[styles.sheet, { borderTopColor: color }]}>
          <Text style={[styles.verdict, { color }]}>{VERDICT_TITLE[v.verdict]}</Text>
          <Text style={styles.note}>{copy.line}</Text>
          {copy.detail && <Text style={styles.noteDim}>{copy.detail}</Text>}
          <View style={styles.grid}>
            <Stat label="ENTRY PRICE" value={fmtPrice(v.entryPrice)} />
            <Stat
              label={v.exitPrice !== null ? 'EXIT PRICE' : 'COLLAPSE PRICE'}
              value={fmtPrice(v.exitPrice !== null ? v.exitPrice : v.collapsePrice)}
            />
          </View>
          <View style={styles.grid}>
            <Stat
              label={v.exitPrice !== null ? 'P/L' : 'P/L AT COLLAPSE'}
              value={`${fmtSol(v.pnlSol)} SOL (${fmtPct(v.pnlPct)})`}
              color={v.pnlPct >= 0 ? colors.green : colors.red}
            />
            <Stat label={v.exitPrice !== null ? 'PAPER SOL' : 'VALUE AT COLLAPSE'} value={fmtSol(v.balanceSol)} color={colors.gold} />
          </View>
          {v.exitTimestamp !== null && <Stat label="YOUR EXIT" value={when(v.exitTimestamp, startTimestamp)} />}
          {v.signalTimestamp !== null && (
            <Stat label={`FIRST ${v.signalGroup.toUpperCase()} SIGNAL`} value={when(v.signalTimestamp, startTimestamp)} />
          )}
          <Stat label="COLLAPSE" value={when(v.collapseTimestamp, startTimestamp)} />
          {score !== null && <Stat label="SKILL SCORE" value={`${score} / 1000`} color={colors.gold} />}
          {score !== null && extra}
          <Pressable style={styles.btn} onPress={onReveal}>
            <Text style={styles.btnText}>SEE WHAT HAPPENED</Text>
          </Pressable>
          <EndButtons onReplay={onReplay} onExit={onExit} />
        </View>
      );
    }
    // finished without ever buying: nothing to judge
    return (
      <View style={[styles.sheet, { borderTopColor: colors.muted }]}>
        <Text style={styles.title}>REPLAY ENDED</Text>
        <Text style={styles.note}>You did not trade. Paper SOL: {fmtSol(p.paperSol)}.</Text>
        <Pressable style={styles.btn} onPress={onReveal}>
          <Text style={styles.btnText}>SEE WHAT HAPPENED</Text>
        </Pressable>
        <EndButtons onReplay={onReplay} onExit={onExit} />
      </View>
    );
  }

  return null;
}

/**
 * Compact result shown in place of the controls while the player watches the rest of the replay,
 * so their exit stays visible and the wallet feed below stays readable.
 */
export function ResultStrip({ state, startTimestamp }: { state: GameSnapshot; startTimestamp: number }) {
  const p = state.player;
  if (state.phase === 'revealing') {
    return (
      <View style={[styles.strip, { borderLeftColor: colors.gold }]}>
        <Text style={styles.stripTitle}>THE REVEAL · everything is visible</Text>
        <Text style={styles.stripText}>
          {p.buyPrice === null
            ? 'You did not trade.'
            : p.sellPrice !== null
              ? `You: in ${fmtPrice(p.buyPrice)} → out ${fmtPrice(p.sellPrice)}`
              : `You: in ${fmtPrice(p.buyPrice)} → held through the collapse`}
        </Text>
        <Text style={styles.stripText}>creeper DEV · villagers INSIDER · gold SMART · purple WHALE</Text>
        <Text style={styles.stripNote}>{LABEL_NOTE}</Text>
      </View>
    );
  }
  if (p.sellPrice === null || p.sellTimestamp === null || p.buyPrice === null) return null;
  const pnl = p.realizedPnlPct ?? 0;
  const color = pnl >= 0 ? colors.green : colors.red;
  return (
    <View style={[styles.strip, { borderLeftColor: color }]}>
      <Text style={styles.stripTitle}>YOU SOLD · {fmtPct(pnl)}</Text>
      <Text style={styles.stripText}>
        in {fmtPrice(p.buyPrice)} → out {fmtPrice(p.sellPrice)} · {fmtSol(p.paperSol)} SOL
      </Text>
      <Text style={styles.stripText}>{when(p.sellTimestamp, startTimestamp)}</Text>
    </View>
  );
}

function EndButtons({ onReplay, onExit }: { onReplay: () => void; onExit: () => void }) {
  return (
    <View style={styles.grid}>
      <Pressable style={[styles.btn, styles.half, styles.ghost]} onPress={onReplay}>
        <Text style={[styles.btnText, styles.ghostText]}>PLAY AGAIN</Text>
      </Pressable>
      <Pressable style={[styles.btn, styles.half, styles.ghost]} onPress={onExit}>
        <Text style={[styles.btnText, styles.ghostText]}>OTHER RUGS</Text>
      </Pressable>
    </View>
  );
}

function Stat({ label, value, color = colors.text }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    borderTopWidth: 5,
    padding: 12,
    gap: 6,
  },
  title: { color: colors.text, fontFamily: mono, fontSize: 16, fontWeight: '900' },
  verdict: { fontFamily: mono, fontSize: 24, fontWeight: '900', letterSpacing: 1 },
  note: { color: colors.text, fontFamily: mono, fontSize: 13, lineHeight: 18 },
  noteDim: { color: colors.muted, fontFamily: mono, fontSize: 12, lineHeight: 16 },
  grid: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, backgroundColor: colors.panel, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  statLabel: { color: colors.muted, fontFamily: mono, fontSize: 9, fontWeight: '800' },
  statValue: { fontFamily: mono, fontSize: 13, fontWeight: '900' },
  btn: {
    height: 44,
    borderRadius: 6,
    borderBottomWidth: 5,
    borderBottomColor: colors.greenDark,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghost: { backgroundColor: colors.panel, borderBottomColor: colors.panelEdge },
  half: { flex: 1 },
  ghostText: { color: colors.text },
  btnText: { color: '#0c1118', fontFamily: mono, fontSize: 15, fontWeight: '900', letterSpacing: 1 },
  strip: {
    marginHorizontal: 10,
    marginVertical: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.panel,
    borderRadius: 6,
    borderLeftWidth: 5,
  },
  stripTitle: { color: colors.text, fontFamily: mono, fontSize: 13, fontWeight: '900' },
  stripText: { color: colors.muted, fontFamily: mono, fontSize: 11 },
  stripNote: { color: colors.muted, fontFamily: mono, fontSize: 9, opacity: 0.8 },
});
