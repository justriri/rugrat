import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GameWebView } from '../bridge/GameWebView';
import { Controls } from '../components/Controls';
import { CornerBar } from '../components/CornerBar';
import { DebugPanel } from '../components/DebugPanel';
import { Hud } from '../components/Hud';
import { RecordScorePanel } from '../components/RecordScorePanel';
import { ResultSheet, ResultStrip } from '../components/ResultSheet';
import { WalletFeed } from '../components/WalletFeed';
import { useSkr } from '../skr/SkrContext';
import { useCompetition } from '../competition/CompetitionContext';
import { buildRunResult, LOCAL_PLAYER_ID } from '../competition/result';
import { startTimestamp } from '../game/timeline';
import type { Difficulty } from '../game/ReplayEngine';
import type { Replay } from '../game/types';
import { useReplayGame } from '../game/useReplayGame';
import { colors } from '../theme';

/**
 * Development readout of the replay clock; tap it to cycle the playback multiplier. Development
 * builds only: players never see it and cannot change the playback speed. (__DEV__ is false in
 * every release / EAS build.)
 */
const SHOW_DEBUG_PANEL = __DEV__;

/**
 * One run of ONE replay. The replay is a prop and is the single source of truth for the whole run
 * (clock, terrain, price, wallet events, signal, collapse, name, logo): there is no default and
 * no fallback. App mounts this with `key={replay.id}`, so choosing another rug starts a fresh run.
 */
export function GameScreen({ replay, onExit, difficulty = 'easy' }: { replay: Replay; onExit: () => void; difficulty?: Difficulty }) {
  const insets = useSafeAreaInsets();
  const game = useReplayGame(replay);
  const [muted, setMuted] = useState(false);
  // the difficulty chosen on the world-selection screen (set once, before the replay starts)
  useEffect(() => {
    game.setDifficulty(difficulty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { addRun } = useCompetition();
  const { perks } = useSkr();

  // presentation only: tell the scene whether to make sound
  useEffect(() => {
    game.bridge.current?.send({ type: 'SET_MUTED', muted });
  }, [muted, game.bridge]);

  // SKR holder cosmetics: look only. Re-sent when the scene becomes ready and whenever the perks change.
  const cosmetics = useMemo(() => ({ characterSkin: perks.characterSkin ? ('SKR' as const) : ('DEFAULT' as const), arena: perks.arena ? ('SKR' as const) : ('DEFAULT' as const) }), [perks.characterSkin, perks.arena]);
  const sendCosmetics = () => game.bridge.current?.send({ type: 'SET_COSMETICS', ...cosmetics });
  useEffect(() => {
    game.bridge.current?.send({ type: 'SET_COSMETICS', ...cosmetics });
  }, [cosmetics, game.bridge]);
  const onWebMessage: typeof game.onWebMessage = (m) => {
    game.onWebMessage(m);
    if (m.type === 'READY') sendCosmetics();
  };

  // The run's result is recorded the moment it is decided: when the player sells (the verdict
  // depends only on that exit), or when the replay ends with them still in. Watching on or
  // skipping the rest changes nothing. The result id is deterministic, so it is recorded once.
  const result = useMemo(() => buildRunResult(replay, game.state.player, LOCAL_PLAYER_ID), [replay, game.state.player]);
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    const phase = game.state.phase;
    const decided = phase === 'exited' || phase === 'finished' || phase === 'revealing' || phase === 'revealed';
    // a run whose speed was altered (development tooling) is never recorded for competition
    if (decided && result && game.state.fairRun && recorded.current !== result.runId) {
      recorded.current = result.runId;
      addRun(result);
    }
  }, [game.state.phase, game.state.fairRun, result, addRun]);

  const speeds = [0.5, 1, 2, 4].map((m) => replay.playbackSpeed * m);
  const cycleSpeed = () => {
    const i = speeds.indexOf(game.state.speed);
    game.setSpeed(speeds[(i + 1) % speeds.length]);
  };
  // the skill score is shown once the run has ended (it would give the verdict away earlier)
  const showScore = game.state.phase === 'finished' || game.state.phase === 'revealing' || game.state.phase === 'revealed';

  return (
    <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.game}>
        <GameWebView bridgeRef={game.bridge} onMessage={onWebMessage} />
        <Hud replay={replay} state={game.state} />
        <CornerBar muted={muted} onToggleMute={() => setMuted((m) => !m)} onExit={onExit} />
        {SHOW_DEBUG_PANEL && (
          <DebugPanel
            replay={replay}
            state={game.state}
            onCycleSpeed={cycleSpeed}
          />
        )}
      </View>
      <View style={styles.bottom}>
        {game.state.phase === 'watching' || game.state.phase === 'revealing' ? (
          <ResultStrip state={game.state} startTimestamp={startTimestamp(replay)} />
        ) : (
          <Controls state={game.state} onBuy={game.buy} onSell={game.sell} />
        )}
        <WalletFeed items={game.state.feed} startTs={startTimestamp(replay)} tagsVisible={game.state.tagsVisible} />
        <ResultSheet
          state={game.state}
          startTimestamp={startTimestamp(replay)}
          score={showScore && result ? result.score : null}
          extra={result && game.state.fairRun ? <RecordScorePanel run={result} /> : null}
          onReplay={game.reset}
          onSell={game.sell}
          onWatch={game.watch}
          onReveal={game.reveal}
          onExit={onExit}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  game: { flex: 1.25 },
  bottom: { flex: 1 },
});
