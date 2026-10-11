// Home / world-selection verification (data, navigation, protocol, isolation from gameplay).
// The 3D scene itself is checked in a real browser engine by `npm run check:menu`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { decodeMenuMessage, encodeMenuMessage } from '../src/bridge/menuProtocol';
import { INITIAL_SCREEN, navReducer, replayForScreen, Screen } from '../src/app/nav';
import { buildRunResult } from '../src/competition/result';
import { REPLAYS } from '../src/data/replays';
import { ReplayEngine } from '../src/game/ReplayEngine';
import { signalEvent } from '../src/game/verdict';
import { tickIndexAt } from '../src/game/timeline';
import { chartProfile, fmtHistory, menuWorlds, PROFILE_COLUMNS } from '../src/menu/worlds';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) pass++;
  else fail++;
};
const root = join(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const strip = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n== worlds come from the registry ==');
{
  const before = JSON.stringify(REPLAYS.map((r) => r.ticks));
  const worlds = menuWorlds();
  check(worlds.length === REPLAYS.length && worlds.length === 4, 'one world per registered rug (four)');
  check(worlds.every((w, i) => w.id === REPLAYS[i].id && w.symbol === REPLAYS[i].symbol && w.rugType === REPLAYS[i].rugType && w.index === i), 'each world carries the registry id, symbol and rug type, in catalogue order');
  check(['LIBRA', 'BARRON', 'MELANIA', 'HAWK'].every((s) => worlds.some((w) => w.symbol === s)), 'LIBRA, BARRON, MELANIA and HAWK are all worlds');
  check(worlds.every((w) => w.profile.length === PROFILE_COLUMNS && w.steps.length === PROFILE_COLUMNS && w.profile.every((v) => v >= 0 && v <= 1) && Math.min(...w.profile) === 0 && Math.max(...w.profile) === 1), 'each world has a 0..1 miniature chart');
  check(worlds.every((w) => w.steps.every((s) => s === 1 || s === -1)), 'chart steps are +1 / -1');
  check(JSON.stringify(menuWorlds()) === JSON.stringify(worlds), 'worlds are deterministic');
  check(JSON.stringify(REPLAYS.map((r) => r.ticks)) === before, 'building worlds does not alter any replay data');
  for (const r of REPLAYS) {
    const w = worlds.find((x) => x.id === r.id)!;
    const peak = r.ticks.reduce((m, t, i) => (t.price > r.ticks[m].price ? i : m), 0);
    const closes = Math.floor(((Math.floor((peak * PROFILE_COLUMNS) / r.ticks.length) + 1) * r.ticks.length) / PROFILE_COLUMNS);
    void closes;
    check(w.profile.indexOf(1) >= 0 && w.profile[w.profile.length - 1] < 0.9, `[${r.symbol}] the miniature chart shows the real shape (it peaks, then ends well below the peak)`);
  }
  const p = chartProfile([{ price: 1 }, { price: 10 }, { price: 100 }, { price: 10 }], 4);
  check(JSON.stringify(p.profile) === JSON.stringify([0, 0.5, 1, 0.5]) && p.steps.join() === '1,1,1,-1', 'chart profile maths: log scale, 0..1, step direction');
  check(chartProfile([], 5).profile.length === 0, 'an empty history gives an empty chart');
  const m = REPLAYS.find((r) => r.symbol === 'MELANIA')!;
  check(fmtHistory(59040) === '16h 24m' && fmtHistory(125) === '2m 05s' && fmtHistory(9) === '9s', 'history is formatted like "16h 24m"');
  check(/^\d+h \d{2}m$/.test(fmtHistory(m.replayEnd - m.replayStart)), 'a real replay span formats from the registry values');
}

console.log('\n== navigation ==');
{
  let s: Screen = INITIAL_SCREEN;
  check(s.name === 'home' && replayForScreen(s) === null, 'the app starts on home, not in a rug');
  s = navReducer(s, { type: 'OPEN_RUGS' });
  check(s.name === 'rugs', 'PLAY opens world selection');
  const start = navReducer(s, { type: 'START_RUG', replayId: REPLAYS[2].id, difficulty: 'hard' });
  check(start.name === 'play' && start.replayId === REPLAYS[2].id && start.difficulty === 'hard' && replayForScreen(start) === REPLAYS[2], 'starting a world carries the replay and the chosen difficulty');
  const easy = navReducer(s, { type: 'START_RUG', replayId: REPLAYS[0].id });
  check(easy.name === 'play' && easy.difficulty === 'easy', 'difficulty defaults to EASY');
  check(navReducer(s, { type: 'START_RUG', replayId: 'nope', difficulty: 'hard' }).name === 'rugs', 'an unknown world starts nothing');
  check(navReducer(start, { type: 'BACK' }).name === 'rugs' && navReducer(navReducer(start, { type: 'BACK' }), { type: 'BACK' }).name === 'home', 'Android back: game -> worlds -> home');
  for (const tab of ['LEADERBOARD', 'FRIENDS', 'STATS', 'BADGE', 'SKR'] as const) {
    const c = navReducer(INITIAL_SCREEN, { type: 'OPEN_COMPETITION', tab });
    check(c.name === 'competition' && c.tab === tab && navReducer(c, { type: 'BACK' }).name === 'home', `home can open the ${tab} screen directly and back returns home`);
  }
  check((navReducer(INITIAL_SCREEN, { type: 'OPEN_COMPETITION' }) as { tab: string }).tab === 'LEADERBOARD', 'COMPETITION still defaults to the leaderboard');
}

console.log('\n== protocol ==');
{
  const raw = encodeMenuMessage(3, { type: 'SELECT', id: 'x' });
  check(JSON.parse(raw).seq === 3 && JSON.parse(raw).msg.id === 'x', 'host messages are enveloped with a sequence number');
  check(decodeMenuMessage('{"type":"WORLD_TAPPED","id":"a"}')?.type === 'WORLD_TAPPED' && decodeMenuMessage('nope') === null && decodeMenuMessage('{"x":1}') === null, 'scene messages decode; noise is ignored');
}

console.log('\n== gameplay is untouched by the menu ==');
{
  const r = REPLAYS[0];
  const sig = signalEvent(r)!;
  const buyAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.2;
  const sellAt = r.replayStart + (sig.timestamp - r.replayStart) * 0.6;
  const play = (difficulty: 'easy' | 'hard') => {
    const e = new ReplayEngine(r, () => {}, () => 0);
    e.setDifficulty(difficulty); // what the game screen does with the world-selection choice
    e.start();
    const adv = (t: number) => { while (e.getSnapshot().clock.timestamp < t) e.advanceForTest(200); };
    adv(buyAt); e.buy(); adv(sellAt); e.sell(); e.watchWhatHappened();
    for (let g = 0; e.getSnapshot().phase !== 'finished' && g < 1e6; g++) e.advanceForTest(1000);
    const s = e.getSnapshot();
    e.dispose();
    return { s, res: buildRunResult(r, s.player, 'you') };
  };
  const a = play('easy');
  const b = play('hard');
  check(a.s.difficulty === 'easy' && b.s.difficulty === 'hard', 'the chosen difficulty reaches the engine before the replay starts');
  check(!!a.res && JSON.stringify(a.res) === JSON.stringify(b.res), 'EASY and HARD give the identical result, verdict and score for the same run');
  void tickIndexAt;
  const guarded = [...walk(join(root, 'src/game')), ...walk(join(root, 'src/competition')), ...walk(join(root, 'src/chain')), ...walk(join(root, 'src/badge')), ...walk(join(root, 'src/skr')), ...walk(join(root, 'src/upgrade')), ...walk(join(root, 'src/prize'))];
  const leaks = guarded.filter((f) => /menuProtocol|MenuStage|MenuFlow|src\/menu|\.\.\/menu\//.test(strip(readFileSync(f, 'utf8'))));
  check(leaks.length === 0, `no game, scoring, competition, chain, badge, SKR, upgrade or prize code depends on the menu${leaks.length ? ' (' + leaks.join(', ') + ')' : ''}`);
  const scene = strip(readFileSync(join(root, 'webview/src/menu.ts'), 'utf8'));
  check(!/libra|barron|melania|hawk/i.test(scene), 'the menu scene names no specific token: worlds get their look from rug type and registry data');
  check(!/game\/|ReplayEngine|computeVerdict|scoreRun|applyBuy|applySell/.test(scene.replace(/import type[^\n]*\n/g, '')), 'the menu scene has no trading, verdict or scoring code');
  // the village: a sector and a building look for every registry world and every rug type
  const sectors = (scene.match(/const SECTORS = \[([\s\S]*?)\];/)?.[1].match(/\{ x:/g) ?? []).length;
  check(sectors >= REPLAYS.length, `the village has a sector for every registered rug (${sectors} sectors for ${REPLAYS.length} rugs)`);
  const types = new Set(REPLAYS.map((r) => r.rugType));
  check([...types].every((t) => t === 'UNCLASSIFIED' || scene.includes(`type === '${t}'`)), 'every rug type in the registry has its own building in the village');
  check(/function tradeBuilding\(type: string/.test(scene) && /emblemY/.test(scene) && /logoMat/.test(scene), 'each trade building carries a logo emblem (the real logo texture of the replay)');
  check(/hit\.userData\.worldId = w\.id/.test(scene) && /post\(\{ type: 'WORLD_TAPPED'/.test(scene), 'a building is selectable: tapping it reports the registry world id');
  check(/homeProps\.visible = m === 'home'/.test(scene) && /homeOnly\.visible = m === 'home'/.test(scene), 'the wordmark and the foreground props belong to the home view only');
  const ui = walk(join(root, 'src/screens')).concat(walk(join(root, 'src/components'))).filter((f) => /\.tsx$/.test(f));
  const old = ui.filter((f) => /rug replay/i.test(strip(readFileSync(f, 'utf8'))));
  check(old.length === 0, `no screen or component shows "Rug Replay" to the player${old.length ? ' (' + old.join(', ') + ')' : ''}`);
  check(JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo.name === 'Rugrat' && JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')).expo.slug === 'rug-replay', 'the app is named Rugrat; the technical slug is unchanged');
}

console.log(`\nMENU PASS ${pass}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
