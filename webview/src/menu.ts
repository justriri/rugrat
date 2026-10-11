// RUGRAT menu scene: ONE voxel village, seen two ways.
//   HOME    a low camera at the village gate: the RUGRAT wordmark over the rooftops, Rugrat and the
//           crowd in the foreground, a rug being pulled out from under a few unlucky villagers.
//   WORLDS  the camera lifts over the same village: four sectors along the road, each with its own
//           trade building (dome / tower / barn / vault) carrying that rug's real logo. Selecting a
//           sector flies the camera to it.
// It is told which worlds exist and which is selected (menuProtocol.ts); it knows nothing about
// replays' clocks, trading or scores. Each building's look comes from its rug TYPE.
//
// Performance rules: static scenery is a handful of merged, vertex-coloured meshes; a walking
// character is 3 draw calls; no shadows, no post-processing; ~30 fps cap; DPR <= 1.5; rendering
// stops while the screen is paused or hidden.
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';

import type { MenuHostEnvelope, MenuHostMessage, MenuMode, MenuWebMessage, MenuWorld } from '../../src/bridge/menuProtocol';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    __menu?: {
      render(): void;
      info(): { calls: number; triangles: number; geometries: number };
      send(m: MenuHostMessage): void;
      screenOf(id: string): { x: number; y: number } | null;
    };
  }
}

const post = (m: MenuWebMessage) => window.ReactNativeWebView?.postMessage(JSON.stringify(m));
const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------- renderer / scene
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
const scene = new Scene();
const SKY = '#8fd6ff';
scene.background = new Color(SKY);
scene.fog = new Fog('#cfeeff', 45, 110);
scene.add(new HemisphereLight(0xffffff, 0x7a8a62, 1.15));
scene.add(new AmbientLight(0xffffff, 0.22));
const sun = new DirectionalLight(0xfff0d0, 1.55);
sun.position.set(-10, 16, 12);
scene.add(sun);
const camera = new PerspectiveCamera(50, 1, 0.1, 220);

