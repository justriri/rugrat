import { parseReplay } from '../game/timeline';

// Deterministic fake rug, kept as a development fallback. Same contract as real data:
// one tick per minute starting at an arbitrary epoch. Only relative moves matter.
const T0 = 1_700_000_000;
const PRICES = [
  1.0, 1.1, 1.2, 1.15, 1.3, 1.45, 1.4, 1.62, 1.85, 1.8, 2.05, 2.4, 2.3, 2.75, 3.1, 2.95, 3.4, 3.3,
  3.45, 3.2, 3.35, 3.1, 3.0, 3.05, 2.9,
  // collapse
  1.6, 0.7, 0.3, 0.14, 0.1, 0.09, 0.085,
];
const at = (minute: number) => T0 + minute * 60;

export const demoReplay = parseReplay({
  id: 'demo-rug',
  token: 'DEMO',
  name: 'Demo Rug (synthetic)',
  symbol: 'DEMO',
  mint: 'SYNTHETIC-DEMO-NOT-A-REAL-MINT',
  logoUrl: null,
  logoSource: null,
  rugType: 'UNCLASSIFIED',
  date: '2023-11-14',
  replayStart: at(0),
  replayEnd: at(PRICES.length - 1),
  signal: {
    tag: 'SMART',
    action: 'SELL',
    minUsd: 500_000,
    description: 'Synthetic: the first SMART SELL of at least $500,000.',
  },
  collapseReason: 'Synthetic: the first tick of the scripted collapse.',
  source: 'synthetic demo data',
  ticks: PRICES.map((p, i) => ({ timestamp: at(i), price: +(p * 0.001).toFixed(6) })),
  events: [
    { id: 'demo-1', timestamp: at(3), wallet: '4kTz...Qm2d', tag: 'WHALE', action: 'BUY', amount: 6.5, amountUnit: 'USD' },
    { id: 'demo-2', timestamp: at(6), wallet: '9bXe...L7vA', tag: 'SMART', action: 'BUY', amount: 3.1 },
    { id: 'demo-3', timestamp: at(11), wallet: '7xKq...9fPz', tag: 'DEV', action: 'SUPPLY_MOVE', amount: 18.0 },
    { id: 'demo-4', timestamp: at(14), wallet: '2mRf...d8Uc', tag: 'INSIDER', action: 'BUY', amount: 1.8 },
    { id: 'demo-5', timestamp: at(16), wallet: '9bXe...L7vA', tag: 'SMART', action: 'SELL', amount: 540_000, amountUnit: 'USD' },
    { id: 'demo-6', timestamp: at(19), wallet: '5hNw...a3Kj', tag: 'INSIDER', action: 'SELL', amount: 4.2 },
    { id: 'demo-7', timestamp: at(21), wallet: '4kTz...Qm2d', tag: 'WHALE', action: 'SELL', amount: 9.7 },
    { id: 'demo-8', timestamp: at(24), wallet: '7xKq...9fPz', tag: 'DEV', action: 'SUPPLY_MOVE', amount: 31.0 },
    { id: 'demo-9', timestamp: at(25), wallet: '7xKq...9fPz', tag: 'DEV', action: 'LIQUIDITY_REMOVAL', amount: 58.4 },
  ],
  rugTimestamp: at(25),
  // 80x: one historical minute every 0.75 s, the same feel as before.
  playbackSpeed: 80,
  // synthetic prices are in arbitrary units, so 1 paper SOL = 1 unit
  paperSolUsd: 1,
});
