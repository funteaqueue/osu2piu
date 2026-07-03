// JS mirror of the engine's metrics.py — computed live from the edited
// notes so the compare table updates as you edit.
import { SongTiming } from './timing';
import type { Note } from './types';

export interface Metrics {
  peakNps: number | null;
  avgNps: number | null;
  p95Nps: number | null;
  fastShare: number | null;
  holdShare: number | null;
  jumpShare: number | null;
  travel: number | null;
  steps: number;
}

export const METRIC_LABELS: [keyof Metrics, string][] = [
  ['peakNps', 'peak density'],
  ['avgNps', 'sustained (active)'],
  ['p95Nps', 'p95 speed'],
  ['fastShare', 'fast steps'],
  ['holdShare', 'holds'],
  ['jumpShare', 'jumps'],
  ['travel', 'travel per step'],
];

export function formatMetric(key: keyof Metrics, v: number | null | undefined): string {
  if (v == null) return '—';
  switch (key) {
    case 'peakNps':
    case 'avgNps':
      return `${v.toFixed(v < 10 ? 2 : 1)} nps`;
    case 'p95Nps':
      return `${v.toFixed(1)} nps (${Math.round(1000 / v)}ms steps)`;
    case 'fastShare':
    case 'holdShare':
    case 'jumpShare':
      return `${Math.round(v * 100)}%`;
    case 'travel':
      return v.toFixed(2);
    default:
      return String(v);
  }
}

// physical pad coordinates: DL, UL, C, UR, DR
const PANEL_XY = [[-1, -1], [-1, 1], [0, 0], [1, 1], [1, -1]];
const TRAVEL_MAX_GAP_S = 2.0;
const DENSITY_WINDOW_S = 5.0;
const MAX_COUNTED_GAP_S = 2.0;
const FAST_STEP_S = 0.115;

export function notesMetrics(notes: Note[], timing: SongTiming): Metrics {
  const byRow = new Map<number, { panels: Set<number>; hold: boolean }>();
  for (const n of notes) {
    const e = byRow.get(n.row) ?? { panels: new Set<number>(), hold: false };
    n.panels.forEach((p) => e.panels.add(p));
    e.hold = e.hold || n.holdEndRow != null;
    byRow.set(n.row, e);
  }
  const rows = [...byRow.entries()]
    .map(([row, e]) => ({ t: timing.rowTime(row), panels: [...e.panels], hold: e.hold }))
    .sort((a, b) => a.t - b.t);
  const times = rows.map((r) => r.t);
  const n = rows.length;
  if (!n) {
    return { peakNps: null, avgNps: null, p95Nps: null, fastShare: null,
             holdShare: null, jumpShare: null, travel: null, steps: 0 };
  }
  return {
    peakNps: peakNps(times),
    avgNps: avgActiveNps(times),
    p95Nps: p95Speed(times),
    fastShare: fastShare(times),
    holdShare: rows.filter((r) => r.hold).length / n,
    jumpShare: rows.filter((r) => r.panels.length >= 2).length / n,
    travel: travel(rows),
    steps: n,
  };
}

function peakNps(times: number[]): number {
  if (times.length < 2) return 0.5;
  let peak = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[j] < times[i] - DENSITY_WINDOW_S) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak / DENSITY_WINDOW_S;
}

function avgActiveNps(times: number[]): number | null {
  if (times.length < 2) return null;
  let active = 0;
  for (let i = 1; i < times.length; i++) active += Math.min(times[i] - times[i - 1], MAX_COUNTED_GAP_S);
  return active > 15 ? times.length / active : null;
}

function p95Speed(times: number[]): number | null {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0.01) gaps.push(g);
  }
  if (gaps.length < 20) return null;
  gaps.sort((a, b) => a - b);
  return 1 / gaps[Math.max(0, Math.floor(gaps.length * 0.05) - 1)];
}

function fastShare(times: number[]): number | null {
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    if (g > 0.01) gaps.push(g);
  }
  if (gaps.length < 20) return null;
  return gaps.filter((g) => g <= FAST_STEP_S).length / gaps.length;
}

function travel(rows: { t: number; panels: number[] }[]): number | null {
  const dists = [];
  for (let i = 1; i < rows.length; i++) {
    const dt = rows[i].t - rows[i - 1].t;
    if (dt > TRAVEL_MAX_GAP_S || dt <= 0) continue;
    const c0 = centroid(rows[i - 1].panels);
    const c1 = centroid(rows[i].panels);
    dists.push(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]));
  }
  if (dists.length < 8) return null;
  return dists.reduce((a, b) => a + b, 0) / dists.length;
}

function centroid(panels: number[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of panels) {
    x += PANEL_XY[p][0];
    y += PANEL_XY[p][1];
  }
  return [x / panels.length, y / panels.length];
}
