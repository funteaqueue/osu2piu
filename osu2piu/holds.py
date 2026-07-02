"""Translate osu objects into the pattern token language (TAP / HOLD),
deciding hold intent with a restfulness gate.

In osu, sliders are flow (moving a cursor is free); in PIU a hold anchors a
foot and mostly functions as rest. A slider becomes a hold only where a rest
belongs. osu!standard objects never overlap, so a slider's rest value is
fully described by its duration and the gap after its tail.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from .osu_parser import Beatmap
from .sm_parser import fold_bpm
from .timing import BeatGrid

MIN_HOLD_FBEATS = 0.75      # shorter sliders are always just taps
LONG_HOLD_FBEATS = 2.0      # HOLD_S / HOLD_L boundary
EFFORT_WINDOW_FBEATS = 8.0  # trailing window for the "needs a break" meter
EFFORT_HIGH = 12            # this many steps in the window = player is working
MAX_REPEAT_TAPS = 8         # cap on under-hold taps from one returning slider


@dataclass
class NoteEvent:
    beat: float        # chart beat (osu grid, unfolded) — placement
    end_beat: float    # == beat for taps
    fgap: float        # folded-beat gap to previous event (inf at song start)
    kind: str          # 'T' | 'O' | 'L'
    under_hold: bool = False

    @property
    def token(self) -> str:
        from .patterns import gap_class
        return gap_class(min(self.fgap, 99.0)) + self.kind


def classify(bm: Beatmap, grid: BeatGrid, level: int, rng: random.Random) -> list[NoteEvent]:
    objs = bm.hit_objects
    events: list[NoteEvent] = []
    recent_holds = 0  # consecutive hold decisions with small gaps

    for i, ho in enumerate(objs):
        beat = grid.beat_at(ho.time)
        end_beat = grid.beat_at(ho.end_time)
        fbpm = fold_bpm(grid.bpm_at_ms(ho.time))
        fdur = (ho.end_time - ho.time) / 60000.0 * fbpm
        gap_prev = _fgap(objs[i - 1].end_time, ho.time, fbpm) if i else float("inf")
        gap_next = _fgap(ho.end_time, objs[i + 1].time, fbpm) if i + 1 < len(objs) else 99.0

        as_hold = False
        if ho.kind == "spinner":
            as_hold = fdur >= 1.0
        elif ho.kind == "slider" and fdur >= MIN_HOLD_FBEATS:
            rest_score = fdur + gap_next
            if level <= 5:
                as_hold = rng.random() < 0.85
            elif level <= 10:
                as_hold = rest_score >= 1.5
            else:
                effort = _effort(objs, i, fbpm)
                as_hold = rest_score >= 2.5 or (effort >= EFFORT_HIGH and rest_score >= 1.5)
        # hold-ladder limiter: several anchored feet in a row at speed is misery
        if as_hold and recent_holds >= 2 and gap_prev < 1.0:
            as_hold = False
        recent_holds = recent_holds + 1 if (as_hold and gap_prev < 1.0) else (1 if as_hold else 0)

        if not as_hold:
            events.append(NoteEvent(beat, beat, gap_prev, "T"))
            continue

        kind = "L" if fdur >= LONG_HOLD_FBEATS else "O"
        events.append(NoteEvent(beat, end_beat, gap_prev, kind))
        # returning slider: osu hands us the inner rhythm for hold+tap patterns
        if ho.kind == "slider" and ho.repeats > 1:
            interval_ms = (ho.end_time - ho.time) / ho.repeats
            interval_f = interval_ms / 60000.0 * fbpm
            if interval_f >= 0.2 and ho.repeats - 1 <= MAX_REPEAT_TAPS:
                for k in range(1, ho.repeats):
                    t = ho.time + k * interval_ms
                    events.append(NoteEvent(
                        grid.beat_at(t), grid.beat_at(t),
                        interval_f, "T", under_hold=True,
                    ))
    return events


def _fgap(prev_end_ms: float, time_ms: float, fbpm: float) -> float:
    return max(0.0, time_ms - prev_end_ms) / 60000.0 * fbpm


def _effort(objs, i: int, fbpm: float) -> int:
    window_ms = EFFORT_WINDOW_FBEATS * 60000.0 / fbpm
    t = objs[i].time
    return sum(1 for o in objs[max(0, i - 40):i] if o.time >= t - window_ms)
