// Three.js voxel scene. Runs inside the WebView; bundled to a single inline script by
// webview/build.mjs. It renders whatever terrain the host sends and never invents any.
import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Object3D,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { HostEnvelope, HostMessage, WebMessage } from '../../src/bridge/protocol';
import { createAudio } from './audio';
import type { Direction, TerrainColumn, WalletAction, WalletTag } from '../../src/game/types';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
  }
}

// ---------------------------------------------------------------- constants
/** z of each lane of the terrain ribbon. The player runs on the front lane (+1). */
const LANE_Z = [-2, -1, 0, 1];
const PLAYER_Z = 1;
const PRELUDE = 8; // flat run-up before tick 0 so the player starts on solid ground
const MIN_VIEW_COLS = 24; // columns visible across the screen when the chart is calm
const MAX_VIEW_COLS = 46;
const FRAME_LOOKBACK = 16; // recent columns the camera tries to keep in frame
const PLAYER_SCREEN_X = 0.66; // player sits right of centre: history behind, unknown ahead

const COLORS = {
  up: new Color('#4fd35f'),
  down: new Color('#e5483f'),
  flat: new Color('#c9c24e'),
  prelude: new Color('#6fb85a'),
  dirt: new Color('#8a5a2e'),
  stone: new Color('#8a8691'),
  grid: new Color('#d8b24a'),
  sky: new Color('#8fd6ff'),
  rugSky: new Color('#5a2a3a'),
};

// ---------------------------------------------------------------- bridge
let lastSeq = -1;

function post(msg: WebMessage) {
  window.ReactNativeWebView?.postMessage(JSON.stringify(msg));
}

function onRawMessage(event: Event) {
  const data = (event as MessageEvent).data;
  if (typeof data !== 'string') return;
  let env: HostEnvelope;
  try {
    env = JSON.parse(data) as HostEnvelope;
  } catch {
    return;
  }
  if (typeof env.seq !== 'number' || env.seq <= lastSeq) return; // android+ios double delivery
  lastSeq = env.seq;
  handle(env.msg);
}
document.addEventListener('message', onRawMessage);
window.addEventListener('message', onRawMessage);
window.addEventListener('error', (e) => post({ type: 'ERROR', message: String(e.message) }));

// ---------------------------------------------------------------- scene
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
renderer.setPixelRatio(pixelRatio);
// Android WebView can drop the GL context when the app is backgrounded; let three restore it.
canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

const scene = new Scene();
scene.background = COLORS.sky.clone();
scene.fog = new Fog(COLORS.sky.clone(), 40, 90);

scene.add(new HemisphereLight(0xffffff, 0x6b7a5a, 1.1));
scene.add(new AmbientLight(0xffffff, 0.25));
const sun = new DirectionalLight(0xfff2d6, 1.5);
sun.position.set(-8, 20, 14);
scene.add(sun);

const camera = new PerspectiveCamera(45, 1, 0.5, 200);
let viewDist = 30;
let viewCols = MIN_VIEW_COLS;

const unitBox = new BoxGeometry(1, 1, 1);
const lambert = new MeshLambertMaterial({ color: 0xffffff });

// ---------------------------------------------------------------- world state
interface World {
  terrain: TerrainColumn[];
  /** Prelude columns first, then one column per tick. */
  cols: { x: number; level: number }[];
  blocks: InstancedMesh;
  /** blockPrefix[c] = number of block instances up to and including column c. */
  blockPrefix: number[];
}

let world: World | null = null;
const worldGroup = new Group();
scene.add(worldGroup);

let revealed = 0; // fractional number of block instances currently shown
let curCol = 0; // array index (including prelude) of the newest column
let revealedCols = 0; // columns completely revealed

