// App navigation as a tiny pure state machine, so the flow can be tested without rendering anything.
//
//   home -> rugs -> play(replayId) -> rugs ...
//        \-> competition(tab)
//
// The selected replay is carried in the `play` screen and nowhere else. There is no default rug:
// nothing here knows any token by name.
import { getReplay } from '../data/replays';
import type { Difficulty } from '../game/ReplayEngine';
import type { Replay } from '../game/types';

export type CompetitionTab = 'LEADERBOARD' | 'FRIENDS' | 'STATS' | 'BADGE' | 'SKR';

export type Screen =
  | { name: 'home' }
  | { name: 'rugs' }
  | { name: 'play'; replayId: string; difficulty: Difficulty }
  | { name: 'competition'; tab: CompetitionTab };

export type NavAction =
  | { type: 'OPEN_RUGS' }
  | { type: 'OPEN_COMPETITION'; tab?: CompetitionTab }
  | { type: 'SET_TAB'; tab: CompetitionTab }
  | { type: 'START_RUG'; replayId: string; difficulty?: Difficulty }
  | { type: 'FINISH_RUN' }
  | { type: 'BACK' };

export const INITIAL_SCREEN: Screen = { name: 'home' };

export function navReducer(state: Screen, action: NavAction): Screen {
  switch (action.type) {
    case 'OPEN_RUGS':
      return { name: 'rugs' };
    case 'OPEN_COMPETITION':
      return { name: 'competition', tab: action.tab ?? 'LEADERBOARD' };
    case 'SET_TAB':
      return state.name === 'competition' ? { name: 'competition', tab: action.tab } : state;
    case 'START_RUG':
      // an unknown id never starts anything (and never falls back to another rug)
      return getReplay(action.replayId) ? { name: 'play', replayId: action.replayId, difficulty: action.difficulty ?? 'easy' } : state;
    case 'FINISH_RUN':
      return state.name === 'play' ? { name: 'rugs' } : state;
    case 'BACK':
      if (state.name === 'play') return { name: 'rugs' };
      if (state.name === 'rugs' || state.name === 'competition') return { name: 'home' };
      return state;
  }
}

/** The replay for a `play` screen. Null for any other screen: there is no fallback replay. */
export function replayForScreen(screen: Screen): Replay | null {
  return screen.name === 'play' ? (getReplay(screen.replayId) ?? null) : null;
}
