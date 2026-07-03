// Play mode: judge keyboard hits against the chart, StepMania-style.
// Windows follow the SM5 engine defaults (the engine family XSanity runs on),
// with W1+W2 merged into "perfect" like the PIU themes display them.
import { SongTiming } from './timing';
import type { Note } from './types';

export type Judgment = 'perfect' | 'great' | 'good' | 'bad' | 'miss';

export const WINDOWS: [Judgment, number][] = [
  ['perfect', 0.0465],
  ['great', 0.0915],
  ['good', 0.1365],
  ['bad', 0.1815],
];
export const MISS_WINDOW = 0.1815;
const HOLD_RELEASE_GRACE = 0.25; // may let go this close to the tail

export const JUDGMENT_COLORS: Record<Judgment, string> = {
  perfect: '#38c8ff',
  great: '#3fd35c',
  good: '#f2c94c',
  bad: '#c76bff',
  miss: '#ff4455',
};

interface Target {
  time: number;
  panel: number;
  key: string;            // `${noteIdx}:${panel}` — renderer lookup
  holdEndTime: number | null;
  judgment: Judgment | null;
  holdActive: boolean;
  holdBroken: boolean;
}

export interface JudgmentEvent {
  judgment: Judgment;
  at: number; // wall-clock (performance.now()/1000) for fade animation
}

export class PlaySession {
  counts: Record<Judgment, number> = { perfect: 0, great: 0, good: 0, bad: 0, miss: 0 };
  combo = 0;
  maxCombo = 0;
  keysDown = [false, false, false, false, false];
  lastJudgment: JudgmentEvent | null = null;
  startTime: number;
  readonly total: number;

  private byPanel: Target[][] = [[], [], [], [], []];
  private hitKeys = new Set<string>();
  private missKeys = new Set<string>();

  constructor(notes: Note[], timing: SongTiming, startTime: number, public offsetSec = 0) {
    this.startTime = startTime;
    notes.forEach((n, idx) => {
      const t = timing.rowTime(n.row);
      if (t < startTime - 0.05) return;
      for (const panel of n.panels) {
        this.byPanel[panel].push({
          time: t,
          panel,
          key: `${idx}:${panel}`,
          holdEndTime: n.holdEndRow != null ? timing.rowTime(n.holdEndRow) : null,
          judgment: null,
          holdActive: false,
          holdBroken: false,
        });
      }
    });
    for (const list of this.byPanel) list.sort((a, b) => a.time - b.time);
    this.total = this.byPanel.reduce((s, l) => s + l.length, 0);
  }

  /** audio time adjusted by the player's input calibration */
  private adjust(t: number): number {
    return t - this.offsetSec;
  }

  press(panel: number, audioTime: number): Judgment | null {
    this.keysDown[panel] = true;
    const t = this.adjust(audioTime);
    let best: Target | null = null;
    for (const target of this.byPanel[panel]) {
      if (target.judgment) continue;
      if (target.time > t + MISS_WINDOW) break;
      if (Math.abs(target.time - t) <= MISS_WINDOW
          && (!best || Math.abs(target.time - t) < Math.abs(best.time - t))) {
        best = target;
      }
    }
    if (!best) return null;
    const dt = Math.abs(best.time - t);
    const judgment = WINDOWS.find(([, w]) => dt <= w)![0];
    best.judgment = judgment;
    if (best.holdEndTime != null && judgment !== 'miss') best.holdActive = true;
    this.record(best, judgment);
    return judgment;
  }

  release(panel: number, audioTime: number): void {
    this.keysDown[panel] = false;
    const t = this.adjust(audioTime);
    for (const target of this.byPanel[panel]) {
      if (target.holdActive && !target.holdBroken
          && target.holdEndTime != null && t < target.holdEndTime - HOLD_RELEASE_GRACE) {
        target.holdBroken = true;
        target.holdActive = false;
        this.combo = 0;
        this.counts.miss += 1;
        this.lastJudgment = { judgment: 'miss', at: performance.now() / 1000 };
        this.missKeys.add(target.key);
      }
    }
  }

  /** advance time: turn overdue notes into misses, complete finished holds */
  tick(audioTime: number): void {
    const t = this.adjust(audioTime);
    for (const list of this.byPanel) {
      for (const target of list) {
        if (!target.judgment && target.time < t - MISS_WINDOW) {
          target.judgment = 'miss';
          this.record(target, 'miss');
        }
        if (target.holdActive && target.holdEndTime != null && t >= target.holdEndTime) {
          target.holdActive = false; // held to the end
          this.combo += 1;
          this.maxCombo = Math.max(this.maxCombo, this.combo);
        }
      }
    }
  }

  private record(target: Target, judgment: Judgment): void {
    this.counts[judgment] += 1;
    if (judgment === 'bad' || judgment === 'miss') this.combo = 0;
    else {
      this.combo += 1;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }
    this.lastJudgment = { judgment, at: performance.now() / 1000 };
    (judgment === 'miss' ? this.missKeys : this.hitKeys).add(target.key);
  }

  isHit(noteIdx: number, panel: number): boolean {
    return this.hitKeys.has(`${noteIdx}:${panel}`);
  }

  isMissed(noteIdx: number, panel: number): boolean {
    return this.missKeys.has(`${noteIdx}:${panel}`);
  }

  judgedCount(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  accuracy(): number {
    const weights: Record<Judgment, number> = { perfect: 1, great: 0.8, good: 0.5, bad: 0.2, miss: 0 };
    const judged = this.judgedCount();
    if (!judged) return 1;
    let sum = 0;
    for (const [j, n] of Object.entries(this.counts)) sum += weights[j as Judgment] * n;
    return sum / judged;
  }
}

// StepMania's default pump-single keyboard layout — matches the pad shape.
// One rebindable key per panel; the numpad stays as a built-in fallback for
// any key the user hasn't claimed.
export const DEFAULT_BINDS: string[] = ['z', 'q', 's', 'e', 'c'];
const NUMPAD_FALLBACK: Record<string, number> = { '1': 0, '7': 1, '5': 2, '9': 3, '3': 4 };
const BINDS_STORAGE = 'o2p-play-binds';

export function loadBinds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BINDS_STORAGE) ?? 'null');
    if (Array.isArray(raw) && raw.length === 5 && raw.every((k) => typeof k === 'string' && k)) {
      return raw;
    }
  } catch { /* fall through */ }
  return [...DEFAULT_BINDS];
}

export function saveBinds(binds: string[]): void {
  localStorage.setItem(BINDS_STORAGE, JSON.stringify(binds));
}

export function buildKeyMap(binds: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const [key, panel] of Object.entries(NUMPAD_FALLBACK)) {
    if (!binds.includes(key)) map[key] = panel;
  }
  binds.forEach((key, panel) => { map[key.toLowerCase()] = panel; });
  return map;
}

export function keyLabel(key: string): string {
  if (key === ' ') return 'space';
  return key.length === 1 ? key.toUpperCase() : key;
}