function hash(a: number, b: number): number {
  let h = Math.imul(a + 374761393, 668265263) ^ Math.imul(b + 1274126177, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function jitter(c: Color, a: number, b: number): Color {
  const k = 0.93 + hash(a, b) * 0.12;
  return c.clone().multiplyScalar(k);
}

function buildWorld(terrain: TerrainColumn[]): World {
  const first = terrain[0];
  const cols: { x: number; level: number; dir: Direction | 'prelude' }[] = [];
  for (let i = -PRELUDE; i < 0; i++) cols.push({ x: i, level: first.level, dir: 'prelude' });
  for (const t of terrain) cols.push({ x: t.index, level: t.level, dir: t.dir });

  // --- terrain blocks (solid down to the ground so the chart reads as a landmass)
  const m = new Matrix4();
  const blockMatrices: Matrix4[] = [];
  const blockColors: Color[] = [];
  const blockPrefix: number[] = [];
  cols.forEach((col, ci) => {
    const left = cols[Math.max(0, ci - 1)].level;
    const right = cols[Math.min(cols.length - 1, ci + 1)].level;
    for (let y = 0; y < col.level; y++) {
      LANE_Z.forEach((z, lane) => {
        // Only the front lane is seen from the side at full height; the other lanes just
        // need their top layer and any cliff face exposed by a lower neighbour.
        const depth = col.level - 1 - y;
        const exposed = y >= Math.min(left, right);
        if (lane !== LANE_Z.length - 1 && depth > 1 && !exposed) return;
        m.makeTranslation(col.x, y + 0.5, z);
        blockMatrices.push(m.clone());
        const base =
          depth === 0
            ? col.dir === 'prelude'
              ? COLORS.prelude
              : COLORS[col.dir]
            : depth <= 2
              ? COLORS.dirt
              : COLORS.stone;
        let color = jitter(base, col.x * 31 + y, lane);
        if (base === COLORS.stone) {
          // Deep wall: darker toward the bedrock, banded every 4 rows, with a gold price-grid
          // row every 10 levels so the height of a cliff can be read at a glance.
          const shade = 0.55 + 0.45 * Math.min(1, y / 40);
          color.multiplyScalar(shade * ((y >> 2) % 2 === 0 ? 0.9 : 1));
          if (y % 10 === 0 && y > 0) color.lerp(COLORS.grid, 0.55);
        }
        blockColors.push(color);
      });
    }
    blockPrefix.push(blockMatrices.length);
  });

  const blocks = new InstancedMesh(unitBox, lambert, blockMatrices.length);
  blockMatrices.forEach((mat, i) => {
    blocks.setMatrixAt(i, mat);
    blocks.setColorAt(i, blockColors[i]);
  });
  blocks.count = 0;
  blocks.frustumCulled = false;

  worldGroup.add(blocks);
  return {
    terrain,
    cols: cols.map(({ x, level }) => ({ x, level })),
    blocks,
    blockPrefix,
  };
}

function disposeWorld() {
  if (!world) return;
  for (const mesh of [world.blocks]) {
    worldGroup.remove(mesh);
    mesh.dispose();
  }
  world = null;
}

// ---------------------------------------------------------------- player
const player = new Group();
const skin = new MeshLambertMaterial({ color: '#f2c9a0' });
const shirt = new MeshLambertMaterial({ color: '#f08a24' });
const pants = new MeshLambertMaterial({ color: '#3b5ba9' });

function part(w: number, h: number, d: number, mat: MeshLambertMaterial, x: number, y: number, z = 0) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  player.add(mesh);
  return mesh;
}
part(0.28, 0.55, 0.3, pants, -0.17, 0.275);
part(0.28, 0.55, 0.3, pants, 0.17, 0.275);
part(0.7, 0.7, 0.4, shirt, 0, 0.9);
const head = part(0.5, 0.5, 0.5, skin, 0, 1.5);
const armL = part(0.2, 0.6, 0.25, skin, -0.46, 0.95);
const armR = part(0.2, 0.6, 0.25, skin, 0.46, 0.95);
// Buying puts a stack of gold blocks on the character's chest; selling takes it away.
const chestStack = new Group();
{
  const gold = new MeshLambertMaterial({ color: '#f7c53b', emissive: '#7a5600' });
  for (let i = 0; i < 3; i++) {
    const bar = new Mesh(unitBox, gold);
    bar.scale.set(0.5, 0.17, 0.14);
    bar.position.set(0, 0.74 + i * 0.19, 0.27);
    chestStack.add(bar);
  }
}
chestStack.visible = false;
player.add(chestStack);
// SKR holder skin: purple and green, with a headband. Cosmetic only.
const skrBand = new Mesh(new BoxGeometry(0.56, 0.12, 0.56), new MeshLambertMaterial({ color: '#14f195', emissive: '#0a6b43' }));
skrBand.position.set(0, 1.62, 0);
skrBand.visible = false;
player.add(skrBand);
player.scale.setScalar(1.15);
scene.add(player);

// SKR holder arena: a twilight sky with stars. The terrain and its colours are untouched.
const stars = new Points(
  (() => {
    const g = new BufferGeometry();
    const p: number[] = [];
    for (let i = 0; i < 90; i++) p.push((hash(i, 3) - 0.5) * 90, 4 + hash(i, 4) * 26, -34 - hash(i, 6) * 6);
    g.setAttribute('position', new Float32BufferAttribute(p, 3));
    return g;
  })(),
  new PointsMaterial({ color: '#ffffff', size: 0.5, fog: false }),
);
stars.visible = false;
scene.add(stars);
const SKY_DEFAULT = '#8fd6ff';
const SKY_SKR = '#2a2160';
function applyCosmetics(characterSkin: 'DEFAULT' | 'SKR', arena: 'DEFAULT' | 'SKR') {
  const skr = characterSkin === 'SKR';
  shirt.color.set(skr ? '#9945ff' : '#f08a24');
  pants.color.set(skr ? '#23233a' : '#3b5ba9');
  skrBand.visible = skr;
  COLORS.sky.set(arena === 'SKR' ? SKY_SKR : SKY_DEFAULT);
  stars.visible = arena === 'SKR';
}

// ---------------------------------------------------------------- markers
/** Marks a geometry/material as created per event, so it is disposed when its object is released. */
function own<T extends { userData: Record<string, unknown> }>(r: T): T {
  r.userData.owned = true;
  return r;
}
function disposeOwned(o: Object3D) {
  o.traverse((c) => {
    const m = c as Mesh;
    if (!m.isMesh) return;
    if (m.geometry && m.geometry.userData.owned) m.geometry.dispose();
    const mat = m.material as MeshBasicMaterial;
    if (mat && mat.userData && mat.userData.owned) {
      mat.map?.dispose();
      mat.dispose();
    }
  });
}
function releaseFlag(f: Object3D) {
  scene.remove(f);
  disposeOwned(f);
}

/** A small flat sign with text, drawn once on a canvas. */
function makeLabel(lines: { text: string; size: number; color: string }[], w: number, h: number, bg: string, border: string): Mesh {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = Math.round((256 * h) / w);
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = border;
  g.lineWidth = 8;
  g.strokeRect(4, 4, c.width - 8, c.height - 8);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  lines.forEach((l, i) => {
    g.fillStyle = l.color;
    g.font = `bold ${l.size}px monospace`;
    g.fillText(l.text, c.width / 2, (c.height * (i + 1)) / (lines.length + 1));
  });
  return new Mesh(own(new PlaneGeometry(w, h)), own(new MeshBasicMaterial({ map: new CanvasTexture(c) })));
}

function flag(color: string, label?: string): Group {
  const g = new Group();
  const pole = new Mesh(own(new BoxGeometry(0.12, 2.2, 0.12)), own(new MeshLambertMaterial({ color: '#d9d9d9' })));
  pole.position.y = 1.1;
  const cloth = new Mesh(own(new BoxGeometry(0.9, 0.55, 0.08)), own(new MeshLambertMaterial({ color })));
  cloth.position.set(0.5, 1.9, 0);
  g.add(pole, cloth);
  if (label) {
    const size = Math.min(52, Math.floor(226 / (label.length * 0.62)));
    const sign = makeLabel([{ text: label, size, color: '#ffffff' }], 2.3, 0.6, color, '#ffffff');
    sign.position.set(0.7, 2.7, 0.08);
    g.add(sign);
  }
  return g;
}
const markFlags: Group[] = [];
let buyFlag: Group | null = null;
let sellFlag: Group | null = null;

// ---------------------------------------------------------------- price cursor
const cursor = new Mesh(
  new BoxGeometry(1.04, 0.14, LANE_Z.length + 0.04),
  new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 }),
);
cursor.visible = false;
scene.add(cursor);

// ---------------------------------------------------------------- clouds
const clouds = new Group();
const cloudMat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9 });
const cloudSeeds: { x: number; y: number; z: number }[] = [];
for (let i = 0; i < 9; i++) {
  const g = new Group();
  const n = 3 + Math.floor(hash(i, 3) * 3);
  for (let k = 0; k < n; k++) {
    const b = new Mesh(new BoxGeometry(2.5 + hash(i, k) * 2, 1.2, 2.5), cloudMat);
    b.position.set(k * 2.4, hash(k, i) * 0.8, 0);
    g.add(b);
  }
  clouds.add(g);
  cloudSeeds.push({ x: i * 14, y: 10 + hash(i, 9) * 8, z: -30 - hash(i, 5) * 10 });
}
scene.add(clouds);

// ---------------------------------------------------------------- dynamic state
let holding = false;
let sold = false;
let rug = false;
let rugT = 0;
let shake = 0;
// Last replay clock state received from the host. The scene renders this; it owns no timeline.
const clockState = { index: -1, frac: 0.5, timestamp: 0, price: 0, progress: 0, speed: 0 };
let hopT = 1;
let jumpT = 1; // victory jump after selling
let time = 0;

const playerPos = new Vector3(0, 0, PLAYER_Z);
const hopFrom = new Vector3();
const camPos = new Vector3();
const destPos = new Vector3();
const skyColor = new Color();
let camReady = false;

function snapPlayerTo(colIdx: number) {
  if (!world) return;
  playerPos.set(world.cols[colIdx].x, world.cols[colIdx].level, PLAYER_Z);
  hopFrom.copy(playerPos);
  hopT = 1;
}

function setCursor(colIdx: number) {
  if (!world) return;
  const col = world.cols[colIdx];
  const t = world.terrain[colIdx - PRELUDE];
  const color = t && t.dir === 'down' ? '#ffb3ac' : t && t.dir === 'up' ? '#b6ffc0' : '#ffffff';
  (cursor.material as MeshBasicMaterial).color.set(color);
  cursor.position.set(col.x, col.level + 0.08, (LANE_Z[0] + LANE_Z[LANE_Z.length - 1]) / 2);
  cursor.visible = true;
}


