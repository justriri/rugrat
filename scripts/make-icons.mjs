// Renders the Rugrat icon, adaptive-icon foreground and splash image from assets/rugrat.svg using
// headless Edge/Chrome (no extra dependencies).   node scripts/make-icons.mjs   (EDGE_PATH overrides)
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const edge = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const svg = readFileSync('assets/rugrat.svg', 'utf8');
const group = svg.match(/<g id="rugrat">([\s\S]*?)<\/g>/)[1];
const SIZE = 1024;
const wrap = (inner, size = SIZE) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" shape-rendering="crispEdges">${inner}</svg>`;
const bg = svg.replace(/^[\s\S]*?<\/defs>/, '').replace(/<\/svg>\s*$/, '').replace('<use href="#rugrat"/>', `<g>${group}</g>`);
const variants = {
  // full-bleed launcher icon (opaque)
  'assets/icon.png': { transparent: false, svg: wrap(bg) },
  // the wallet-connect identity icon (shown by the wallet app), same artwork, hosted with the badge site
  'badge/site/rugrat.png': { transparent: false, size: 512, svg: wrap(bg, 512) },
  // adaptive foreground: transparent, art inside the central 66% safe zone
  'assets/adaptive-icon.png': { transparent: true, svg: wrap(`<g transform="translate(8 8) scale(0.6) translate(-8 -8)">${group}</g>`) },
  // splash: the character only, on transparent (the splash colour is configured in app.json)
  'assets/splash-icon.png': { transparent: true, svg: wrap(`<g transform="translate(8 8) scale(0.92) translate(-8 -8)">${group}</g>`) },
};

const dir = mkdtempSync(join(tmpdir(), 'icons-'));
const port = 9379;
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, 'p')}`, '--hide-scrollbars', `--window-size=${SIZE},${SIZE}`, 'about:blank'], { stdio: 'ignore' });
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
  if (d.id && pending.has(d.id)) pending.get(d.id)(d.result ?? d.error);
};
const call = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: SIZE, height: SIZE, deviceScaleFactor: 1, mobile: false });
for (const [file, v] of Object.entries(variants)) {
  const page = join(dir, 'p.html');
  writeFileSync(page, `<!doctype html><html><body style="margin:0;background:transparent">${v.svg}</body></html>`);
  await call('Emulation.setDefaultBackgroundColorOverride', v.transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : { color: { r: 255, g: 255, b: 255, a: 1 } });
  const size = v.size ?? SIZE;
  await call('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: pathToFileURL(page).href });
  await sleep(600);
  const r = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('wrote', file);
}
ws.close();
proc.kill();
