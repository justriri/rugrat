// Scene stress test: bursts of simultaneous events, repeated restarts, and a quiet period, in a real
// browser engine (Edge/Chrome headless). Fails if anything accumulates or throws.
//   npm run build:webview && npm run stress:scene        (EDGE_PATH overrides the browser location)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const edge = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9377;
const bundle = await build({ entryPoints: ['scripts/stress-harness.ts'], bundle: true, format: 'iife', write: false, logLevel: 'error' });
const game = readFileSync('webview/dist/game.html', 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'stress-'));
const page = join(dir, 'stress.html');
writeFileSync(page, game.replace('</body>', () => `<script>${bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></body>`));

const proc = spawn(
  edge,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'profile')}`, '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=390,420', 'about:blank'],
  { stdio: 'ignore' },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.find((t) => t.type === 'page')) break;
  } catch {}
  await sleep(500);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d.result ?? d.error);
    pending.delete(d.id);
  }
};
const call = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
await call('Page.enable');
await call('Page.navigate', { url: pathToFileURL(page).href });
await sleep(2500);
const res = await call('Runtime.evaluate', { expression: 'window.__stress()', awaitPromise: true, returnByValue: true, timeout: 120000 });
ws.close();
proc.kill();
if (!res.result || res.exceptionDetails) {
  console.log('FAIL  stress run threw', JSON.stringify(res).slice(0, 400));
  process.exit(1);
}
const r = res.result.value;

let failed = 0;
let passed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (ok) passed++;
  else failed++;
};
console.log('rounds:', r.rounds.map((x) => `#${x.round}: children ${x.sceneChildren}, npcs ${x.npcs}, voices ${x.voices}${x.heapMB ? `, heap ${x.heapMB}MB` : ''}`).join(' | '));
console.log('peaks :', JSON.stringify(r.max), '| audio context:', r.afterStorm.audio.context);
console.log('after storm:', JSON.stringify({ fx: r.afterStorm.fx, ringsActive: r.afterStorm.ringsActive, pops: r.afterStorm.pops }), '| after 9 animation seconds:', JSON.stringify({ fx: r.quiet.fx, ringsActive: r.quiet.ringsActive, pops: r.quiet.pops }));
check(r.errors.length === 0, `no script errors under the event storm (${r.errors.length})`);
check(r.max.fx <= 40 && r.max.ringsActive <= 4 && r.max.pops <= 12, `effect pieces stay inside their pools (sparks <= 40: ${r.max.fx}, rings <= 4: ${r.max.ringsActive}, pops <= 12: ${r.max.pops})`);
check(r.max.npcs <= 12 && r.max.cracks <= 60, `characters and cracks stay capped (npcs ${r.max.npcs}/12, cracks ${r.max.cracks}/60)`);
check(r.max.voices <= 48, `audio voices stay under the cap (${r.max.voices}/48)`);
check(r.rounds[r.rounds.length - 1].sceneChildren - r.rounds[0].sceneChildren <= 3, `scene object count does not grow across 8 restarts (${r.rounds[0].sceneChildren} -> ${r.rounds[r.rounds.length - 1].sceneChildren})`);
check(r.listenerAdds === 0, `no event listeners are added while events happen (${r.listenerAdds})`);
check(r.liveIntervals <= 1, `at most the one music timer is running (${r.liveIntervals})`);
check(r.quiet.fx === 0 && r.quiet.ringsActive === 0 && r.quiet.pops === 0, 'every transient effect expires on its own after the storm (9 s of animation time)');
check(r.quiet.audio.voices <= 20, `audio voices drain back down (${r.quiet.audio.voices})`);
if (r.afterStorm.audio.context !== 'running') console.log(`NOTE  audio context was "${r.afterStorm.audio.context}" here, so voice recycling could not be fully exercised`);
console.log(`STRESS PASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
