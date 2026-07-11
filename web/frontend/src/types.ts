export type Tier = 'exact' | 'downgrade' | 'fallback' | 'jump' | 'manual';

export interface Note {
  row: number;
  panels: number[];
  holdEndRow: number | null;
  origin: { tier: Tier; sourceMeter: number | null };
}

export interface ChartStats {
  coverage: number | null;
  jumps: number;
  holds: number;
  rulers: { peak: number | null; avg: number | null; speed: number | null };
  tiers?: Record<string, number>;
}

export interface Chart {
  id: string;
  name: string;
  level: number;
  notes: Note[];
  stats: ChartStats;
  source?: unknown;
}

export interface Song {
  title: string;
  artist: string;
  creator: string;
  audioFile: string;
  background: string;
  video: string;
  videoStartBeat: number;
  bpms: [number, number][];
  offsetSeconds: number;
  sampleStartSeconds: number;
  audioEdit?: AudioEdit;
}

export interface AudioSegment { start: number; end: number }
export interface AudioEdit {
  sourceFile: string;
  segments: AudioSegment[];
  fadeStart: number | null;
  fadeEnd: number | null;
  outputDuration: number;
}

export interface Project {
  id: string;
  createdAt: string;
  seed: number | null;
  song: Song;
  charts: Chart[];
}

export interface ProjectSummary {
  id: string;
  createdAt: string;
  song: Pick<Song, 'title' | 'artist' | 'creator' | 'background'>;
  charts: { id: string; name: string; level: number; notes: number; stats: ChartStats }[];
}

export interface RevisionInfo {
  name: string;
  savedAt: string;
  label: string;
}

export interface RegenOptions {
  level?: number;
  holdMult?: number;
  jumpMult?: number;
  maxMatch?: number;
  overwriteManual?: boolean;
}
