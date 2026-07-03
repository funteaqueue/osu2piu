// JS mirror of the engine's beat<->time mapping (timing.BeatGrid /
// chartjson.JsonGrid). Beats are in shifted chart space: beat 0 sits at
// audio time -offsetSeconds.

export const ROWS_PER_BEAT = 12;

interface Segment {
  startSec: number;
  secPerBeat: number;
  startBeat: number;
}

export class SongTiming {
  private segments: Segment[];

  constructor(bpms: [number, number][], offsetSeconds: number) {
    const beat0 = -offsetSeconds;
    this.segments = [];
    for (const [beat, bpm] of bpms) {
      const secPerBeat = 60 / bpm;
      const startSec = this.segments.length
        ? this.last.startSec + (beat - this.last.startBeat) * this.last.secPerBeat
        : beat0 + beat * secPerBeat;
      this.segments.push({ startSec, secPerBeat, startBeat: beat });
    }
    if (!this.segments.length) this.segments.push({ startSec: beat0, secPerBeat: 0.5, startBeat: 0 });
  }

  private get last(): Segment {
    return this.segments[this.segments.length - 1];
  }

  beatAt(sec: number): number {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.startSec <= sec + 1e-9) seg = s;
      else break;
    }
    return seg.startBeat + (sec - seg.startSec) / seg.secPerBeat;
  }

  timeAt(beat: number): number {
    let seg = this.segments[0];
    for (const s of this.segments) {
      if (s.startBeat <= beat + 1e-9) seg = s;
      else break;
    }
    return seg.startSec + (beat - seg.startBeat) * seg.secPerBeat;
  }

  rowTime(row: number): number {
    return this.timeAt(row / ROWS_PER_BEAT);
  }
}