// ---------------------------------------------------------------- market stall + wallet NPCs
// The stall is a fixed MARKET in the world: it stands on one terrain column and does not move with
// the player. Only when the chart has scrolled it almost out of view does it get pitched again, a few
// columns behind the player, so there is always a place to sell on screen. NPCs appear ONLY when
// the host sends WALLET_EVENT (the replay clock reached the event); their motion is cosmetic.
const STALL_BACK = 4;
const STALL_MARGIN = 2.5; // pitch again when the stall is this close to the left edge of the view
const MAX_NPCS = 12;
const NPC_LIFE = 9; // seconds on screen after arriving (cosmetic)

const stall = new Group();
const stallCoin = new Mesh(unitBox, new MeshLambertMaterial({ color: '#f7c53b', emissive: '#7a5600' }));
{
  const body = new Group();
  const wood = new MeshLambertMaterial({ color: '#8a5a2e' });
  const red = new MeshLambertMaterial({ color: '#d9473f' });
  const white = new MeshLambertMaterial({ color: '#f1ece0' });
  const add = (w: number, h: number, d: number, m: MeshLambertMaterial, x: number, y: number, z: number) => {
    const b = new Mesh(unitBox, m);
    b.scale.set(w, h, d);
    b.position.set(x, y, z);
    body.add(b);
  };
  add(2.2, 0.7, 0.7, wood, 0, 0.35, 0.1); // counter
  for (const x of [-1.0, 1.0]) add(0.12, 2.15, 0.12, wood, x, 1.07, 0.3); // posts
  for (let i = 0; i < 4; i++) add(0.55, 0.12, 1.1, i % 2 ? white : red, -0.83 + i * 0.55, 1.75, 0.2); // awning
  add(0.34, 0.34, 0.34, new MeshLambertMaterial({ color: '#f7c53b', emissive: '#7a5600' }), 0.55, 0.87, 0.1); // coin block
  const sign = makeLabel(
    [
      { text: 'MARKET', size: 62, color: '#f7c53b' },
      { text: 'TAP TO SELL', size: 30, color: '#ffffff' },
    ],
    2.0,
    0.8,
    '#2b1d12',
    '#f7c53b',
  );
  sign.position.set(0, 2.5, 0.32);
  body.add(sign);
  stallCoin.scale.set(0.3, 0.3, 0.3);
  stallCoin.position.set(0, 3.2, 0.32);
  stallCoin.visible = false;
  body.add(stallCoin);
  body.scale.setScalar(0.85);
  stall.add(body);
}
stall.visible = false;
scene.add(stall);
const stallPos = new Vector3(); // world position of the stall (fixed until it is pitched again)
let stallCol = 0; // array index (prelude included) of the column it stands on
let stallPopT = 1;
let stallShake = 0;

function pitchStall() {
  if (!world) return;
  const next = Math.max(0, curCol - STALL_BACK);
  const prevX = stall.visible ? stallPos.x : null;
  stallCol = next;
  stallPos.set(world.cols[next].x, world.cols[next].level, 0);
  // the traders move along with their market
  if (prevX !== null) for (const n of npcs) n.x += stallPos.x - prevX;
  stall.visible = true;
  stallPopT = 0;
}

type NpcKind = WalletTag | 'PLAIN';
interface Npc {
  group: Group;
  armL: Mesh;
  armR: Mesh;
  marker: Mesh;
  kind: NpcKind;
  action: WalletAction;
  x: number;
  y: number;
  slot: number;
  age: number; // seconds since arriving (cosmetic)
  walking: boolean;
  /** Reveal: higher survives the character cap longer. 0 in normal play. */
  priority: number;
  /** Reveal: the verdict's first qualifying SMART SELL. */
  signal: boolean;
  banner: Mesh | null;
  ring: Mesh | null;
  /** Presentation: a brief light beam over an important wallet's character. */
  beam: Mesh | null;
  beamT: number;
  hissed: boolean;
}
const npcs: Npc[] = [];
const mat = (c: string) => new MeshLambertMaterial({ color: c });
const NPC_MATS = {
  creeper: mat('#4fae4a'),
  creeperDark: mat('#16301a'),
  robe: mat('#8b6b4a'),
  skin: mat('#c99a70'),
  nose: mat('#a67a52'),
  gold: new MeshLambertMaterial({ color: '#f7c53b', emissive: '#6b4a00' }),
  whale: mat('#6f5bd6'),
  plain: mat('#9aa0a6'),
  plainDark: mat('#6b7076'),
};
const MARKER_COLOR: Record<WalletAction, string> = {
  BUY: '#4fd35f',
  SELL: '#e5483f',
  SUPPLY_MOVE: '#f7c53b',
  LIQUIDITY_REMOVAL: '#3dd6d0',
};

const markerGeo = new BoxGeometry(0.4, 0.4, 0.4);
const markerMats: Partial<Record<WalletAction, MeshBasicMaterial>> = {};
function markerMat(a: WalletAction): MeshBasicMaterial {
  return (markerMats[a] ??= new MeshBasicMaterial({ color: MARKER_COLOR[a] }));
}
const beamGeo = new BoxGeometry(0.16, 7, 0.16);
const beamMats: Record<string, MeshBasicMaterial> = {};
function beamMat(color: string): MeshBasicMaterial {
  return (beamMats[color] ??= new MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }));
}
function releaseNpc(n: Npc) {
  scene.remove(n.group);
  disposeOwned(n.group);
}

