// Runs INSIDE the game page (see scripts/stress-scene.mjs). It fires extreme bursts of the same
// messages the app sends, restarts the replay repeatedly, and records anything that could grow:
// scene objects, effect pieces, audio voices, listeners, timers.
import type { HostMessage } from '../src/bridge/protocol';
import { libraReplay as R } from '../src/data/replays/libra';
import { buildTerrain } from '../src/game/terrain';

interface SceneState {
  npcs: number;
  cracks: number;
  fx: number;
  ringsActive: number;
  pops: number;
  sceneChildren: number;
  audio: { voices: number; musicRunning: boolean; context: string; muted: boolean };
}
const terrain = buildTerrain(R.ticks);
const rugIndex = R.ticks.findIndex((t) => t.timestamp >= R.rugTimestamp);
let seq = 0;
const send = (msg: HostMessage) => document.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ seq: seq++, msg }) }));
const state = () => (window as unknown as { __rugState: () => SceneState }).__rugState();
let rng = 12345;
const rnd = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));

// from here on, count anything that could leak
let listenerAdds = 0;
const origAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (this: EventTarget, ...a: Parameters<typeof origAdd>) {
  listenerAdds++;
  return origAdd.apply(this, a);
};
const liveIntervals = new Set<number>();
const origSet = window.setInterval.bind(window);
const origClear = window.clearInterval.bind(window);
window.setInterval = ((f: TimerHandler, ms?: number, ...r: unknown[]) => {
  const id = origSet(f, ms, ...(r as [])) as unknown as number;
  liveIntervals.add(id);
  return id;
}) as typeof window.setInterval;
window.clearInterval = ((id?: number) => {
  if (id !== undefined) liveIntervals.delete(id);
  return origClear(id);
}) as typeof window.clearInterval;

const max = { npcs: 0, cracks: 0, fx: 0, ringsActive: 0, pops: 0, voices: 0 };
const track = () => {
  const s = state();
  max.npcs = Math.max(max.npcs, s.npcs);
  max.cracks = Math.max(max.cracks, s.cracks);
  max.fx = Math.max(max.fx, s.fx);
  max.ringsActive = Math.max(max.ringsActive, s.ringsActive);
  max.pops = Math.max(max.pops, s.pops);
  max.voices = Math.max(max.voices, s.audio.voices);
};

const TAGS = ['DEV', 'INSIDER', 'SMART', 'WHALE', 'LIQUIDITY', null] as const;
const ACTIONS = ['BUY', 'SELL', 'SUPPLY_MOVE', 'LIQUIDITY_REMOVAL'] as const;

function round() {
  send({ type: 'RESET' });
  send({ type: 'START_REPLAY', terrain });
  for (let i = 0; i < terrain.length; i++) {
    send({ type: 'PRICE_TICK', index: i });
    send({ type: 'REPLAY_CLOCK', index: i, frac: 0.5, timestamp: R.ticks[i].timestamp, price: R.ticks[i].price, progress: i / terrain.length, speed: 90 });
    // up to three wallet events at the very same instant: the worst case for "events close together"
    const n = Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const tag = TAGS[Math.floor(rnd() * TAGS.length)];
      const action = ACTIONS[Math.floor(rnd() * ACTIONS.length)];
      const signal = rnd() < 0.06;
      send({ type: 'WALLET_EVENT', id: `s${seq}`, tag, action, amount: 1000, amountUnit: 'USD', priority: signal ? 100 : Math.floor(rnd() * 40), ...(signal ? { signal: true, signalLabel: 'SMART WALLET EXIT' } : {}) });
    }
    if (i === 40) send({ type: 'BUY', index: i });
    if (i === rugIndex || i === 100) send({ type: 'SHOW_RUG' });
    if (i === 120) send({ type: 'SELL', index: i, pnlPct: rnd() * 60 - 30 });
    if (i % 25 === 0) send({ type: 'MARK', kind: rnd() < 0.5 ? 'COLLAPSE' : 'HELD' });
    if (i % 37 === 0) send({ type: 'SET_MUTED', muted: i % 74 === 0 });
    track();
  }
  send({ type: 'SET_MUTED', muted: false });
}

(window as unknown as { __stress: () => Promise<unknown> }).__stress = async () => {
  const rounds: { round: number; npcs: number; sceneChildren: number; fx: number; voices: number; heapMB?: number }[] = [];
  for (let r = 1; r <= 8; r++) {
    round();
    await sleep(500);
    const s = state();
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    rounds.push({ round: r, npcs: s.npcs, sceneChildren: s.sceneChildren, fx: s.fx, voices: s.audio.voices, ...(heap ? { heapMB: +(heap / 1048576).toFixed(1) } : {}) });
  }
  const afterStorm = state();
  // Quiet: every transient effect must expire on its own. The scene animates in ANIMATION time
  // (each frame is capped at 50 ms), so a wall-clock wait gives it only min(1, fps/20) seconds per
  // second: about 0.4 s per second at 8 fps. A late villager's "hiss" (2.5 animation seconds after it
  // arrives) then lands inside the wait and is still on screen when it ends. Advancing animation time
  // explicitly checks the same thing (9 s of animation) independent of the machine's frame rate.
  // The wall-clock wait is kept: the audio voices (Web Audio nodes) end in real time.
  await sleep(9000);
  (window as unknown as { __rugAdvance: (seconds: number) => void }).__rugAdvance(9);
  const quiet = state();
  return { rounds, max, afterStorm, quiet, listenerAdds, liveIntervals: liveIntervals.size, errors };
};