// ---------------------------------------------------------------- voxel helpers
interface Spec { x: number; y: number; z: number; w: number; h: number; d: number; c: string }
const FACES = [
  { n: [1, 0, 0], v: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
  { n: [-1, 0, 0], v: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
  { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
];
const tmpColor = new Color();
/** Many boxes -> ONE geometry with vertex colours (one draw call). */
function merge(specs: Spec[]): BufferGeometry {
  const pos = new Float32Array(specs.length * 24 * 3);
  const nor = new Float32Array(specs.length * 24 * 3);
  const col = new Float32Array(specs.length * 24 * 3);
  const idx = new Uint32Array(specs.length * 36);
  let p = 0;
  let vi = 0;
  let ii = 0;
  for (const s of specs) {
    tmpColor.set(s.c);
    const j = 1 + (hash(s.x * 7.3 + s.z, s.y * 5.1 + s.x) - 0.5) * 0.09; // slight per-block shade, like voxel texture
    for (const f of FACES) {
      for (const v of f.v) {
        pos[p] = s.x + v[0] * s.w;
        pos[p + 1] = s.y + v[1] * s.h;
        pos[p + 2] = s.z + v[2] * s.d;
        nor[p] = f.n[0];
        nor[p + 1] = f.n[1];
        nor[p + 2] = f.n[2];
        col[p] = Math.min(1, tmpColor.r * j);
        col[p + 1] = Math.min(1, tmpColor.g * j);
        col[p + 2] = Math.min(1, tmpColor.b * j);
        p += 3;
      }
      idx.set([vi, vi + 1, vi + 2, vi, vi + 2, vi + 3], ii);
      vi += 4;
      ii += 6;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
const box = (x: number, y: number, z: number, w: number, h: number, d: number, c: string): Spec => ({ x, y, z, w, h, d, c });
const vcMat = new MeshLambertMaterial({ vertexColors: true });
const vcMesh = (specs: Spec[], parent?: Object3D) => {
  const m = new Mesh(merge(specs), vcMat);
  parent?.add(m);
  return m;
};

const unit = new BoxGeometry(1, 1, 1);
const matCache = new Map<string, MeshLambertMaterial>();
const lam = (c: string, emissive?: string) => {
  const k = c + (emissive ?? '');
  let m = matCache.get(k);
  if (!m) {
    m = new MeshLambertMaterial({ color: c });
    if (emissive) m.emissive = new Color(emissive);
    matCache.set(k, m);
  }
  return m;
};
function coin(): Mesh {
  const m = new Mesh(new CylinderGeometry(0.28, 0.28, 0.1, 10), lam('#f7c53b', '#7a5600'));
  m.rotation.x = Math.PI / 2;
  return m;
}

// ---------------------------------------------------------------- characters
interface Chr { group: Group; body: Group; legL: Group; legR: Group; armL: Group | null; armR: Group | null }
interface Look { shirt: string; pants: string; skin: string; hat?: string; rat?: boolean; gold?: boolean; apron?: string; beard?: string; robe?: boolean }
function torsoSpecs(look: Look): Spec[] {
  const t: Spec[] = [
    box(0, 0.9, 0, 0.7, 0.7, 0.4, look.shirt),
    box(0, 1.5, 0, 0.5, 0.5, 0.5, look.skin),
    box(-0.12, 1.55, 0.26, 0.1, 0.12, 0.04, '#1b1b22'),
    box(0.12, 1.55, 0.26, 0.1, 0.12, 0.04, '#1b1b22'),
    box(0, 1.38, 0.26, 0.2, 0.05, 0.04, '#7a3b2e'),
  ];
  if (look.robe) t.push(box(0, 0.45, 0, 0.78, 0.9, 0.46, look.shirt));
  if (look.apron) t.push(box(0, 0.85, 0.22, 0.5, 0.6, 0.05, look.apron));
  if (look.gold) t.push(box(0, 0.9, 0.21, 0.5, 0.5, 0.04, '#f7c53b'));
  if (look.beard) t.push(box(0, 1.3, 0.27, 0.34, 0.2, 0.06, look.beard));
  if (look.hat) t.push(box(0, 1.82, 0, 0.58, 0.16, 0.58, look.hat), box(0, 1.95, 0, 0.36, 0.14, 0.36, look.hat));
  if (look.rat) {
    t.push(
      box(-0.24, 1.86, -0.02, 0.2, 0.2, 0.1, '#9aa0a6'), box(0.24, 1.86, -0.02, 0.2, 0.2, 0.1, '#9aa0a6'),
      box(-0.24, 1.86, 0.04, 0.11, 0.11, 0.06, '#f2a6b8'), box(0.24, 1.86, 0.04, 0.11, 0.11, 0.06, '#f2a6b8'),
      box(0, 1.46, 0.28, 0.12, 0.09, 0.08, '#f2a6b8'),
      box(-0.38, 1.44, 0.26, 0.3, 0.02, 0.02, '#f4f1e8'), box(0.38, 1.44, 0.26, 0.3, 0.02, 0.02, '#f4f1e8'),
      box(0, 0.45, -0.45, 0.12, 0.12, 0.5, '#f2a6b8'), box(0, 0.55, -0.85, 0.12, 0.12, 0.4, '#f2a6b8'), box(0, 0.7, -1.15, 0.12, 0.12, 0.3, '#f2a6b8'),
    );
  }
  return t;
}
const shadowGeo = new PlaneGeometry(1, 1);
const shadowMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
/** The hero: 5 draw calls (body, two legs, two swinging arms). */
function makeHero(look: Look): Chr {
  const group = new Group();
  const body = new Group();
  group.add(body);
  body.add(vcMesh(torsoSpecs(look)));
  const mk = (x: number, y: number, spec: Spec) => {
    const g = new Group();
    g.position.set(x, y, 0);
    g.add(vcMesh([spec]));
    body.add(g);
    return g;
  };
  const legL = mk(-0.17, 0.55, box(0, -0.275, 0, 0.28, 0.55, 0.3, look.pants));
  const legR = mk(0.17, 0.55, box(0, -0.275, 0, 0.28, 0.55, 0.3, look.pants));
  const armL = mk(-0.46, 1.25, box(0, -0.3, 0, 0.2, 0.6, 0.25, look.skin));
  const armR = mk(0.46, 1.25, box(0, -0.3, 0, 0.2, 0.6, 0.25, look.skin));
  const sh = new Mesh(shadowGeo, shadowMat);
  sh.rotation.x = -Math.PI / 2;
  sh.scale.set(0.9, 0.7, 1);
  sh.position.y = 0.03;
  group.add(sh);
  return { group, body, legL, legR, armL, armR };
}
/** A villager: 3 draw calls (body with static arms, two legs). */
function makeWalker(look: Look): Chr {
  const group = new Group();
  const body = new Group();
  group.add(body);
  const t = torsoSpecs(look);
  t.push(box(-0.46, 0.95, 0, 0.2, 0.6, 0.25, look.skin), box(0.46, 0.95, 0, 0.2, 0.6, 0.25, look.skin));
  body.add(vcMesh(t));
  const legL = new Group();
  const legR = new Group();
  legL.position.set(-0.17, 0.55, 0);
  legR.position.set(0.17, 0.55, 0);
  legL.add(vcMesh([box(0, -0.275, 0, 0.28, 0.55, 0.3, look.pants)]));
  legR.add(vcMesh([box(0, -0.275, 0, 0.28, 0.55, 0.3, look.pants)]));
  body.add(legL, legR);
  return { group, body, legL, legR, armL: null, armR: null };
}
function walkPose(c: Chr, t: number, amount = 1) {
  const s = Math.sin(t) * 0.7 * amount;
  c.legL.rotation.x = s;
  c.legR.rotation.x = -s;
  if (c.armL && c.armR) {
    c.armL.rotation.x = -s * 0.8;
    c.armR.rotation.x = s * 0.8;
  }
  c.body.position.y = Math.abs(Math.sin(t)) * 0.06 * amount;
}

// ---------------------------------------------------------------- village layout
const GX0 = -9;
const GX1 = 9;
const GZ0 = -28;
const GZ1 = 9;
/** The four trade sectors, along a winding road, alternating left and right. */
const SECTORS = [
  { x: -4.8, z: -3.5 },
  { x: 4.8, z: -10.5 },
  { x: -4.8, z: -17 },
  { x: 4.8, z: -23.5 },
];
const PLAZA = { x: 0, z: -7 };
const pathX = (z: number) => 1.5 * Math.sin((z + 4) / 4.2);
const nearSector = (x: number, z: number, r: number) => SECTORS.some((s) => Math.hypot(x - s.x, z - s.z) < r);

function groundSpecs(): Spec[] {
  const s: Spec[] = [];
  for (let x = GX0 + 0.5; x < GX1; x += 1) {
    for (let z = GZ0 + 0.5; z < GZ1; z += 1) {
      const chk = (Math.floor(x) + Math.floor(z)) & 1;
      let c = chk ? '#6fb85a' : '#62a84f';
      const onRoad = Math.abs(x - pathX(z)) < 1.15;
      const onPlaza = Math.hypot(x - PLAZA.x, z - PLAZA.z) < 3.4;
      const onSide = SECTORS.some((sec) => {
        const zz = sec.z + 3.3;
        const x0 = Math.min(pathX(zz), sec.x);
        const x1 = Math.max(pathX(zz), sec.x);
        return Math.abs(z - zz) < 0.6 && x > x0 - 0.3 && x < x1 + 0.3;
      });
      const onPad = SECTORS.some((sec) => Math.abs(x - sec.x) < 3.1 && Math.abs(z - sec.z) < 2.7);
      if (onPlaza) c = chk ? '#cfc8b4' : '#bdb6a2';
      else if (onRoad || onSide) c = chk ? '#dcc796' : '#cdb882';
      else if (onPad) c = chk ? '#e4dcc0' : '#d8cfae';
      s.push(box(x, -0.2, z, 1, 0.4, 1, c));
    }
  }
  // the village floats: a tapering underside
  const cx = (GX0 + GX1) / 2;
  const cz = (GZ0 + GZ1) / 2;
  for (let k = 0; k < 4; k++) {
    const inset = k * 1.5;
    s.push(box(cx, -0.85 - k * 1.0, cz, GX1 - GX0 - inset * 2, 1.0, GZ1 - GZ0 - inset * 2, k < 2 ? '#8a5a2e' : '#6e6a70'));
  }
  return s;
}

// -- small scenery builders (all return specs) --
const fence = (x0: number, z0: number, x1: number, z1: number): Spec[] => {
  const s: Spec[] = [];
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len / 0.8));
  for (let i = 0; i <= n; i++) s.push(box(lerp(x0, x1, i / n), 0.35, lerp(z0, z1, i / n), 0.12, 0.7, 0.12, '#8a5a2e'));
  const horiz = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
  s.push(box((x0 + x1) / 2, 0.5, (z0 + z1) / 2, horiz ? len : 0.07, 0.1, horiz ? 0.07 : len, '#a8743c'));
  return s;
};
const tree = (x: number, z: number, v = 0): Spec[] => {
  if (v % 3 === 2) {
    return [box(x, 0.5, z, 0.3, 1.0, 0.3, '#6b4a2a'), box(x, 1.4, z, 1.3, 0.7, 1.3, '#2f7a45'), box(x, 2.0, z, 0.9, 0.6, 0.9, '#3a8c50'), box(x, 2.5, z, 0.45, 0.5, 0.45, '#47a05c')];
  }
  return [box(x, 0.6, z, 0.32, 1.2, 0.32, '#6b4a2a'), box(x, 1.55, z, 1.2, 1.0, 1.2, '#3f9c4a'), box(x, 2.3, z, 0.75, 0.6, 0.75, '#52b85c')];
};
const house = (x: number, z: number, w: number, d: number, wall: string, roof: string): Spec[] => {
  const s: Spec[] = [box(x, 0.8, z, w, 1.6, d, wall)];
  for (let k = 0; k < 3; k++) s.push(box(x, 1.75 + k * 0.4, z, w + 0.3 - k * (w * 0.32), 0.4, d + 0.3, roof));
  s.push(box(x, 0.55, z + d / 2 + 0.02, 0.5, 1.1, 0.05, '#5a3a1c'));
  s.push(box(x - w / 2 + 0.55, 0.95, z + d / 2 + 0.02, 0.4, 0.4, 0.05, '#8fd6ff'), box(x + w / 2 - 0.55, 0.95, z + d / 2 + 0.02, 0.4, 0.4, 0.05, '#8fd6ff'));
  s.push(box(x + w / 4, 2.7, z - d / 4, 0.3, 0.7, 0.3, '#7a3b2e'));
  return s;
};
const church = (x: number, z: number): Spec[] => {
  const s: Spec[] = [box(x, 1.1, z, 2.6, 2.2, 3.4, '#f1ecdd')];
  for (let k = 0; k < 4; k++) s.push(box(x, 2.35 + k * 0.4, z, 3.0 - k * 0.7, 0.4, 3.7, '#9c4a3a'));
  s.push(box(x, 2.0, z + 2.2, 1.4, 4.0, 1.4, '#f1ecdd'));
  for (let k = 0; k < 4; k++) s.push(box(x, 4.2 + k * 0.45, z + 2.2, 1.6 - k * 0.4, 0.45, 1.6 - k * 0.4, '#7a3b2e'));
  s.push(box(x, 6.2, z + 2.2, 0.12, 0.9, 0.12, '#f7c53b'), box(x, 6.35, z + 2.2, 0.5, 0.12, 0.12, '#f7c53b'));
  s.push(box(x, 0.7, z + 2.93, 0.7, 1.4, 0.05, '#5a3a1c'), box(x, 3.1, z + 2.93, 0.45, 0.7, 0.05, '#4aa3ff'));
  s.push(box(x - 1.32, 1.3, z - 0.3, 0.05, 0.8, 0.5, '#4aa3ff'), box(x + 1.32, 1.3, z - 0.3, 0.05, 0.8, 0.5, '#4aa3ff'));
  return s;
};
const barn = (x: number, z: number): Spec[] => {
  const s: Spec[] = [box(x, 1.1, z, 3.2, 2.2, 2.6, '#b8372c')];
  for (let k = 0; k < 3; k++) s.push(box(x, 2.4 + k * 0.45, z, 3.5 - k * 0.9, 0.45, 2.9, '#6a3a2a'));
  s.push(box(x, 0.8, z + 1.31, 1.2, 1.6, 0.05, '#fff4dc'), box(x, 0.8, z + 1.34, 1.3, 0.1, 0.03, '#8a1f18'));
  s.push(box(x - 0.45, 0.8, z + 1.34, 0.1, 1.6, 0.03, '#8a1f18'), box(x + 0.45, 0.8, z + 1.34, 0.1, 1.6, 0.03, '#8a1f18'));
  return s;
};
const cropRows = (x: number, z: number): Spec[] => {
  const s: Spec[] = [];
  for (let r = 0; r < 4; r++) {
    s.push(box(x, 0.08, z + r * 0.75, 3.0, 0.16, 0.5, '#6a4a2a'));
    for (let i = 0; i < 8; i++) s.push(box(x - 1.3 + i * 0.37, 0.4, z + r * 0.75, 0.26, 0.5 + hash(i, r) * 0.25, 0.26, r % 2 ? '#e7c93a' : '#4fb55a'));
  }
  return s;
};
const scarecrow = (x: number, z: number): Spec[] => [
  box(x, 0.9, z, 0.12, 1.8, 0.12, '#6b4a2a'), box(x, 1.3, z, 1.2, 0.12, 0.12, '#6b4a2a'),
  box(x, 1.1, z, 0.5, 0.6, 0.3, '#c0392b'), box(x, 1.75, z, 0.4, 0.4, 0.4, '#f2c9a0'), box(x, 2.02, z, 0.6, 0.12, 0.6, '#6b4a2a'),
];
const haystack = (x: number, z: number): Spec[] => [box(x, 0.35, z, 0.9, 0.7, 0.9, '#e7c93a'), box(x, 0.85, z, 0.6, 0.4, 0.6, '#f0d868')];
const well = (x: number, z: number): Spec[] => [
  box(x, 0.35, z, 1.1, 0.7, 1.1, '#9aa0a6'), box(x, 0.72, z, 0.7, 0.06, 0.7, '#3a8de0'),
  box(x - 0.5, 1.2, z, 0.1, 1.0, 0.1, '#6b4a2a'), box(x + 0.5, 1.2, z, 0.1, 1.0, 0.1, '#6b4a2a'),
  box(x, 1.8, z, 1.4, 0.14, 0.9, '#a8743c'), box(x, 1.95, z, 1.0, 0.14, 0.6, '#a8743c'),
];
const lamp = (x: number, z: number): Spec[] => [box(x, 0.9, z, 0.1, 1.8, 0.1, '#3b3b46'), box(x, 1.9, z, 0.3, 0.3, 0.3, '#ffe27a')];
const stall = (x: number, z: number): Spec[] => {
  const s: Spec[] = [box(x, 0.45, z, 1.7, 0.9, 0.8, '#8a5a2e'), box(x - 0.8, 1.45, z - 0.3, 0.12, 1.1, 0.12, '#5a3a1c'), box(x + 0.8, 1.45, z - 0.3, 0.12, 1.1, 0.12, '#5a3a1c')];
  for (let i = 0; i < 6; i++) s.push(box(x - 0.85 + i * 0.34 + 0.17, 2.05, z - 0.05, 0.34, 0.14, 1.1, i % 2 ? '#fff4dc' : '#e5483f'));
  s.push(box(x - 0.45, 1.02, z + 0.1, 0.3, 0.14, 0.3, '#4fd35f'), box(x + 0.35, 1.02, z + 0.1, 0.3, 0.14, 0.3, '#f7c53b'));
  return s;
};
const fountain = (x: number, z: number): Spec[] => [
  box(x, 0.3, z, 2.4, 0.6, 2.4, '#9aa0a6'), box(x, 0.62, z, 2.0, 0.08, 2.0, '#4aa3ff'),
  box(x, 1.1, z, 0.4, 1.0, 0.4, '#cfc8b4'), box(x, 1.7, z, 0.9, 0.18, 0.9, '#cfc8b4'), box(x, 1.95, z, 0.3, 0.3, 0.3, '#4aa3ff'),
];
const warningSign = (x: number, z: number): Spec[] => [
  box(x, 0.4, z, 0.1, 0.8, 0.1, '#6b4a2a'), box(x, 0.95, z, 0.75, 0.6, 0.1, '#f7c53b'),
  box(x, 1.02, z + 0.06, 0.1, 0.3, 0.04, '#1b1b22'), box(x, 0.82, z + 0.06, 0.1, 0.09, 0.04, '#1b1b22'),
];
const cloudSpecs = (): Spec[] => {
  const s: Spec[] = [];
  for (let i = 0; i < 5; i++) s.push(box(i * 0.9 - 1.8, hash(i, 2) * 0.5, hash(i, 4) * 0.6, 1.1 + hash(i, 6) * 0.5, 0.7, 1.0, '#ffffff'));
  return s;
};

// -- the trade buildings: the look comes from the rug TYPE, never from the token --
interface Trade { specs: Spec[]; emblemY: number; emblemZ: number; flag: string; pole: number }
function dome(cx: number, cz: number, y0: number, R: number, layers: number, a: string, b: string): Spec[] {
  const s: Spec[] = [];
  const cell = 0.5;
  for (let k = 0; k < layers; k++) {
    const r = R * Math.sqrt(Math.max(0.05, 1 - Math.pow((k + 0.5) / layers, 2)));
    const n = Math.ceil(r / cell);
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * cell;
        const z = iz * cell;
        if (Math.hypot(x, z) > r) continue;
        s.push(box(cx + x, y0 + k * cell + cell / 2, cz + z, cell, cell, cell, (ix + iz + k) & 1 ? a : b));
      }
    }
  }
  return s;
}
function tradeBuilding(type: string, cx: number, cz: number): Trade {
  const s: Spec[] = [box(cx, 0.12, cz, 5.4, 0.24, 5.0, '#cfc8b4')];
  if (type === 'FAST_DUMP') {
    // a brick tower with a battlement top, TNT and warning signs
    s.push(box(cx, 2.2, cz - 0.2, 3.4, 4.0, 3.2, '#a2452e'));
    for (let i = 0; i < 4; i++) s.push(box(cx, 0.6 + i * 1.0, cz - 0.2 + 1.62, 3.5, 0.18, 0.04, '#8e3a28'));
    for (let i = 0; i < 4; i++) s.push(box(cx - 1.3 + i * 0.87, 4.45, cz + 1.2, 0.55, 0.5, 0.5, '#8e3a28'), box(cx - 1.3 + i * 0.87, 4.45, cz - 1.6, 0.55, 0.5, 0.5, '#8e3a28'));
    s.push(box(cx, 0.9, cz + 1.44, 1.0, 1.7, 0.1, '#1b1b22'));
    for (const [x, z] of [[1.9, 1.4], [2.3, 0.7], [1.8, 0.1]] as const) s.push(box(cx + x, 0.55, cz + z, 0.6, 0.62, 0.6, '#e5483f'), box(cx + x, 0.55, cz + z, 0.62, 0.14, 0.62, '#fff4dc'));
    s.push(...warningSign(cx - 2.2, cz + 1.8), box(cx + 1.0, 4.9, cz - 0.2, 0.4, 0.9, 0.4, '#5a2a22'));
    return { specs: s, emblemY: 3.1, emblemZ: cz + 1.72, flag: '#e5483f', pole: 5.6 };
  }
  if (type === 'SLOW_BLEED') {
    // a long rose barn with a staircase sliding down the side
    s.push(box(cx, 1.3, cz, 4.4, 2.6, 3.2, '#c44c69'));
    for (let k = 0; k < 4; k++) s.push(box(cx, 2.8 + k * 0.45, cz, 4.8 - k * 1.1, 0.45, 3.5, '#8e3b52'));
    s.push(box(cx, 0.9, cz + 1.62, 1.1, 1.7, 0.1, '#4a1f2c'));
    for (let i = 0; i < 5; i++) s.push(box(cx + 2.7 + i * 0.35, 0.18 + (4 - i) * 0.18, cz + 0.6, 0.35, 0.36 + (4 - i) * 0.36, 1.2, i % 2 ? '#b0405c' : '#c44c69'));
    s.push(box(cx + 3.2, 0.06, cz + 2.0, 1.4, 0.1, 0.9, '#e5483f'), ...warningSign(cx - 2.6, cz + 1.9));
    return { specs: s, emblemY: 3.0, emblemZ: cz + 1.72, flag: '#f2a6b8', pole: 5.6 };
  }
  if (type === 'DEV_EXIT') {
    // a teal vault-hut with an exit door and a sack of gold
    s.push(box(cx, 1.4, cz, 3.8, 2.8, 3.2, '#4a8f86'));
    for (let k = 0; k < 4; k++) s.push(box(cx, 3.0 + k * 0.4, cz, 4.2 - k * 1.0, 0.4, 3.5, '#2e5a58'));
    s.push(box(cx, 0.9, cz + 1.62, 1.1, 1.7, 0.1, '#10161f'), box(cx + 0.55, 0.9, cz + 1.9, 0.12, 1.7, 0.6, '#5a3a1c'));
    s.push(box(cx + 1.9, 1.5, cz + 2.0, 1.0, 0.4, 0.1, '#4fd35f'), box(cx + 1.9, 0.75, cz + 2.0, 0.1, 1.5, 0.1, '#6b4a2a'));
    s.push(box(cx - 2.3, 0.5, cz + 1.6, 0.9, 1.0, 0.9, '#c9a227'), box(cx - 2.3, 1.1, cz + 1.6, 0.4, 0.3, 0.4, '#8b6b4a'));
    s.push(box(cx + 2.6, 0.4, cz - 0.8, 1.0, 0.8, 0.8, '#8b6b4a'), box(cx + 2.6, 0.85, cz - 0.8, 1.0, 0.12, 0.8, '#f7c53b'));
    return { specs: s, emblemY: 3.35, emblemZ: cz + 1.72, flag: '#9945ff', pole: 5.9 };
  }
  // UNCLASSIFIED: a golden domed hall with columns and a balance on top
  for (const [x, z] of [[-1.9, -1.7], [1.9, -1.7], [-1.9, 1.7], [1.9, 1.7]] as const) s.push(box(cx + x, 1.5, cz + z, 0.5, 2.6, 0.5, '#f4f1e8'), box(cx + x, 2.9, cz + z, 0.7, 0.2, 0.7, '#cfc8b4'));
  s.push(box(cx, 1.4, cz, 3.4, 2.4, 3.0, '#e9e2c6'), box(cx, 2.75, cz, 4.4, 0.25, 3.9, '#cfc8b4'));
  s.push(...dome(cx, cz, 2.9, 2.1, 5, '#f7d36a', '#e8be4c'));
  s.push(box(cx, 5.75, cz, 0.12, 0.9, 0.12, '#f4f1e8'), box(cx, 6.2, cz, 1.3, 0.1, 0.1, '#f7c53b'), box(cx - 0.55, 5.95, cz, 0.4, 0.06, 0.4, '#c9a227'), box(cx + 0.55, 6.05, cz, 0.4, 0.06, 0.4, '#c9a227'));
  s.push(box(cx, 0.9, cz + 1.52, 1.0, 1.7, 0.1, '#5a3a1c'));
  // the entrance gate carries the logo
  s.push(box(cx - 1.4, 1.0, cz + 2.6, 0.2, 2.0, 0.2, '#cfc8b4'), box(cx + 1.4, 1.0, cz + 2.6, 0.2, 2.0, 0.2, '#cfc8b4'));
  return { specs: s, emblemY: 2.3, emblemZ: cz + 2.6, flag: '#4aa3ff', pole: 6.7 };
}

/** The scenery that fills each sector, by slot (so the four sectors read differently). */
function sectorScenery(slot: number, cx: number, cz: number): Spec[] {
  const s: Spec[] = [];
  const out = cx < 0 ? -1 : 1; // away from the road
  if (slot % 4 === 0) {
    // the farm
    s.push(...barn(cx + out * 1.0, cz - 3.4), ...cropRows(cx - out * 0.6, cz + 4.1), ...scarecrow(cx + out * 2.6, cz + 4.6), ...haystack(cx + out * 2.6, cz - 1.8), ...haystack(cx + out * 3.4, cz - 2.6));
    s.push(...fence(cx - 2.6, cz + 3.6, cx + 2.6, cz + 3.6), ...fence(cx - 2.6, cz + 3.6, cx - 2.6, cz + 6.8));
  } else if (slot % 4 === 1) {
    // houses and a well
    s.push(...house(cx + out * 3.4, cz - 2.4, 2.2, 2.0, '#f4e3c1', '#b8372c'), ...house(cx + out * 3.6, cz + 1.6, 2.0, 1.8, '#e9d3a7', '#6a3a2a'), ...house(cx - out * 0.4, cz - 3.6, 2.4, 1.9, '#d9e6f0', '#3b5ba9'), ...well(cx - out * 2.6, cz + 3.6));
  } else if (slot % 4 === 2) {
    // the church and its garden
    s.push(...church(cx + out * 3.4, cz - 2.4), ...fence(cx + out * 1.0, cz + 2.2, cx + out * 5.8, cz + 2.2), ...house(cx - out * 0.6, cz - 3.8, 2.0, 1.8, '#f1ecdd', '#9c4a3a'));
    for (let i = 0; i < 5; i++) s.push(box(cx + out * (1.6 + i * 0.8), 0.18, cz + 3.0, 0.3, 0.36, 0.3, ['#ff6fa8', '#ffd04a', '#fff4dc', '#9945ff', '#ff9f43'][i]));
  } else {
    // the windmill (blades are animated) and a market
    s.push(box(cx + out * 3.6, 1.0, cz - 3.0, 1.8, 2.0, 1.8, '#e9d3a7'), box(cx + out * 3.6, 2.4, cz - 3.0, 1.4, 0.9, 1.4, '#d8bf8c'), box(cx + out * 3.6, 3.2, cz - 3.0, 1.0, 0.7, 1.0, '#c9a56a'), box(cx + out * 3.6, 3.8, cz - 3.0, 1.2, 0.35, 1.2, '#7a3b2e'));
    s.push(...stall(cx - out * 0.8, cz - 3.6), ...haystack(cx + out * 1.0, cz + 4.2), ...haystack(cx + out * 1.9, cz + 4.6));
  }
  return s;
}

// ---------------------------------------------------------------- the world (built on INIT)
interface World {
  data: MenuWorld;
  sector: { x: number; z: number };
  hit: Mesh;
  logoMat: MeshBasicMaterial;
  flag: Mesh;
  drips: Mesh[];
}
const worlds: World[] = [];
const village = new Group();
scene.add(village);
const wanderers: { c: Chr; ax: number; az: number; bx: number; bz: number; speed: number; ph: number }[] = [];
const talkers: { c: Chr; ph: number; baseRot: number }[] = [];
const coinsAnim: { m: Mesh; ph: number; y: number }[] = [];
const clouds: { g: Group; x: number; speed: number }[] = [];
let blades: Mesh | null = null;
let heroChr: Chr | null = null;
const homeOnly = new Group(); // wordmark: hidden in the village overview
const homeProps = new Group(); // Rugrat and the rug-pull: foreground of the HOME view only
village.add(homeOnly, homeProps);
let selFx: { group: Group; ring: Mesh; sparks: Mesh[] } | null = null;
const rugScene = { group: new Group(), carpet: null as Mesh | null, victims: [] as Chr[], puller: null as Chr | null, coins: [] as Mesh[] };

// -- logo textures --
function letterTexture(symbol: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f7c53b';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1b1b22';
  g.font = '900 64px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(symbol.slice(0, 3), 64, 68);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
function setLogo(w: World, dataUri: string) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#10161f';
    g.fillRect(0, 0, 256, 256);
    g.drawImage(img, 0, 0, 256, 256);
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    w.logoMat.map?.dispose();
    w.logoMat.map = t;
    w.logoMat.needsUpdate = true;
  };
  img.src = dataUri;
}

// -- wordmark: RUG (small) over RAT (large), on a carpet plaque with rat ears --
const GLYPH: Record<string, string[]> = {
  R: ['1111.', '1...1', '1111.', '1..1.', '1...1'],
  U: ['1...1', '1...1', '1...1', '1...1', '.111.'],
  G: ['.1111', '1....', '1.111', '1...1', '.111.'],
  A: ['.111.', '1...1', '11111', '1...1', '1...1'],
  T: ['11111', '..1..', '..1..', '..1..', '..1..'],
};
function wordSpecs(word: string, cube: number, c: string, depth: number, grow = 1.02, y0 = 0, z = 0): Spec[] {
  const s: Spec[] = [];
  const total = word.length * 6 - 1;
  for (let li = 0; li < word.length; li++) {
    const g = GLYPH[word[li]];
    for (let r = 0; r < 5; r++) {
      for (let col = 0; col < 5; col++) {
        if (g[r][col] !== '1') continue;
        s.push(box((li * 6 + col - (total - 1) / 2) * cube, y0 + (4 - r) * cube, z, cube * grow, cube * grow, depth, c));
      }
    }
  }
  return s;
}
function buildWordmark(): void {
  const ratCube = 0.44;
  const rugCube = 0.2;
  const ratY = 0;
  const rugY = 5 * ratCube + 0.5;
  const s: Spec[] = [];
  // the plaque: a red carpet with gold trim
  const pw = 15 * 6 * 0.0 + 7.9;
  const ph = rugY + 5 * rugCube + 0.7;
  s.push(box(0, ph / 2 - 0.2, -0.45, pw, ph, 0.3, '#7a1f1f'), box(0, ph / 2 - 0.2, -0.28, pw - 0.4, ph - 0.4, 0.1, '#b02a2a'));
  s.push(box(0, ph - 0.35, -0.2, pw - 0.2, 0.14, 0.12, '#f7c53b'), box(0, -0.35, -0.2, pw - 0.2, 0.14, 0.12, '#f7c53b'));
  for (let i = 0; i < 12; i++) s.push(box(-pw / 2 + 0.35 + i * ((pw - 0.7) / 11), -0.65, -0.4, 0.18, 0.55, 0.12, '#f7c53b')); // fringe
  // rat ears
  s.push(box(-2.9, ph + 0.15, -0.35, 1.0, 0.9, 0.4, '#9aa0a6'), box(2.9, ph + 0.15, -0.35, 1.0, 0.9, 0.4, '#9aa0a6'), box(-2.9, ph + 0.1, -0.12, 0.5, 0.5, 0.2, '#f2a6b8'), box(2.9, ph + 0.1, -0.12, 0.5, 0.5, 0.2, '#f2a6b8'));
  // letters: dark outline behind, bright front
  s.push(...wordSpecs('RAT', ratCube, '#4a2608', 0.5, 1.4, ratY, 0));
  s.push(...wordSpecs('RAT', ratCube, '#ffd04a', 0.5, 1.02, ratY, 0.12));
  s.push(...wordSpecs('RUG', rugCube, '#4a2608', 0.4, 1.5, rugY, 0));
  s.push(...wordSpecs('RUG', rugCube, '#fff4dc', 0.4, 1.02, rugY, 0.1));
  const m = vcMesh(s, homeOnly);
  m.position.set(0, 0, 0);
  homeOnly.position.set(0, 8.6, -1.0);
}

function build(dataWorlds: MenuWorld[]) {
  // clear
  for (const c of [...village.children]) village.remove(c);
  worlds.length = 0;
  wanderers.length = 0;
  talkers.length = 0;
  coinsAnim.length = 0;
  village.add(homeOnly, homeProps);
  homeOnly.clear();
  homeProps.clear();

  // ground and the village-wide scenery
  vcMesh(groundSpecs(), village);
  const common: Spec[] = [];
  common.push(...fountain(PLAZA.x, PLAZA.z), ...stall(-2.6, PLAZA.z + 1.4), ...stall(2.6, PLAZA.z - 1.0), ...well(2.4, 3.4));
  for (let z = 6; z > -26; z -= 5) common.push(...lamp(pathX(z) + 1.7, z), ...lamp(pathX(z - 2.5) - 1.7, z - 2.5));
  common.push(...house(-6.8, 6.2, 2.2, 2.0, '#f4e3c1', '#b8372c'), ...house(6.6, 5.6, 2.0, 1.8, '#d9e6f0', '#3b5ba9'), ...house(-1.5, -12.2, 2.0, 1.8, '#e9d3a7', '#6a3a2a'));
  // trees and flowers fill the gaps, never the roads or the sector pads
  for (let i = 0; i < 90; i++) {
    const x = GX0 + 0.8 + hash(i, 1) * (GX1 - GX0 - 1.6);
    const z = GZ0 + 0.8 + hash(i, 2) * (GZ1 - GZ0 - 1.6);
    if (Math.abs(x - pathX(z)) < 2.4 || nearSector(x, z, 5.4) || Math.hypot(x - PLAZA.x, z - PLAZA.z) < 4.6) continue;
    if (i % 4 === 0) common.push(box(x, 0.12, z, 0.2, 0.24, 0.2, ['#ff6fa8', '#ffd04a', '#fff4dc', '#9945ff', '#ff9f43'][i % 5]));
    else common.push(...tree(x, z, i));
  }
  // low hills and far mountains for depth
  for (let i = 0; i < 12; i++) {
    const x = GX0 - 1 + (i % 2 ? 0 : 0) + hash(i, 5) * 2;
    common.push(box(x - 1.2, 0.8 + hash(i, 6) * 1.2, GZ0 + 2 + i * 3, 2.4, 2.4 + hash(i, 7), 2.6, '#58a04a'));
    common.push(box(GX1 + 1.2 - hash(i, 8) * 2, 0.8 + hash(i, 9) * 1.2, GZ0 + 3 + i * 3, 2.4, 2.4 + hash(i, 3), 2.6, '#58a04a'));
  }
  for (let i = 0; i < 7; i++) {
    const h = 6 + hash(i, 11) * 6;
    const x = -24 + i * 8 + hash(i, 12) * 3;
    for (let k = 0; k < 4; k++) common.push(box(x, h * (0.15 + k * 0.2) - 4, -46, 12 - k * 2.8, h * 0.28, 8 - k * 1.6, k === 3 ? '#f4f1e8' : '#8a96b0'));
  }
  vcMesh(common, village);

  // the four trade sectors
  dataWorlds.slice(0, SECTORS.length).forEach((w, i) => {
    const sec = SECTORS[i];
    const t = tradeBuilding(w.rugType, sec.x, sec.z);
    const specs: Spec[] = [...t.specs, ...sectorScenery(i, sec.x, sec.z)];
    // the logo emblem frame and the flag pole
    specs.push(box(sec.x, t.emblemY, t.emblemZ, 2.5, 2.5, 0.16, '#1b1b22'), box(sec.x, t.emblemY - 1.38, t.emblemZ, 2.9, 0.22, 0.3, '#f7c53b'), box(sec.x, t.emblemY + 1.38, t.emblemZ, 2.9, 0.22, 0.3, '#f7c53b'));
    specs.push(box(sec.x + 2.4, t.pole / 2, sec.z - 1.7, 0.12, t.pole, 0.12, '#cfc8b4'));
    // the real chart of this rug as a roadside market board
    const bx = sec.x + (sec.x < 0 ? 3.6 : -3.6);
    const bz = sec.z + 1.0;
    specs.push(box(bx - 1.0, 0.7, bz, 0.12, 1.4, 0.12, '#6b4a2a'), box(bx + 1.0, 0.7, bz, 0.12, 1.4, 0.12, '#6b4a2a'), box(bx, 1.95, bz, 2.5, 1.5, 0.14, '#1b1b22'));
    const n = w.profile.length;
    for (let k = 0; k < n; k++) {
      const h = 0.1 + w.profile[k] * 1.1;
      specs.push(box(bx + (k - (n - 1) / 2) * 0.11, 1.25 + h / 2, bz + 0.1, 0.1, h, 0.1, w.steps[k] >= 0 ? '#4fd35f' : '#e5483f'));
    }
    vcMesh(specs, village);

    const logoMat = new MeshBasicMaterial({ map: letterTexture(w.symbol) });
    const plane = new Mesh(new PlaneGeometry(2.2, 2.2), logoMat);
    plane.position.set(sec.x, t.emblemY, t.emblemZ + 0.1);
    village.add(plane);
    const flag = new Mesh(unit, lam(t.flag));
    flag.scale.set(1.0, 0.6, 0.06);
    flag.position.set(sec.x + 2.9, t.pole - 0.4, sec.z - 1.7);
    village.add(flag);
    const drips: Mesh[] = [];
    if (w.rugType === 'SLOW_BLEED') {
      for (let k = 0; k < 3; k++) {
        const d = new Mesh(unit, lam('#e5483f'));
        d.scale.set(0.12, 0.2, 0.12);
        village.add(d);
        drips.push(d);
      }
    }
    const hit = new Mesh(new BoxGeometry(6, 7, 6), new MeshBasicMaterial());
    hit.position.set(sec.x, 3, sec.z);
    hit.visible = false;
    hit.userData.worldId = w.id;
    village.add(hit);
    worlds.push({ data: w, sector: sec, hit, logoMat, flag, drips });
  });

  // windmill blades (sector 3)
  const ws = SECTORS[3];
  const wm = new Mesh(merge([box(0, 0, 0, 0.18, 3.2, 0.1, '#f4f1e8'), box(0, 0, 0, 3.2, 0.18, 0.1, '#f4f1e8'), box(0, 0, 0.1, 0.4, 0.4, 0.2, '#6b4a2a')]), vcMat);
  wm.position.set(ws.x + (ws.x < 0 ? -1 : 1) * 3.6, 2.9, ws.z - 3.0 + 1.0);
  village.add(wm);
  blades = wm;

  // people
  const looks: Look[] = [
    { shirt: '#4aa3ff', pants: '#3b3b5a', skin: '#f2c9a0' },
    { shirt: '#9945ff', pants: '#23233a', skin: '#c99a70', hat: '#14f195' },
    { shirt: '#e5483f', pants: '#3b5ba9', skin: '#f2c9a0', hat: '#6b4a2a' },
    { shirt: '#4fd35f', pants: '#2e3a40', skin: '#c99a70' },
    { shirt: '#f0e6d2', pants: '#6a3a2a', skin: '#f2c9a0', apron: '#b8372c' },
    { shirt: '#f4f1e8', pants: '#f4f1e8', skin: '#f2c9a0', robe: true, beard: '#cfcfcf' },
    { shirt: '#c9a227', pants: '#5a3a1c', skin: '#c99a70', hat: '#e7c93a' },
  ];
  const addWalker = (li: number, ax: number, az: number, bx: number, bz: number, speed: number, scale = 0.62) => {
    const c = makeWalker(looks[li % looks.length]);
    c.group.scale.setScalar(scale);
    village.add(c.group);
    wanderers.push({ c, ax, az, bx, bz, speed, ph: hash(li, ax) * 6 });
  };
  // along the road
  addWalker(0, pathX(5), 5, pathX(-4), -4, 0.07);
  addWalker(2, pathX(-6), -6, pathX(-14), -14, 0.06);
  addWalker(3, pathX(-12), -12, pathX(-24), -24, 0.055);
  addWalker(6, pathX(-20), -20, pathX(2), 2, 0.045);
  // the farmer in the crop rows, children round the fountain, a baker by the stalls
  addWalker(6, SECTORS[0].x - 2.0, SECTORS[0].z + 4.1, SECTORS[0].x + 1.2, SECTORS[0].z + 4.1, 0.2, 0.6);
  addWalker(1, PLAZA.x + 2.2, PLAZA.z + 2.2, PLAZA.x - 2.2, PLAZA.z - 2.2, 0.16, 0.5);
  addWalker(3, PLAZA.x - 2.2, PLAZA.z + 2.2, PLAZA.x + 2.2, PLAZA.z - 2.2, 0.18, 0.5);
  // talking pairs (they face each other and gesture)
  const pair = (x: number, z: number, a: number, b: number) => {
    const A = makeWalker(looks[a % looks.length]);
    const B = makeWalker(looks[b % looks.length]);
    A.group.scale.setScalar(0.62);
    B.group.scale.setScalar(0.62);
    A.group.position.set(x - 0.5, 0, z);
    B.group.position.set(x + 0.5, 0, z);
    A.group.rotation.y = Math.PI / 2;
    B.group.rotation.y = -Math.PI / 2;
    village.add(A.group, B.group);
    talkers.push({ c: A, ph: 0, baseRot: Math.PI / 2 }, { c: B, ph: 1.7, baseRot: -Math.PI / 2 });
  };
  pair(-1.2, PLAZA.z + 3.3, 4, 5);
  pair(SECTORS[2].x + (SECTORS[2].x < 0 ? 3.2 : -3.2), SECTORS[2].z + 4.2, 1, 0);
  pair(SECTORS[1].x - 1.2, SECTORS[1].z + 3.9, 2, 6);

  // gold coins that bob around the plaza and the buildings
  const coinSpots: [number, number, number][] = [[0.9, 1.3, PLAZA.z + 1.0], [-1.0, 1.1, PLAZA.z - 0.6], [SECTORS[0].x, 1.2, SECTORS[0].z + 3.0], [SECTORS[1].x, 1.2, SECTORS[1].z + 3.0], [SECTORS[2].x, 1.2, SECTORS[2].z + 3.0], [SECTORS[3].x, 1.2, SECTORS[3].z + 3.0]];
  coinSpots.forEach(([x, y, z], i) => {
    const m = coin();
    m.position.set(x, y, z);
    village.add(m);
    coinsAnim.push({ m, ph: i * 1.1, y });
  });

  // Rugrat, and the rug that is about to be pulled
  heroChr = makeHero({ shirt: '#f08a24', pants: '#3b5ba9', skin: '#f2c9a0', rat: true, gold: false });
  heroChr.group.scale.setScalar(1.55);
  heroChr.group.position.set(-2.1, 0, 6.2);
  heroChr.group.rotation.y = 0.35;
  homeProps.add(heroChr.group);
  rugScene.group = new Group();
  rugScene.group.position.set(1.5, 0, 2.4);
  homeProps.add(rugScene.group);
  const carpet: Spec[] = [box(0, 0.06, 0, 4.2, 0.12, 2.8, '#b02a2a'), box(0, 0.13, 0, 3.6, 0.04, 2.2, '#7a1f1f'), box(0, 0.16, 0, 2.2, 0.03, 1.2, '#f7c53b')];
  for (let i = 0; i < 9; i++) carpet.push(box(-2.0 + i * 0.5, 0.06, 1.55, 0.2, 0.1, 0.35, '#f7c53b'), box(-2.0 + i * 0.5, 0.06, -1.55, 0.2, 0.1, 0.35, '#f7c53b'));
  rugScene.carpet = vcMesh(carpet, rugScene.group);
  rugScene.victims = [makeWalker(looks[0]), makeWalker(looks[3])];
  rugScene.victims.forEach((v, i) => {
    v.group.scale.setScalar(0.62);
    v.group.position.set(-0.6 + i * 1.4, 0.1, 0);
    v.group.rotation.y = 0.2 - i * 0.5;
    rugScene.group.add(v.group);
  });
  rugScene.puller = makeWalker({ shirt: '#23233a', pants: '#10161f', skin: '#c99a70', hat: '#101010' });
  rugScene.puller.group.scale.setScalar(0.66);
  rugScene.puller.group.position.set(3.4, 0, 0.2);
  rugScene.puller.group.rotation.y = -Math.PI / 2;
  rugScene.group.add(rugScene.puller.group);
  rugScene.coins = [];
  for (let i = 0; i < 4; i++) {
    const m = coin();
    m.position.set(-0.8 + i * 0.5, 0.5, 0);
    rugScene.group.add(m);
    rugScene.coins.push(m);
  }

  // clouds
  for (const c of clouds) scene.remove(c.g);
  clouds.length = 0;
  for (let i = 0; i < 5; i++) {
    const g = new Group();
    g.add(new Mesh(merge(cloudSpecs()), new MeshLambertMaterial({ vertexColors: true, fog: false, emissive: new Color('#c8d8e8') })));
    // far behind the village, above the mountains: never between the camera and a building
    g.position.set(-40 + i * 20, 16 + (i % 3) * 6, -58 - (i % 2) * 10);
    g.scale.setScalar(3.2);
    scene.add(g);
    clouds.push({ g, x: g.position.x, speed: 0.25 + i * 0.05 });
  }

  buildWordmark();

  // selection FX (one set, moved to the chosen sector)
  const fx = new Group();
  const ring = new Mesh(new RingGeometry(3.4, 3.8, 32), new MeshBasicMaterial({ color: '#f7c53b', transparent: true, opacity: 0.0, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  fx.add(ring);
  const sparks: Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const m = new Mesh(unit, new MeshBasicMaterial({ color: i % 2 ? '#fff4b0' : '#f7c53b' }));
    m.scale.setScalar(0.14 + hash(i, 1) * 0.1);
    fx.add(m);
    sparks.push(m);
  }
  fx.visible = false;
  village.add(fx);
  selFx = { group: fx, ring, sparks };
}

// ---------------------------------------------------------------- state / camera
let mode: MenuMode = 'home';
let selectedId: string | null = null;
let enterId: string | null = null;
let enterT = 0;
let paused = false;
let lastSeq = -1;
const camPos = new Vector3(0, 6, 18);
const camLook = new Vector3(0, 4, -6);
const tPos = new Vector3();
const tLook = new Vector3();

function setMode(m: MenuMode) {
  mode = m;
  homeOnly.visible = m === 'home';
  homeProps.visible = m === 'home';
  enterId = null;
  enterT = 0;
}

const clock = { t: 0, last: performance.now(), acc: 0 };
const smooth = (cur: number, target: number, dt: number, k = 6) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const sel = () => (selectedId ? worlds.find((w) => w.data.id === selectedId) ?? null : null);

function update(dt: number) {
  clock.t += dt;
  const t = clock.t;

  // camera
  const s = mode === 'worlds' ? sel() : null;
  if (mode === 'home') {
    tPos.set(Math.sin(t * 0.25) * 0.8, 8.2 + Math.sin(t * 0.33) * 0.15, 21);
    tLook.set(0, 1.9, -7);
  } else if (s) {
    const k = enterId ? smoothstep(enterT) : 0;
    // from above and from the outer side, so the sector in front never blocks the view
    tPos.set(s.sector.x * 0.75, lerp(25, 11, k), s.sector.z + lerp(15, 8, k));
    tLook.set(s.sector.x * 0.7, lerp(0.8, 1.6, k), s.sector.z + lerp(4.2, 2.0, k));
  } else {
    tPos.set(Math.sin(t * 0.2) * 0.8, 38, 12);
    tLook.set(0, 0, -11);
  }
  if (enterId) enterT = Math.min(1, enterT + dt / 0.65);
  camPos.x = smooth(camPos.x, tPos.x, dt, 2.6);
  camPos.y = smooth(camPos.y, tPos.y, dt, 2.6);
  camPos.z = smooth(camPos.z, tPos.z, dt, enterId ? 5 : 2.6);
  camLook.x = smooth(camLook.x, tLook.x, dt, 2.6);
  camLook.y = smooth(camLook.y, tLook.y, dt, 2.6);
  camLook.z = smooth(camLook.z, tLook.z, dt, 2.6);
  camera.position.copy(camPos);
  camera.lookAt(camLook);

  // the wordmark bobs
  homeOnly.position.y = 8.6 + Math.sin(t * 1.3) * 0.15;
  homeOnly.rotation.y = Math.sin(t * 0.5) * 0.06;

  // Rugrat: waves, breathes
  if (heroChr) {
    heroChr.body.position.y = Math.sin(t * 2.2) * 0.03;
    if (heroChr.armR) {
      heroChr.armR.rotation.z = -2.6 + Math.sin(t * 5.5) * 0.35;
      heroChr.armR.rotation.x = 0;
    }
    if (heroChr.armL) heroChr.armL.rotation.x = Math.sin(t * 2.2) * 0.08;
    heroChr.group.rotation.y = 0.35 + Math.sin(t * 0.7) * 0.15;
  }

  // the rug-pull, on a 7 second loop
  const cyc = (t % 7) / 7;
  const yank = clamp01((cyc - 0.5) / 0.08); // 0.5..0.58: the pull
  const recover = clamp01((cyc - 0.72) / 0.2);
  const pull = smoothstep(yank) * (1 - smoothstep(recover));
  if (rugScene.carpet) rugScene.carpet.position.x = pull * 3.2;
  rugScene.victims.forEach((v, i) => {
    v.group.position.x = -0.6 + i * 1.4 + pull * 0.7;
    v.group.position.y = 0.1 + Math.max(0, Math.sin(pull * Math.PI)) * 0.8 + Math.sin(t * 2 + i) * 0.02;
    v.group.rotation.z = (i ? 1 : -1) * pull * 1.1;
    walkPose(v, t * 1.2 + i, 0.15);
  });
  if (rugScene.puller) {
    rugScene.puller.group.position.x = 3.4 + pull * 3.0;
    rugScene.puller.group.rotation.z = -pull * 0.35;
    walkPose(rugScene.puller, t * 6, pull > 0.05 && pull < 0.95 ? 1.2 : 0.1);
  }
  rugScene.coins.forEach((m, i) => {
    const air = pull * (1 - pull) * 4;
    m.position.set(-0.8 + i * 0.5 + pull * (1.2 + i * 0.5), 0.5 + air * (1.4 + i * 0.3) + Math.abs(Math.sin(t * 3 + i)) * 0.08, (i - 1.5) * 0.35);
    m.rotation.y = t * 3 + i;
  });

  // people
  for (const w of wanderers) {
    const dx = w.bx - w.ax;
    const dz = w.bz - w.az;
    const len = Math.hypot(dx, dz) || 1;
    const period = len / (w.speed * 8);
    const u = ((t + w.ph * 3) % (period * 2)) / period; // 0..2
    const f = u < 1 ? u : 2 - u;
    w.c.group.position.set(lerp(w.ax, w.bx, f), 0, lerp(w.az, w.bz, f));
    const ang = Math.atan2(dx, dz);
    w.c.group.rotation.y = u < 1 ? ang : ang + Math.PI;
    walkPose(w.c, t * 7 + w.ph);
  }
  for (const k of talkers) {
    k.c.body.position.y = Math.abs(Math.sin(t * 3 + k.ph)) * 0.05;
    k.c.group.rotation.y = k.baseRot + Math.sin(t * 1.4 + k.ph) * 0.15;
    k.c.body.rotation.z = Math.sin(t * 4 + k.ph) * 0.06;
  }
  for (const c of coinsAnim) {
    c.m.position.y = c.y + Math.sin(t * 2 + c.ph) * 0.12;
    c.m.rotation.y = t * 2.2 + c.ph;
  }
  if (blades) blades.rotation.z = t * 0.9;
  for (const w of worlds) {
    const isSel = w.data.id === selectedId;
    w.flag.rotation.y = Math.sin(t * (isSel ? 5 : 2) + w.sector.z) * 0.35;
    w.drips.forEach((d, i) => {
      const u = (t * 0.7 + i * 0.33) % 1;
      d.position.set(w.sector.x + 2.9 + i * 0.35, 1.7 - u * 1.6, w.sector.z + 1.3);
      d.visible = u < 0.95;
    });
  }
  for (const c of clouds) {
    c.x += c.speed * dt;
    if (c.x > 56) c.x = -56;
    c.g.position.x = c.x;
  }

  // selection FX
  if (selFx) {
    const s2 = mode === 'worlds' ? sel() : null;
    selFx.group.visible = !!s2;
    if (s2) {
      selFx.group.position.set(s2.sector.x, 0, s2.sector.z);
      (selFx.ring.material as MeshBasicMaterial).opacity = 0.55 + Math.sin(t * 3) * 0.2;
      selFx.sparks.forEach((m, i) => {
        const a = t * 0.9 + i * 1.05;
        m.position.set(Math.cos(a) * 3.2, 0.6 + ((t * 0.5 + i * 0.17) % 1) * 3.4, Math.sin(a) * 2.6);
        m.rotation.y = a;
      });
    }
  }
}

function resize() {
  const w = window.innerWidth || 390;
  const h = window.innerHeight || 800;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = camera.aspect < 0.7 ? 58 : 46; // narrow screens need a wider view
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function frame(now: number) {
  requestAnimationFrame(frame);
  if (paused || document.hidden) {
    clock.last = now;
    return;
  }
  const dt = Math.min(0.05, (now - clock.last) / 1000);
  clock.acc += dt;
  clock.last = now;
  if (clock.acc < 1 / 32) return; // ~30 fps is plenty for a menu
  const step = clock.acc;
  clock.acc = 0;
  update(step);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- input
const ray = new Raycaster();
const ndc = new Vector2();
let down: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || mode !== 'worlds') {
    down = null;
    return;
  }
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  down = null;
  if (Math.abs(dx) > 50 && Math.abs(dy) < 60) {
    post({ type: 'SWIPE', dir: dx < 0 ? 1 : -1 });
    return;
  }
  if (Math.hypot(dx, dy) > 14) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects(worlds.map((w) => w.hit), false);
  if (hits.length) post({ type: 'WORLD_TAPPED', id: hits[0].object.userData.worldId as string });
});

// ---------------------------------------------------------------- bridge
function handle(msg: MenuHostMessage) {
  switch (msg.type) {
    case 'INIT':
      build(msg.worlds);
      setMode(msg.mode);
      break;
    case 'MODE':
      setMode(msg.mode);
      if (msg.mode === 'worlds') selectedId = null;
      break;
    case 'SELECT':
      selectedId = msg.id;
      break;
    case 'LOGO': {
      const w = worlds.find((x) => x.data.id === msg.id);
      if (w) setLogo(w, msg.dataUri);
      break;
    }
    case 'ENTER':
      enterId = msg.id;
      enterT = 0;
      break;
    case 'PAUSE':
      paused = msg.paused;
      break;
  }
}
function onRaw(event: Event) {
  const data = (event as MessageEvent).data;
  if (typeof data !== 'string') return;
  let env: MenuHostEnvelope;
  try {
    env = JSON.parse(data) as MenuHostEnvelope;
  } catch {
    return;
  }
  if (typeof env.seq !== 'number' || env.seq <= lastSeq) return;
  lastSeq = env.seq;
  handle(env.msg);
}
document.addEventListener('message', onRaw);
window.addEventListener('message', onRaw);
window.addEventListener('error', (e) => post({ type: 'ERROR', message: String(e.message) }));

window.__menu = {
  render: () => {
    update(0.05);
    renderer.render(scene, camera);
  },
  info: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries }),
  send: handle,
  screenOf: (id) => {
    const w = worlds.find((x) => x.data.id === id);
    if (!w) return null;
    camera.updateMatrixWorld();
    const v = new Vector3(w.sector.x, 2.2, w.sector.z + 1.5).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
  },
};
setMode('home');
requestAnimationFrame(frame);
post({ type: 'READY' });
