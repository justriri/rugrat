import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { GameBridge } from '../bridge/GameWebView';
import type { WebMessage } from '../bridge/protocol';
import { Difficulty, ReplayEngine } from './ReplayEngine';
import type { Replay } from './types';

/** Wires a ReplayEngine to the WebView bridge and exposes its state to React. */
export function useReplayGame(replay: Replay) {
  const bridge = useRef<GameBridge>(null);
  const sceneReady = useRef(false);

  const engine = useMemo(
    () => new ReplayEngine(replay, (msg) => bridge.current?.send(msg)),
    [replay],
  );
  useEffect(() => () => engine.dispose(), [engine]);
  // Selecting another replay creates a new engine; if the scene is already up, start it right away.
  useEffect(() => {
    if (sceneReady.current) engine.start();
  }, [engine]);

  const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  const onWebMessage = useCallback(
    (msg: WebMessage) => {
      if (msg.type === 'READY') {
        sceneReady.current = true;
        engine.start();
      }
      else if (msg.type === 'PLAYER_TAPPED' || msg.type === 'STALL_TAPPED') engine.sell();
      else if (msg.type === 'ERROR') console.warn('[scene]', msg.message);
    },
    [engine],
  );

  return {
    state,
    bridge,
    onWebMessage,
    buy: () => engine.buy(),
    sell: () => engine.sell(),
    reset: () => engine.reset(),
    setDifficulty: (d: Difficulty) => engine.setDifficulty(d),
    watch: () => engine.watchWhatHappened(),
    reveal: () => engine.startReveal(),
    setSpeed: (speed: number) => engine.setSpeed(speed),
  };
}