function makeNpc(kind: NpcKind, action: WalletAction): Npc {
  const g = new Group();
  const box = (w: number, h: number, d: number, m: MeshLambertMaterial, x: number, y: number, z = 0) => {
    const b = new Mesh(unitBox, m);
    b.scale.set(w, h, d);
    b.position.set(x, y, z);
    g.add(b);
    return b;
  };
  let armL: Mesh;
  let armR: Mesh;
  if (kind === 'DEV') {
    // creeper-like: tall body, four stubby legs, blank face
    box(0.7, 1.1, 0.5, NPC_MATS.creeper, 0, 1.0);
    box(0.7, 0.7, 0.7, NPC_MATS.creeper, 0, 1.9);
    box(0.14, 0.14, 0.05, NPC_MATS.creeperDark, -0.17, 1.98, 0.36);
    box(0.14, 0.14, 0.05, NPC_MATS.creeperDark, 0.17, 1.98, 0.36);
    box(0.2, 0.3, 0.05, NPC_MATS.creeperDark, 0, 1.72, 0.36);
    for (const x of [-0.2, 0.2]) for (const z of [-0.15, 0.15]) box(0.25, 0.45, 0.25, NPC_MATS.creeper, x, 0.23, z);
    armL = armR = new Mesh(unitBox, NPC_MATS.creeper); // no arms
  } else if (kind === 'INSIDER') {
    // identical villagers: long robe, big nose, folded arms
    box(0.7, 1.2, 0.5, NPC_MATS.robe, 0, 0.7);
    box(0.5, 0.55, 0.5, NPC_MATS.skin, 0, 1.55);
    box(0.14, 0.28, 0.18, NPC_MATS.nose, 0, 1.5, 0.33);
    box(0.8, 0.22, 0.3, NPC_MATS.robe, 0, 1.0, 0.3); // folded arms
    armL = armR = new Mesh(unitBox, NPC_MATS.robe);
  } else if (kind === 'SMART') {
    // gold-armoured
    box(0.28, 0.55, 0.3, NPC_MATS.gold, -0.17, 0.275);
    box(0.28, 0.55, 0.3, NPC_MATS.gold, 0.17, 0.275);
    box(0.7, 0.7, 0.4, NPC_MATS.gold, 0, 0.9);
    box(0.56, 0.56, 0.56, NPC_MATS.gold, 0, 1.52);
    box(0.4, 0.1, 0.05, NPC_MATS.plainDark, 0, 1.52, 0.29); // visor slit
    armL = box(0.2, 0.6, 0.25, NPC_MATS.gold, -0.46, 0.95);
    armR = box(0.2, 0.6, 0.25, NPC_MATS.gold, 0.46, 0.95);
  } else {
    const body = kind === 'WHALE' ? NPC_MATS.whale : NPC_MATS.plain;
    const legs = kind === 'WHALE' ? NPC_MATS.whale : NPC_MATS.plainDark;
    box(0.28, 0.55, 0.3, legs, -0.17, 0.275);
    box(0.28, 0.55, 0.3, legs, 0.17, 0.275);
    box(0.7, 0.7, 0.4, body, 0, 0.9);
    box(0.5, 0.5, 0.5, NPC_MATS.skin, 0, 1.5);
    armL = box(0.2, 0.6, 0.25, body, -0.46, 0.95);
    armR = box(0.2, 0.6, 0.25, body, 0.46, 0.95);
  }
  if (kind === 'WHALE') g.scale.setScalar(1.45);
  const marker = new Mesh(markerGeo, markerMat(action));
  marker.position.y = kind === 'WHALE' ? 2.3 : 2.45;
  g.add(marker);
  scene.add(g);
  return { group: g, armL, armR, marker, kind, action, x: 0, y: 0, slot: 0, age: -1, walking: true, priority: 0, signal: false, banner: null, ring: null, beam: null, beamT: 0, hissed: false };
}

const crackMat = new MeshBasicMaterial({ color: '#16110c' });
const cracks = new Group();
scene.add(cracks);
let crackCount = 0;

function addCracks(n: number) {
  for (let i = 0; i < n && crackCount < 60; i++, crackCount++) {
    const seed = crackCount * 7 + 3;
    const len = 0.8 + hash(seed, 1) * 1.6;
    const c = new Mesh(unitBox, crackMat);
    c.scale.set(len, 0.05, 0.1);
    c.rotation.y = (hash(seed, 2) - 0.5) * 1.6;
    c.position.set(
      stallPos.x + (hash(seed, 3) - 0.5) * 3.2,
      stallPos.y + 0.04,
      -0.5 + hash(seed, 4) * 1.4,
    );
    cracks.add(c);
  }
}

function groundAt(x: number): number {
  if (!world) return 0;
  const i = Math.max(0, Math.min(world.cols.length - 1, Math.round(x) + PRELUDE));
  return world.cols[i].level;
}

function spawnNpc(tag: WalletTag | null, action: WalletAction, opts: { signal?: boolean; priority?: number; label?: string; beamColor?: string } = {}) {
  if (!world) return;
  if (tag === 'LIQUIDITY' || action === 'LIQUIDITY_REMOVAL') {
    stallShake = 1;
    addCracks(8);
    if (tag === 'LIQUIDITY') return; // the stall itself reacts; no character
  }
  const priority = opts.priority ?? 0;
  while (npcs.length >= MAX_NPCS) {
    // Character cap: the least relevant goes first, the oldest among equals. In normal play every
    // priority is 0, so this is the plain oldest-first rule. The signal wallet is never the victim.
    let victim = -1;
    let lowest = Infinity;
    npcs.forEach((n, i) => {
      if (!n.signal && n.priority < lowest) {
        lowest = n.priority;
        victim = i;
      }
    });
    if (victim === -1 || priority < lowest) return; // everything on screen matters more
    const [old] = npcs.splice(victim, 1);
    releaseNpc(old);
  }
  const npc = makeNpc(tag ?? 'PLAIN', action);
  npc.priority = priority;
  npc.slot = npcs.length % 6;
  npc.x = stallPos.x - 7;
  npc.y = groundAt(npc.x);
  if (opts.signal) {
    // the first major smart-wallet exit: a banner and a glowing ring, briefly
    npc.signal = true;
    npc.banner = makeLabel(
      [{ text: opts.label ?? 'WALLET EXIT', size: Math.min(25, Math.floor(236 / ((opts.label ?? 'WALLET EXIT').length * 0.62))), color: '#f7c53b' }],
      4.4,
      0.9,
      '#2b1d12',
      '#f7c53b',
    );
    npc.banner.position.set(0, 3.6, 0.3);
    npc.group.add(npc.banner);
    npc.ring = new Mesh(own(new BoxGeometry(1.6, 0.05, 1.6)), own(new MeshBasicMaterial({ color: '#f7c53b', transparent: true, opacity: 0.7 })));
    npc.ring.position.y = 0.04;
    npc.group.add(npc.ring);
  }
  if (opts.beamColor) {
    const beam = new Mesh(beamGeo, beamMat(opts.beamColor));
    beam.position.y = 3.6;
    npc.group.add(beam);
    npc.beam = beam;
    npc.beamT = 1.8;
  }
  if (tag === 'DEV') npc.group.scale.setScalar(1.15); // the creeper reads a little bigger
  npcs.push(npc);
}

