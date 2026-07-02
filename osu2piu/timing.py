"""Beat grid: maps osu millisecond timestamps onto a StepMania beat grid."""
from __future__ import annotations

import math

from .osu_parser import TimingPoint

# 12 rows per beat = 48 rows per 4/4 measure: representable subdivisions are
# 4ths, 8ths, 12ths, 16ths, 24ths and 48ths — everything a sane chart needs.
ROWS_PER_BEAT = 12
ROWS_PER_MEASURE = ROWS_PER_BEAT * 4


class BeatGrid:
    def __init__(self, red_points: list[TimingPoint]):
        if not red_points:
            raise ValueError("beatmap has no uninherited timing points")
        # segments of (start_ms, ms_per_beat, start_beat); beat 0 = first red line
        self.segments: list[tuple[float, float, float]] = []
        beat = 0.0
        for i, tp in enumerate(red_points):
            if i > 0:
                prev = red_points[i - 1]
                beat += (tp.time - prev.time) / prev.beat_length
            self.segments.append((tp.time, tp.beat_length, beat))
        self.shift = 0.0  # whole measures added so no note sits on a negative beat

    def beat_at(self, ms: float) -> float:
        seg = self.segments[0]  # times before the first red line extrapolate backwards
        for s in self.segments:
            if s[0] <= ms + 1e-6:
                seg = s
            else:
                break
        start_ms, beat_length, start_beat = seg
        return start_beat + (ms - start_ms) / beat_length + self.shift

    def apply_shift_for(self, min_beat: float) -> None:
        """If any note would land before beat 0, push beat 0 back whole measures."""
        if min_beat < -1e-6:
            self.shift = 4.0 * math.ceil(-min_beat / 4.0)

    def bpm_at_ms(self, ms: float) -> float:
        seg = self.segments[0]
        for s in self.segments:
            if s[0] <= ms + 1e-6:
                seg = s
            else:
                break
        return 60000.0 / seg[1]

    @property
    def offset_seconds(self) -> float:
        """StepMania #OFFSET: negated audio time of beat 0."""
        first_ms, beat_length, _ = self.segments[0]
        beat0_ms = first_ms - self.shift * beat_length
        return -beat0_ms / 1000.0

    def bpm_changes(self) -> list[tuple[float, float]]:
        """(beat, bpm) pairs for #BPMS, shift applied, consecutive dupes merged."""
        out: list[tuple[float, float]] = []
        for i, (_, beat_length, start_beat) in enumerate(self.segments):
            bpm = 60000.0 / beat_length
            beat = 0.0 if i == 0 else start_beat + self.shift
            if out and abs(out[-1][1] - bpm) < 1e-6:
                continue
            out.append((beat, bpm))
        return out


def quantize(beat: float) -> int:
    """Snap a beat position to the nearest grid row."""
    return round(beat * ROWS_PER_BEAT)
