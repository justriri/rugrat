import { StatusBar } from 'expo-status-bar';
import { useEffect, useReducer } from 'react';
import { BackHandler, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { INITIAL_SCREEN, navReducer, replayForScreen } from './src/app/nav';
import { ChainProvider } from './src/chain/ChainContext';
import { SkrProvider } from './src/skr/SkrContext';
import { CompetitionProvider } from './src/competition/CompetitionContext';
import { CompetitionScreen } from './src/screens/CompetitionScreen';
import { GameScreen } from './src/screens/GameScreen';
import { MenuFlow } from './src/screens/MenuFlow';
import { colors } from './src/theme';

export default function App() {
  const [screen, dispatch] = useReducer(navReducer, INITIAL_SCREEN);

  // Android back: step back through the app instead of leaving it, until the home screen
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'home') return false;
      dispatch({ type: 'BACK' });
      return true;
    });
    return () => sub.remove();
  }, [screen.name]);

  const replay = replayForScreen(screen);

  return (
    <SafeAreaProvider>
      <CompetitionProvider>
        <ChainProvider>
          <SkrProvider>
            <StatusBar style="light" />
            {(screen.name === 'home' || screen.name === 'rugs') && (
              <MenuFlow
                screen={screen.name}
                onPlay={() => dispatch({ type: 'OPEN_RUGS' })}
                onCompetition={(tab) => dispatch({ type: 'OPEN_COMPETITION', tab })}
                onStart={(replayId, difficulty) => dispatch({ type: 'START_RUG', replayId, difficulty })}
                onBack={() => dispatch({ type: 'BACK' })}
              />
            )}
            {screen.name === 'competition' && <CompetitionScreen tab={screen.tab} onTab={(tab) => dispatch({ type: 'SET_TAB', tab })} onBack={() => dispatch({ type: 'BACK' })} />}
            {screen.name === 'play' && replay && <GameScreen key={replay.id} replay={replay} difficulty={screen.difficulty} onExit={() => dispatch({ type: 'FINISH_RUN' })} />}
            {screen.name === 'play' && !replay && (
              <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: colors.text }}>That rug is not in the catalogue.</Text>
              </View>
            )}
          </SkrProvider>
        </ChainProvider>
      </CompetitionProvider>
    </SafeAreaProvider>
  );
}
