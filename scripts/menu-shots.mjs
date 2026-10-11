// Renders the menu scene in headless Edge and saves screenshots + draw-call stats.
//   node webview/build.mjs && node scripts/menu-shots.mjs [outDir]
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const edge = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const out = resolve(process.argv[2] ?? 'webview/dist/shots');
mkdirSync(out, { recursive: true });
const port = 9378;
const [VW, VH] = (process.env.MENU_VIEWPORT ?? '390x800').split('x').map(Number);

const w = await build({ entryPoints: ['src/menu/worlds.ts'], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'error' });
const tmp = mkdtempSync(join(tmpdir(), 'menu-'));
writeFileSync(join(tmp, 'worlds.cjs'), w.outputFiles[0].text);
const { menuWorlds } = await import(pathToFileURL(join(tmp, 'worlds.cjs')).href);
const worlds = menuWorlds();
const page = join(tmp, 'menu.html');
writeFileSync(page, readFileSync('webview/dist/menu.html', 'utf8'));

const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(tmp, 'profile')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${VW},${VH}`, 'about:blank'], { stdio: 'ignore' });
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
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await call('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const settle = (n = 40) => ev(`(()=>{for(let i=0;i<${n};i++)window.__menu.render();return window.__menu.info()})()`);

await call('Page.enable');
await call('Runtime.enable');
const errors = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error ' + JSON.stringify(d.params.args).slice(0, 200));
});
await call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__posts=[];window.ReactNativeWebView={postMessage:(m)=>window.__posts.push(m)};' });
await call('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: true });
await call('Page.navigate', { url: pathToFileURL(page).href });
await sleep(2500);
const send = (m) => ev(`window.__menu.send(${JSON.stringify(m)})`);
await send({ type: 'INIT', worlds, mode: 'home' });
// the real logos, as the app would send them (data URIs)
const reg = await build({ entryPoints: ['src/data/replays/index.ts'], bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'error' });
writeFileSync(join(tmp, 'reg.cjs'), reg.outputFiles[0].text);
const { REPLAYS } = await import(pathToFileURL(join(tmp, 'reg.cjs')).href);
for (const r of REPLAYS) {
  try {
    const res = await fetch(r.logoUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    const type = res.headers.get('content-type') ?? 'image/png';
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    await send({ type: 'LOGO', id: r.id, dataUri: `data:${type};base64,${data}` });
    console.log('logo ok', r.symbol);
  } catch (e) {
    console.log('logo failed (fallback letters used)', r.symbol, String(e.message));
  }
}
let info = await settle(30);
await shot('home');
console.log('home', JSON.stringify(info));
const budgets = [];
const budget = (name, i, calls, tris) => budgets.push([name, i.calls <= calls && i.triangles <= tris, i]);
budget('home', info, 90, 90000);
await send({ type: 'MODE', mode: 'worlds' });
info = await settle(40);
await shot('worlds');
console.log('worlds', JSON.stringify(info));
budget('worlds', info, 90, 90000);
// input: a tap on the first world, and a swipe
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const spot = await ev(`window.__menu.screenOf(${JSON.stringify(worlds[0].id)})`);
console.log('first building on screen at', JSON.stringify(spot));
await mouse('mousePressed', spot.x, spot.y);
await mouse('mouseReleased', spot.x, spot.y);
await mouse('mousePressed', 300, 420);
await mouse('mouseMoved', 200, 420);
await mouse('mouseReleased', 130, 420);
const posts = (await ev('window.__posts')).map((p) => JSON.parse(p));
const tapped = posts.find((p) => p.type === 'WORLD_TAPPED');
const swiped = posts.find((p) => p.type === 'SWIPE');
console.log('input', JSON.stringify({ tapped, swiped }));
const inputOk = tapped?.id === worlds[0].id && swiped?.dir === 1;
for (let i = 0; i < worlds.length; i++) {
  await send({ type: 'SELECT', id: worlds[i].id });
  info = await settle(60);
  await shot(`selected-${worlds[i].symbol}`);
  console.log('selected', worlds[i].symbol, JSON.stringify(info));
}
await send({ type: 'ENTER', id: worlds[1].id });
await settle(25);
await shot('enter');
ws.close();
proc.kill();
let bad = false;
for (const [name, ok, i] of budgets) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} draw budget (${i.calls} calls, ${i.triangles} triangles)`);
  if (!ok) bad = true;
}
console.log(`${inputOk ? 'PASS' : 'FAIL'}  tapping a world selects it and swiping cycles worlds`);
console.log(`${errors.length === 0 ? 'PASS' : 'FAIL'}  no script errors in the menu scene (${errors.length})`);
if (errors.length) console.log(errors);
console.log('shots in', out);
process.exit(bad || !inputOk || errors.length ? 1 : 0);