function updateActors(dt: number) {
  if (!world) return;
  // fixed market: pitched once, and again only when it is about to scroll out of view
  const leftEdge = camPos.x - viewCols / 2;
  if (!stall.visible || world.cols[stallCol].x < leftEdge + STALL_MARGIN) pitchStall();
  stallPopT = Math.min(1, stallPopT + dt * 4);
  stall.scale.setScalar(Math.max(0.001, 1 - Math.pow(1 - stallPopT, 3)));
  stallShake = Math.max(0, stallShake - dt * 0.8);
  stall.position.set(stallPos.x + (stallShake > 0 ? (Math.random() - 0.5) * stallShake * 0.25 : 0), stallPos.y, 0);
  // while holding, a gold block bobs over the sign: this is where you cash out
  stallCoin.visible = holding;
  stallCoin.rotation.y = time * 2.2;
  stallCoin.position.y = 3.2 + Math.sin(time * 4) * 0.08;

  for (let i = npcs.length - 1; i >= 0; i--) {
    const n = npcs[i];
    const standX = stallPos.x - 1.7 - n.slot * 0.85;
    const leaving = n.age > NPC_LIFE;
    const goal = leaving ? standX - 8 : standX;
    const dx = goal - n.x;
    n.walking = Math.abs(dx) > 0.08;
    if (n.walking) n.x += Math.sign(dx) * Math.min(Math.abs(dx), (leaving ? 3.2 : 4.2) * dt);
    else if (!leaving) n.age = Math.max(0, n.age) + dt;
    if (leaving) n.age += dt;
    const gy = groundAt(n.x);
    n.y += (gy - n.y) * (1 - Math.exp(-dt * 10));
    n.group.position.set(n.x, n.y, PLAYER_Z - 0.05);
    n.group.rotation.y = n.walking ? (dx > 0 ? 0.35 : -0.35) : 0;
    const swing = n.walking ? Math.sin(time * 14 + i) * 0.7 : 0;
    n.armL.rotation.x = swing;
    n.armR.rotation.x = -swing;
    n.group.position.y += n.walking ? Math.abs(Math.sin(time * 14 + i)) * 0.12 : 0;
    n.marker.rotation.y = time * 2;
    if (n.signal) {
      if (n.banner) n.banner.visible = n.age < 6;
      if (n.ring) {
        n.ring.visible = n.age < 6;
        (n.ring.material as MeshBasicMaterial).opacity = 0.45 + Math.sin(time * 7) * 0.3;
      }
      if (n.age < 6) n.group.scale.setScalar(1 + Math.max(0, Math.sin(time * 7)) * 0.1);
    }
    // the creeper swells before it goes (cosmetic flourish, driven by the same event)
    if (n.kind === 'DEV' && n.age > 2.5 && n.age < 4) n.group.scale.setScalar(1.15 + Math.sin((n.age - 2.5) * 12) * 0.12);
    if (n.kind === 'DEV' && !n.hissed && n.age > 2.5) {
      n.hissed = true; // the hiss: a puff of smoke as the creeper swells
      burst(n.x, n.y + 1.3, PLAYER_Z, 8, 'dust', { up: 1.5, spread: 1.4, g: -1, life: 0.9, size: 0.3 });
    }
    if (n.beam) {
      n.beamT -= dt;
      const k = Math.max(0, n.beamT / 1.8);
      n.beam.scale.set(0.4 + k * 0.9, 1, 0.4 + k * 0.9);
      if (n.beamT <= 0) {
        n.group.remove(n.beam);
        n.beam = null;
      }
    }
    if (n.age > NPC_LIFE + 2.5) {
      releaseNpc(n);
      npcs.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- game feel (presentation only)
// Everything below reacts to messages that carry real, already-decided replay facts. None of it
// touches prices, timing, wallet events, signals or the verdict: it only adds sound, small motion
// and emphasis. All effects use small pools of reused voxel pieces, so a long session (or a burst
// of events) can never accumulate objects.
const audio = createAudio();
const BASE_FOV = 45;
let activity = 0; // 0..1: how much real price movement has just been crossed (decays)
let fovKick = 0; // transient camera zoom punch, degrees
let lastClockTs = -1;
let lastClockAdvanceAt = 0;
let musicPlaying = true;
let cloudDrift = 0;
let stackPop = 0;

const sparkMats = {
  gold: new MeshBasicMaterial({ color: '#ffd54a' }),
  green: new MeshBasicMaterial({ color: '#5dff7a' }),
  red: new MeshBasicMaterial({ color: '#ff5a4f' }),
  dust: new MeshBasicMaterial({ color: '#8b6b4a' }),
  teal: new MeshBasicMaterial({ color: '#3dd6d0' }),
};
type SparkColor = keyof typeof sparkMats;
interface Spark { mesh: Mesh; vx: number; vy: number; vz: number; life: number; max: number; g: number; size: number }
const SPARK_POOL = 40;
const sparks: Spark[] = [];
for (let i = 0; i < SPARK_POOL; i++) {
  const mesh = new Mesh(unitBox, sparkMats.gold);
  mesh.visible = false;
  scene.add(mesh);
  sparks.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, max: 1, g: 9, size: 0.18 });
}
let sparkNext = 0;
function burst(x: number, y: number, z: number, count: number, color: SparkColor, o: { up?: number; spread?: number; g?: number; life?: number; size?: number } = {}) {
  const up = o.up ?? 3;
  const spread = o.spread ?? 2;
  const g = o.g ?? 9;
  const life = o.life ?? 0.7;
  const size = o.size ?? 0.18;
  for (let i = 0; i < count; i++) {
    const sp = sparks[sparkNext];
    sparkNext = (sparkNext + 1) % SPARK_POOL; // the oldest piece is recycled when the pool is busy
    sp.mesh.material = sparkMats[color];
    sp.mesh.position.set(x + (Math.random() - 0.5) * 0.6, y, z + (Math.random() - 0.5) * 0.6);
    sp.vx = (Math.random() - 0.5) * spread * 2;
    sp.vy = up * (0.5 + Math.random() * 0.8);
    sp.vz = (Math.random() - 0.5) * spread;
    sp.g = g;
    sp.life = sp.max = life * (0.7 + Math.random() * 0.6);
    sp.size = size * (0.7 + Math.random() * 0.7);
    sp.mesh.scale.setScalar(sp.size);
    sp.mesh.visible = true;
  }
}

interface Ring { mesh: Mesh; t: number; size: number }
const RING_POOL = 4;
const rings: Ring[] = [];
for (let i = 0; i < RING_POOL; i++) {
  const mesh = new Mesh(unitBox, new MeshBasicMaterial({ color: '#ffd54a', transparent: true, opacity: 0.6 }));
  mesh.scale.set(1, 0.04, 1);
  mesh.visible = false;
  scene.add(mesh);
  rings.push({ mesh, t: 1, size: 3 });
}
let ringNext = 0;
function pulse(x: number, y: number, z: number, color: string, size = 3) {
  const r = rings[ringNext];
  ringNext = (ringNext + 1) % RING_POOL;
  (r.mesh.material as MeshBasicMaterial).color.set(color);
  r.mesh.position.set(x, y + 0.08, z);
  r.t = 0;
  r.size = size;
  r.mesh.visible = true;
}

// one reusable floating label ("BOUGHT", "+12%")
const floatCanvas = document.createElement('canvas');
floatCanvas.width = 256;
floatCanvas.height = 96;
const floatTex = new CanvasTexture(floatCanvas);
const floatMat = new MeshBasicMaterial({ map: floatTex, transparent: true, depthTest: false });
const floatMesh = new Mesh(new PlaneGeometry(3.2, 1.2), floatMat);
floatMesh.visible = false;
floatMesh.renderOrder = 10;
scene.add(floatMesh);
let floatT = 1;
const floatPos = new Vector3();
function floatText(text: string, color: string, x: number, y: number, z: number) {
  const g = floatCanvas.getContext('2d') as CanvasRenderingContext2D;
  g.clearRect(0, 0, 256, 96);
  g.font = 'bold 54px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 9;
  g.strokeStyle = '#0c1118';
  g.strokeText(text, 128, 48);
  g.fillStyle = color;
  g.fillText(text, 128, 48);
  floatTex.needsUpdate = true;
  floatPos.set(x, y, z);
  floatT = 0;
  floatMesh.visible = true;
}

const pops: { obj: Object3D; t: number }[] = [];
function popIn(obj: Object3D) {
  obj.scale.setScalar(0.01);
  pops.push({ obj, t: 0 });
  if (pops.length > 12) pops.shift();
}

const flashEl = document.getElementById('flash') as HTMLElement | null;
function flash(color: string, peak: number, ms: number) {
  if (!flashEl) return;
  flashEl.style.transition = 'none';
  flashEl.style.background = color;
  flashEl.style.opacity = String(peak);
  void flashEl.offsetWidth; // restart the fade
  flashEl.style.transition = `opacity ${ms}ms ease-out`;
  flashEl.style.opacity = '0';
}

/** Real price movement crossed: make the terrain change feel responsive, big moves louder. */
function onPriceTick(index: number) {
  if (!world) return;
  const lvl = world.terrain[index].level;
  const prevLvl = index > 0 ? world.terrain[index - 1].level : lvl;
  const dl = lvl - prevLvl;
  const mag = Math.abs(dl);
  if (mag === 0) return;
  activity = Math.min(1, activity + Math.min(1, mag / 6) * 0.3);
  const col = world.cols[PRELUDE + index];
  const up = dl > 0;
  burst(col.x, col.level + 0.3, PLAYER_Z, Math.min(8, 1 + mag), up ? 'green' : 'red', { up: up ? 4 : 2, spread: 1.6, life: 0.6 });
  if (mag >= 4) {
    shake = Math.max(shake, Math.min(0.5, 0.15 + mag * 0.04));
    fovKick = Math.max(fovKick, 2.5);
    audio.whoosh(up);
  }
  if (rug && !up && mag >= 2) {
    // the cave-in: bits of the cliff break away as the price drops
    const pc = world.cols[PRELUDE + index - 1];
    burst(pc.x + 0.5, pc.level, PLAYER_Z, Math.min(10, 3 + mag), 'dust', { up: 1, spread: 2.5, g: 16, life: 0.9, size: 0.28 });
  }
}

/** Sound and emphasis for a wallet event. Only what the scene was told: in hard mode the tag is null. */
function onWalletEvent(msg: Extract<HostMessage, { type: 'WALLET_EVENT' }>): { beamColor?: string } {
  const isLiq = msg.tag === 'LIQUIDITY' || msg.action === 'LIQUIDITY_REMOVAL';
  const isSmartSell = msg.tag === 'SMART' && msg.action === 'SELL';
  let beamColor: string | undefined;
  if (isLiq) {
    audio.crack();
    shake = Math.max(shake, 0.35);
    flash('#3dd6d0', 0.18, 300);
    beamColor = '#3dd6d0';
  } else if (msg.signal || isSmartSell) {
    audio.warn();
    fovKick = Math.max(fovKick, 1.5);
    flash('#ffd54a', 0.16, 260);
    beamColor = '#ffd54a';
  } else if (msg.tag === 'DEV') {
    audio.dev();
    beamColor = '#5dff7a';
  } else {
    audio.blip();
  }
  if (beamColor) pulse(stallPos.x - 1.7, stallPos.y, PLAYER_Z, beamColor, 3.5);
  return { beamColor };
}

function resetFeel() {
  activity = 0;
  fovKick = 0;
  stackPop = 0;
  chestStack.scale.setScalar(1);
  for (const sp of sparks) sp.mesh.visible = false;
  for (const r of rings) r.mesh.visible = false;
  floatMesh.visible = false;
  floatT = 1;
  pops.length = 0;
  audio.setRug(false);
  if (flashEl) {
    flashEl.style.transition = 'none';
    flashEl.style.opacity = '0';
  }
}

const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const x = t - 1;
  return 1 + (c1 + 1) * x * x * x + c1 * x * x;
};

