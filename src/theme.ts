import { Platform } from 'react-native';

export const colors = {
  bg: '#141b24',
  panel: '#1f2a37',
  panelEdge: '#0c1118',
  text: '#f4f1e8',
  muted: '#8b97a6',
  green: '#4fd35f',
  greenDark: '#2d8a3a',
  red: '#e5483f',
  redDark: '#9c2a24',
  gold: '#f7c53b',
  blue: '#4aa3ff',
};

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function fmtSol(n: number): string {
  return n.toFixed(2);
}

export function fmtPrice(p: number): string {
  return p.toPrecision(4);
}

export function fmtPct(p: number): string {
  return `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;
}
