"""Translate osu objects into the pattern token language (TAP / HOLD),
deciding hold intent with a budgeted restfulness gate.

In osu, sliders are flow (moving a cursor is free); in PIU a hold anchors a
foot. Real charts are far more tap-dominated than osu slider density suggests
(training corpus: ~3% holds at level 4, peaking at ~12% around level 15-21).

So the gate works on a budget: the corpus sets how MANY holds a chart of this
level should have, and the restfulness score decides WHICH sliders win those
slots. osu!standard objects never overlap, so a slider's rest value is fully
described by its duration and the gap after its tail.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from .osu_parser import Beatmap
from .sm_parser import fold_bpm
from .timing import BeatGrid

MIN_HOLD_FBEATS = 0.75      # shorter sliders are always just taps
LONG_HOLD_FBEATS = 2.0      # HOLD_S / HOLD_L boundary
MAX_REPEAT_TAPS = 8         # cap on under-hold taps from one returning slider

# fallback when converting without a pattern library (corpus-shaped curve)
DEFAULT_HOLD_SHARE = ((4, 0.03), (8, 0.05), (12, 0.07), (15, 0.10), (21, 0.12), (99, 0.08))
DEFAULT_JUMP_SHARE = 0.09  # corpus runs ~8-12% jump rows at every level
# jumps land on emphasis; feet need room to gather and recover
JUMP_MIN_GAP_BEFORE = 0.45   # folded beats
JUMP_MIN_GAP_AFTER = 0.30

# maps far more slider-heavy than a typical osu map (~50%) get a bigger hold
# budget — the mapper heard the song as sustained phrases, let that through
BASELINE_SLIDER_SHARE = 0.50
SLIDER_BOOST_RANGE = (0.75, 2.0)


@dataclass
class NoteEvent:
    beat: float        # chart beat (osu grid, unfolded) — placement
    end_beat: float    # == beat for taps
    fgap: float        # folded-beat gap to previous event (inf at song start)
    kind: str          # 'T' | 'O' | 'L'
    under_hold: bool = False
    jump: bool = False  # two-panel press; placed by the rule generator

    @property
    def token(self) -> str:
        from .patterns import gap_class
        # 'J' never occurs in harvested tokens, so patterns cannot seed or
        # extend across a jump — it acts as phrase punctuation for matching
        return gap_class(min(self.fgap, 99.0)) + ("J" if self.jump else self.kind)


def classify(bm: Beatmap, grid: BeatGrid, level: int, rng: random.Random,
             hold_target: float | None = None,
             jump_target: float | None = None) -> list[NoteEvent]:
    objs = bm.hit_objects
    if hold_target is None:
        hold_target = _default_hold_share(level)
    if jump_target is None:
        jump_target = DEFAULT_JUMP_SHARE
    slider_share = sum(1 for o in objs if o.kind == "slider") / max(1, len(objs))
    lo, hi = SLIDER_BOOST_RANGE
    hold_target *= min(hi, max(lo, slider_share / BASELINE_SLIDER_SHARE))

    # pass 1: restfulness of every hold-eligible object
    fbpms, fdurs, rests = [], [], {}
    spinner_holds = set()
    for i, ho in enumerate(objs):
        fbpm = fold_bpm(grid.bpm_at_ms(ho.time))
        fdur = (ho.end_time - ho.time) / 60000.0 * fbpm
        fbpms.append(fbpm)
        fdurs.append(fdur)
        if ho.kind == "spinner" and fdur >= 1.0:
            spinner_holds.add(i)  # spinners are osu's own rest markers
        elif ho.kind == "slider" and fdur >= MIN_HOLD_FBEATS:
            gap_next = (_fgap(ho.end_time, objs[i + 1].time, fbpm)
                        if i + 1 < len(objs) else 99.0)
            # jitter keeps different seeds from always choosing the same slots
            rests[i] = (fdur + gap_next) * rng.uniform(0.9, 1.1)

    # pass 2: the corpus-calibrated budget picks the most breather-like sliders
    budget = max(0, round(hold_target * len(objs)) - len(spinner_holds))
    accepted = set(sorted(rests, key=rests.get, reverse=True)[:budget])
    accepted |= spinner_holds

    # pass 3: jumps land on mapper-marked emphasis, corpus-budgeted
    jump_scores: dict[int, float] = {}
    for i, ho in enumerate(objs):
        if i in accepted or ho.kind == "spinner":
            continue
        fbpm = fbpms[i]
        gap_prev = _fgap(objs[i - 1].end_time, ho.time, fbpm) if i else 99.0
        gap_next = (_fgap(ho.end_time, objs[i + 1].time, fbpm)
                    if i + 1 < len(objs) else 99.0)
        if gap_prev < JUMP_MIN_GAP_BEFORE or gap_next < JUMP_MIN_GAP_AFTER:
            continue
        score = 0.0
        if ho.finish:
            score += 3.0          # cymbal: the mapper heard an accent here
        if ho.clap:
            score += 1.2
        if gap_next >= 1.5:
            score += 1.8          # phrase-final note
        if gap_prev >= 1.5:
            score += 1.2          # phrase entrance
        beat = grid.beat_at(ho.time)
        if abs(beat - round(beat)) < 1e-3:
            score += 0.8 if round(beat) % 4 == 0 else 0.4  # (down)beat alignment
        if score >= 0.75:  # measure downbeats alone qualify (stream jumps)
            jump_scores[i] = score * rng.uniform(0.9, 1.1)
    jump_budget = max(0, round(jump_target * len(objs)))
    accepted_jumps = set(
        sorted(jump_scores, key=jump_scores.get, reverse=True)[:jump_budget])

    events: list[NoteEvent] = []
    recent_holds = 0
    for i, ho in enumerate(objs):
        beat = grid.beat_at(ho.time)
        end_beat = grid.beat_at(ho.end_time)
        fbpm, fdur = fbpms[i], fdurs[i]
        gap_prev = _fgap(objs[i - 1].end_time, ho.time, fbpm) if i else float("inf")

        as_hold = i in accepted
        # hold-ladder limiter: several anchored feet in a row at speed is misery
        if as_hold and i not in spinner_holds and recent_holds >= 2 and gap_prev < 1.0:
            as_hold = False
        recent_holds = recent_holds + 1 if (as_hold and gap_prev < 1.0) else (1 if as_hold else 0)

        if not as_hold:
            events.append(NoteEvent(beat, beat, gap_prev, "T",
                                    jump=i in accepted_jumps))
            continue

        kind = "L" if fdur >= LONG_HOLD_FBEATS else "O"
        events.append(NoteEvent(beat, end_beat, gap_prev, kind))
        # returning slider: osu hands us the inner rhythm for hold+tap patterns
        if ho.kind == "slider" and ho.repeats > 1:
            interval_ms = (ho.end_time - ho.time) / ho.repeats
            interval_f = interval_ms / 60000.0 * fbpm
            # feet, not a cursor: never manufacture under-hold taps faster
            # than ~150ms even when the osu slider ticks faster
            if interval_f >= 0.2 and interval_ms >= 150.0 \
                    and ho.repeats - 1 <= MAX_REPEAT_TAPS:
                for k in range(1, ho.repeats):
                    t = ho.time + k * interval_ms
                    events.append(NoteEvent(
                        grid.beat_at(t), grid.beat_at(t),
                        interval_f, "T", under_hold=True,
                    ))
    return events


def _default_hold_share(level: int) -> float:
    for cap, share in DEFAULT_HOLD_SHARE:
        if level <= cap:
            return share
    return 0.08


def _fgap(prev_end_ms: float, time_ms: float, fbpm: float) -> float:
    return max(0.0, time_ms - prev_end_ms) / 60000.0 * fbpm