function updateFeel(dt: number) {
  activity = Math.max(0, activity - dt * 0.45);
  fovKick = Math.max(0, fovKick - dt * (rug && rugT < 0.35 ? 2.5 : 6));
  audio.setTension(rug ? 1 : activity);
  // the music ducks whenever the replay clock is frozen (result / verdict)
  const clockMoving = performance.now() - lastClockAdvanceAt < 1500;
  if (clockMoving !== musicPlaying) {
    musicPlaying = clockMoving;
    audio.setPlaying(clockMoving);
  }
  for (const sp of sparks) {
    if (!sp.mesh.visible) continue;
    sp.life -= dt;
    if (sp.life <= 0) {
      sp.mesh.visible = false;
      continue;
    }
    sp.vy -= sp.g * dt;
    sp.mesh.position.x += sp.vx * dt;
    sp.mesh.position.y += sp.vy * dt;
    sp.mesh.position.z += sp.vz * dt;
    sp.mesh.rotation.x += dt * 6;
    sp.mesh.rotation.y += dt * 5;
    sp.mesh.scale.setScalar(sp.size * Math.min(1, (sp.life / sp.max) * 1.6));
  }
  for (const r of rings) {
    if (!r.mesh.visible) continue;
    r.t += dt * 1.8;
    if (r.t >= 1) {
      r.mesh.visible = false;
      continue;
    }
    const sz = 0.4 + r.t * r.size;
    r.mesh.scale.set(sz, 0.04, sz);
    (r.mesh.material as MeshBasicMaterial).opacity = 0.65 * (1 - r.t);
  }
  if (floatT < 1) {
    floatT += dt / 1.4;
    if (floatT >= 1) floatMesh.visible = false;
    else {
      floatMesh.position.set(floatPos.x, floatPos.y + floatT * 2, floatPos.z);
      floatMat.opacity = 1 - Math.max(0, (floatT - 0.6) / 0.4);
      floatMesh.scale.setScalar(1 + (1 - floatT) * 0.25);
    }
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    const pp = pops[i];
    pp.t += dt * 3;
    if (pp.t >= 1) {
      pp.obj.scale.setScalar(1);
      pops.splice(i, 1);
    } else pp.obj.scale.setScalar(Math.max(0.01, easeOutBack(pp.t)));
  }
  if (stackPop > 0) {
    stackPop = Math.max(0, stackPop - dt * 4);
    chestStack.scale.setScalar(1 + stackPop * 0.7);
  }
  cloudDrift += dt * 0.35; // the sky keeps moving even when the price does not
  if (rug && rugT < 1) shake = Math.max(shake, 0.1 * (1 - rugT) + 0.02); // collapse rumble
}

