export interface Origin {
  tier: 'exact' | 'downgrade' | 'fallback' | 'jump' | 'manual';
  sourceMeter: number | null;
}

export interface Note {
  row: number;
  panels: number[];
  holdEndRow: number | null;
  origin: Origin;
}

export interface ChartStats {
  coverage: number | null;
  jumps: number;
  holds: number;
  rulers: { peak: number | null; avg: number | null; speed: number | null };
  tiers?: Record<string, number>;
}

export interface ChartJson {
  id: string;
  name: string;
  level: number;
  notes: Note[];
  stats: ChartStats;
  source?: { objects: unknown[] };
}

export interface SongJson {
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
  song: SongJson;
  charts: ChartJson[];
}

export interface RegenerateBody {
  startRow?: number | null;
  endRow?: number | null;
  seed?: number | null;
  options?: Record<string, unknown>;
}
