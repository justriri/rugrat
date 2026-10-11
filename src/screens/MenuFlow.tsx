import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import type { CompetitionTab } from '../app/nav';
import { MenuStage, MenuStageApi } from '../components/MenuStage';
import { REPLAYS } from '../data/replays';
import type { Difficulty } from '../game/ReplayEngine';
import { HomeScreen } from './HomeScreen';
import { RugSelectScreen } from './RugSelectScreen';

/**
 * Home and world selection share ONE 3D scene, so PLAY is a camera move over the same world.
 * The selection lives here; the chosen world and difficulty are handed to the game by `onStart`.
 */
export function MenuFlow({ screen, onPlay, onCompetition, onStart, onBack }: { screen: 'home' | 'rugs'; onPlay: () => void; onCompetition: (tab: CompetitionTab) => void; onStart: (replayId: string, difficulty: Difficulty) => void; onBack: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stage = useRef<MenuStageApi>(null);

  // leaving the selection screen forgets the selection
  useEffect(() => {
    if (screen === 'home') setSelectedId(null);
  }, [screen]);

  const swipe = useCallback(
    (dir: 1 | -1) => {
      setSelectedId((cur) => {
        const i = cur ? REPLAYS.findIndex((r) => r.id === cur) : -1;
        const n = REPLAYS.length;
        return REPLAYS[i < 0 ? (dir > 0 ? 0 : n - 1) : (i + dir + n) % n].id;
      });
    },
    [],
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#8fd6ff' }}>
      <MenuStage mode={screen === 'home' ? 'home' : 'worlds'} selectedId={selectedId} stageRef={stage} onTapWorld={(id) => screen === 'rugs' && setSelectedId(id)} onSwipe={screen === 'rugs' ? swipe : undefined} />
      {screen === 'home' ? (
        <HomeScreen onPlay={onPlay} onCompetition={onCompetition} />
      ) : (
        <RugSelectScreen selectedId={selectedId} onSelect={setSelectedId} onEnter={(id) => stage.current?.enter(id)} onStart={onStart} onBack={onBack} />
      )}
    </View>
  );
}