// ---------------------------------------------------------------- message handling
function handle(msg: HostMessage) {
  switch (msg.type) {
    case 'RESET':
      audio.stopMusic();
      resetScene();
      break;
    case 'START_REPLAY':
      resetScene();
      if (msg.terrain.length === 0) return;
      world = buildWorld(msg.terrain);
      curCol = PRELUDE - 1;
      revealed = world.blockPrefix[curCol];
      revealedCols = PRELUDE;
      snapPlayerTo(curCol);
      camReady = false;
      lastClockAdvanceAt = performance.now();
      audio.startMusic();
      break;
    case 'SET_MUTED':
      audio.setMuted(msg.muted);
      break;
    case 'SET_COSMETICS':
      applyCosmetics(msg.characterSkin, msg.arena);
      break;
    case 'REPLAY_CLOCK':
      clockState.index = msg.index;
      clockState.frac = msg.frac;
      clockState.timestamp = msg.timestamp;
      clockState.price = msg.price;
      clockState.progress = msg.progress;
      clockState.speed = msg.speed;
      if (msg.timestamp !== lastClockTs) {
        lastClockTs = msg.timestamp;
        lastClockAdvanceAt = performance.now();
      }
      break;
    case 'PRICE_TICK': {
      if (!world) return;
      curCol = PRELUDE + msg.index;
      hopFrom.copy(playerPos);
      hopT = 0;
      setCursor(curCol);
      onPriceTick(msg.index);
      break;
    }
    case 'BUY': {
      if (!world) return;
      holding = true;
      sold = false;
      const col = world.cols[PRELUDE + msg.index];
      if (buyFlag) releaseFlag(buyFlag);
      buyFlag = flag('#2f9d45', 'YOU BOUGHT');
      buyFlag.position.set(col.x, col.level, PLAYER_Z - 0.6);
      scene.add(buyFlag);
      popIn(buyFlag);
      // immediate feedback: coin sound, gold pop, ring, label, a little zoom punch
      audio.buy();
      stackPop = 1;
      fovKick = Math.max(fovKick, 1.6);
      burst(playerPos.x, playerPos.y + 1.4, PLAYER_Z, 10, 'gold', { up: 4.5, spread: 1.8, life: 0.8 });
      pulse(playerPos.x, playerPos.y, PLAYER_Z, '#ffd54a', 3);
      floatText('BOUGHT', '#ffd54a', playerPos.x, playerPos.y + 2.6, PLAYER_Z);
      break;
    }
    case 'SELL': {
      if (!world) return;
      holding = false;
      sold = true;
      jumpT = 0;
      const col = world.cols[PRELUDE + msg.index];
      if (sellFlag) releaseFlag(sellFlag);
      sellFlag = flag('#2f7fd6', 'YOU SOLD');
      sellFlag.position.set(col.x, col.level, PLAYER_Z - 0.6);
      scene.add(sellFlag);
      popIn(sellFlag);
      // cash-out: a stronger sound (and a bright one when it is a profit), burst, ring, P/L label
      const pnl = msg.pnlPct;
      const profit = pnl === undefined ? null : pnl > 0;
      audio.sell(profit);
      burst(playerPos.x, playerPos.y + 1.4, PLAYER_Z, profit ? 18 : 8, profit === false ? 'red' : 'gold', { up: 5.5, spread: 2.4, life: 0.95 });
      pulse(playerPos.x, playerPos.y, PLAYER_Z, profit === false ? '#ff5a4f' : '#ffd54a', 3.6);
      floatText(pnl === undefined ? 'SOLD' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(0)}%`, profit === false ? '#ff7a6f' : '#7dff8f', playerPos.x, playerPos.y + 2.8, PLAYER_Z);
      shake = Math.max(shake, profit ? 0.22 : 0.1);
      if (profit) flash('#ffd54a', 0.22, 350);
      break;
    }
    case 'WALLET_EVENT': {
      const fx = onWalletEvent(msg);
      spawnNpc(msg.tag, msg.action, { signal: msg.signal, priority: msg.priority, label: msg.signalLabel, beamColor: fx.beamColor });
      break;
    }
    case 'MARK': {
      if (!world) return;
      const col = world.cols[curCol];
      const collapse = msg.kind === 'COLLAPSE';
      const f = flag(collapse ? '#b3261e' : '#d9822b', collapse ? 'COLLAPSE' : 'YOU WERE IN');
      f.position.set(col.x + (collapse ? -0.9 : 0.9), col.level, PLAYER_Z - 0.6);
      scene.add(f);
      popIn(f);
      markFlags.push(f);
      if (!collapse) audio.held();
      break;
    }
    case 'SHOW_RUG':
      rug = true;
      rugT = 0;
      shake = 1;
      // the payoff: sound, zoom punch, a red flash, flying debris, and the music turns tense
      audio.crash();
      audio.setRug(true);
      fovKick = Math.max(fovKick, 9);
      activity = 1;
      flash('#ff2a1a', 0.55, 900);
      burst(playerPos.x, playerPos.y + 1, PLAYER_Z, 14, 'red', { up: 5, spread: 3, life: 1.1, size: 0.24 });
      burst(playerPos.x - 2, playerPos.y + 0.5, PLAYER_Z, 12, 'dust', { up: 2, spread: 4, g: 14, life: 1.2, size: 0.3 });
      break;
  }
}

function resetScene() {
  disposeWorld();
  for (const f of [buyFlag, sellFlag]) if (f) releaseFlag(f);
  buyFlag = sellFlag = null;
  for (const f of markFlags) releaseFlag(f);
  markFlags.length = 0;
  holding = sold = rug = false;
  rugT = shake = 0;
  clockState.index = -1;
  clockState.frac = 0.5;
  cursor.visible = false;
  stall.visible = false;
  stallShake = 0;
  for (const n of npcs) releaseNpc(n);
  npcs.length = 0;
  cracks.clear();
  crackCount = 0;
  resetFeel();
  revealed = 0;
  curCol = 0;
  revealedCols = 0;
  jumpT = 1;
  playerPos.set(0, 0, PLAYER_Z);
}

// ---------------------------------------------------------------- input
function onPointer(e: PointerEvent) {
  audio.unlock();
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const feet = new Vector3(playerPos.x, playerPos.y, PLAYER_Z).project(camera);
  const top = new Vector3(playerPos.x, playerPos.y + 2, PLAYER_Z).project(camera);
  const sx = (feet.x * 0.5 + 0.5) * rect.width;
  const sy = (-feet.y * 0.5 + 0.5) * rect.height;
  const sTop = (-top.y * 0.5 + 0.5) * rect.height;
  const cy = (sy + sTop) / 2;
  const radius = Math.max(60, Math.abs(sy - sTop) * 0.9);
  if (Math.hypot(px - sx, py - cy) <= radius) {
    post({ type: 'PLAYER_TAPPED' });
    return;
  }
  if (stall.visible) {
    const base = new Vector3(stall.position.x, stall.position.y, 0).project(camera);
    const roof = new Vector3(stall.position.x, stall.position.y + 2.2, 0).project(camera);
    const bx = (base.x * 0.5 + 0.5) * rect.width;
    const by = (-base.y * 0.5 + 0.5) * rect.height;
    const ry = (-roof.y * 0.5 + 0.5) * rect.height;
    const stallRadius = Math.max(64, Math.abs(by - ry) * 1.1);
    if (Math.hypot(px - bx, py - (by + ry) / 2) <= stallRadius) post({ type: 'STALL_TAPPED' });
  }
}
canvas.addEventListener('pointerdown', onPointer);

// ---------------------------------------------------------------- loop
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function setViewCols(cols: number) {
  viewCols = cols;
  viewDist = cols / 2 / (Math.tan((BASE_FOV * Math.PI) / 360) * camera.aspect);
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

function update(dt: number) {
  time += dt;
  updateFeel(dt);

  if (world) {
    // grow columns bottom-up to the newest tick
    const target = world.blockPrefix[curCol];
    revealed += (target - revealed) * (1 - Math.exp(-dt * 10));
    if (target - revealed < 0.6) revealed = target;
    const shown = Math.ceil(revealed - 0.001);
    world.blocks.count = Math.min(shown, target);
    let done = 0;
    while (done < world.blockPrefix.length && world.blockPrefix[done] <= shown) done++;
    revealedCols = done;
    // player hops to the newest column
    const dest = world.cols[curCol];
    // Within a tick the player walks along its column as the replay clock moves from this tick
    // toward the next; the next column only appears when the clock reaches it.
    const walk = clockState.index === curCol - PRELUDE ? (clockState.frac - 0.5) * 0.7 : 0;
    destPos.set(dest.x + walk, dest.level, PLAYER_Z);
    if (hopT < 1) {
      hopT = Math.min(1, hopT + dt * 3.2);
      playerPos.lerpVectors(hopFrom, destPos, easeOut(hopT));
      playerPos.y += Math.sin(hopT * Math.PI) * 0.9;
    } else {
      playerPos.copy(destPos);
    }
    let jump = 0;
    if (jumpT < 1) {
      jumpT = Math.min(1, jumpT + dt * 1.4);
      jump = Math.sin(jumpT * Math.PI) * 1.6;
    }

    player.position.set(playerPos.x, playerPos.y + jump, playerPos.z);
    const bob = sold ? 0 : Math.sin(time * 6) * 0.04;
    player.position.y += bob;
    const moving = hopT < 1;
    armL.rotation.x = moving ? Math.sin(time * 18) * 0.7 : sold ? Math.PI : 0;
    armR.rotation.x = moving ? -Math.sin(time * 18) * 0.7 : sold ? Math.PI : 0;
    head.rotation.z = rug && !sold ? Math.sin(time * 30) * 0.12 : 0;
    chestStack.visible = holding;

    cursor.scale.y = 1 + Math.sin(time * 8) * 0.25;
    (cursor.material as MeshBasicMaterial).opacity = 0.45 + Math.sin(time * 8) * 0.2;
    updateActors(dt);
  }

  // camera: follows the player, history behind, unknown ahead. Zooms out to keep the recent
  // price range (e.g. the cliff we just fell off) in frame.
  let top = playerPos.y + 7;
  let bottom = playerPos.y - 2;
  if (world) {
    for (let c = Math.max(0, curCol - FRAME_LOOKBACK); c <= curCol; c++) {
      top = Math.max(top, world.cols[c].level + 6);
      bottom = Math.min(bottom, world.cols[c].level - 1);
    }
  }
  const minH = MIN_VIEW_COLS / camera.aspect;
  const wantH = Math.max(minH, top - bottom);
  const wantCols = Math.min(MAX_VIEW_COLS, wantH * camera.aspect);
  const camTargetY = (top + bottom) / 2;
  const camTargetX = playerPos.x - (PLAYER_SCREEN_X - 0.5) * viewCols;
  if (!camReady) {
    camPos.set(camTargetX, camTargetY, 0);
    setViewCols(wantCols);
    camReady = true;
  } else {
    const kx = 1 - Math.exp(-dt * 5);
    const ky = 1 - Math.exp(-dt * 2.5);
    camPos.x += (camTargetX - camPos.x) * kx;
    camPos.y += (camTargetY - camPos.y) * ky;
    setViewCols(viewCols + (wantCols - viewCols) * ky);
  }
  shake = Math.max(0, shake - dt * 0.6);
  // busy markets zoom out a touch and big moments punch in; both ease back on their own
  const fov = BASE_FOV + activity * 4 + fovKick;
  if (Math.abs(fov - camera.fov) > 0.02) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  const sx = shake > 0 ? (Math.random() - 0.5) * shake * 0.9 : 0;
  const sy = shake > 0 ? (Math.random() - 0.5) * shake * 0.9 : 0;
  camera.position.set(camPos.x + 3.5 + sx, camPos.y + 3 + sy, viewDist);
  camera.lookAt(camPos.x, camPos.y - 0.5, 0);

  // rug mood: sky goes dark red
  if (rug) rugT = Math.min(1, rugT + dt * 0.7);
  const sky = skyColor.copy(COLORS.sky).lerp(COLORS.rugSky, rugT);
  (scene.background as Color).copy(sky);
  if (stars.visible) stars.position.set(camPos.x, camPos.y, 0);
  lambert.color.setRGB(1, 1 - rugT * 0.28, 1 - rugT * 0.32); // warm red cast over the terrain
  (scene.fog as Fog).color.copy(sky);
  (scene.fog as Fog).near = viewDist + 10;
  (scene.fog as Fog).far = viewDist + 70;

  // clouds drift slower than the camera (parallax)
  clouds.children.forEach((g, i) => {
    const s = cloudSeeds[i];
    const span = 126;
    const rel = (((s.x - camPos.x * 0.5 + cloudDrift) % span) + span) % span;
    g.position.set(camPos.x - span / 2 + rel, camPos.y + s.y - 8, s.z);
  });

}

let prev = performance.now();
let frameMs = 16; // smoothed real frame time
let frameCount = 0;
let slowFrames = 0;
function frame(now: number) {
  const raw = now - prev;
  frameCount++;
  update(Math.min(0.05, raw / 1000));
  prev = now;
  frameMs += (Math.min(raw, 100) - frameMs) * 0.05;
  // Adaptive resolution: if the device can't hold ~30fps, render fewer pixels.
  slowFrames = frameMs > 34 ? slowFrames + 1 : 0;
  if (slowFrames > 90 && pixelRatio > 1) {
    pixelRatio = Math.max(1, pixelRatio - 0.5);
    renderer.setPixelRatio(pixelRatio);
    resize();
    slowFrames = 0;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Test hook: advance the simulation without waiting on the renderer (deterministic screenshots).
(window as unknown as { __rugAdvance: (seconds: number) => void }).__rugAdvance = (seconds) => {
  for (let t = 0; t < seconds; t += 0.05) update(0.05);
};

// Test hook: where the player and the stall are on screen (CSS px), for synthetic taps.
(window as unknown as { __rugScreen: () => unknown }).__rugScreen = () => {
  const at = (x: number, y: number) => {
    const v = new Vector3(x, y, 0).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: (v.x * 0.5 + 0.5) * r.width, y: (-v.y * 0.5 + 0.5) * r.height };
  };
  return {
    player: at(playerPos.x, playerPos.y + 1),
    stall: stall.visible ? at(stall.position.x, stall.position.y + 1) : null,
    chestStackVisible: chestStack.visible,
  };
};

(window as unknown as { __rugState: () => unknown }).__rugState = () => ({
  viewCols,
  viewDist,
  aspect: camera.aspect,
  cam: camPos.toArray(),
  player: playerPos.toArray(),
  curCol,
  tick: curCol - PRELUDE,
  npcs: npcs.length,
  holding,
  sold,
  cracks: crackCount,
  stallX: stallPos.x,
  fx: sparks.filter((sp) => sp.mesh.visible).length,
  ringsActive: rings.filter((r) => r.mesh.visible).length,
  pops: pops.length,
  audio: audio.stats(),
  sceneChildren: scene.children.length,
  activity,
  fovKick,
  clock: { ...clockState },
  inner: [window.innerWidth, window.innerHeight],
  pixelRatio,
  frames: frameCount,
  frameMs: Math.round(frameMs * 10) / 10,
  blocks: world ? world.blocks.count : 0,
  drawCalls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
});

post({ type: 'READY' });
