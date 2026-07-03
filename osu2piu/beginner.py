"""Derive true beginner charts (levels 1-2) by thinning the easiest
difficulty's rhythm to real level-1/2 spacing before generation.

Corpus facts (training data): level 1-2 charts step on a 2-folded-beat
floor (meter-2 in-phrase gaps are p25=median=p75=2.0); level 1 is sparser
through LONGER gaps (p75=4.0), not tighter spacing; 85-91% of steps land
on whole beats, roughly half on measure downbeats. So: keep the strongest
note per 2-beat slot, then drop the weakest notes until the chart reaches
real level-1/2 sustained density. The thinned stream then rides the normal
pipeline (hold gate, jump rules, pattern matching with level<=target+1
sources).
"""
from __future__ import annotations

import random

from .osu_parser import Beatmap
from .patterns import Library, avg_active_nps
from .sm_parser import fold_bpm

MIN_GAP_FBEATS = 2.0     # spacing floor for both target levels (corpus)
LOOKAHEAD_FBEATS = 0.55  # window to trade a weak note for a nearby strong one
ANCHOR_GAP_FBEATS = 4.0  # first note after this long a rest is never dropped
# sustained-density targets if the library lacks avg_table entries
DEFAULT_TARGET_AVG = {1: 0.9, 2: 1.2}

BEGINNER_TARGETS = (2, 1)


def derive_beginner(bm: Beatmap, grid, target: int, rng: random.Random,
                    lib: Library | None) -> Beatmap:
    """A copy of `bm` whose hit objects are thinned to `target`-level rhythm."""
    objs = bm.hit_objects
    cum = [0.0]  # folded-beat position of each object
    for k in range(1, len(objs)):
        fbpm = fold_bpm(grid.bpm_at_ms(objs[k - 1].time))
        cum.append(cum[-1] + (objs[k].time - objs[k - 1].time) / 60000.0 * fbpm)

    def strength(i: int) -> float:
        beat = grid.beat_at(objs[i].time)
        in_measure = beat % 4.0
        if min(in_measure, 4.0 - in_measure) < 0.05:
            s = 3.0                       # measure downbeat
        elif min(beat % 1.0, 1.0 - beat % 1.0) < 0.05:
            s = 2.0                       # whole beat
        else:
            s = 0.5                       # offbeat: kept only when needed
        if objs[i].finish:
            s += 1.0
        if objs[i].clap:
            s += 0.4
        return s

    # pass 1: greedy 2-beat slots, preferring the strongest note per slot
    kept: list[int] = []
    i = 0
    while i < len(objs):
        if kept and cum[i] - cum[kept[-1]] < MIN_GAP_FBEATS * 0.95:
            i += 1
            continue
        best, j = i, i + 1
        while j < len(objs) and cum[j] - cum[i] <= LOOKAHEAD_FBEATS:
            if strength(j) > strength(best):
                best = j
            j += 1
        kept.append(best)
        i = best + 1

    # pass 2: drop weakest notes until real target-level sustained density
    target_avg = ((lib.avg_table.get(target) if lib and lib.avg_table else None)
                  or DEFAULT_TARGET_AVG[target])
    kept = _thin_to_density(kept, objs, cum, strength, target_avg, rng)

    thin = Beatmap(
        mode=bm.mode, title=bm.title, artist=bm.artist, creator=bm.creator,
        version=f"Beginner {target}", audio_filename=bm.audio_filename,
        preview_time=bm.preview_time, background=bm.background,
        slider_multiplier=bm.slider_multiplier,
        timing_points=bm.timing_points,
        hit_objects=[objs[k] for k in kept],
    )
    return thin


def _thin_to_density(kept, objs, cum, strength, target_avg, rng):
    kept = list(kept)
    while len(kept) > 8:
        times = [objs[k].time / 1000.0 for k in kept]
        avg = avg_active_nps(times)
        if avg is None or avg <= target_avg * 1.05:
            break
        # anchors (phrase entries after a real rest) stay; drop the weakest rest
        droppable = [
            k for pos, k in enumerate(kept)
            if pos > 0 and cum[k] - cum[kept[pos - 1]] < ANCHOR_GAP_FBEATS
        ]
        if not droppable:
            break
        weakest = min(droppable, key=lambda k: (strength(k), rng.random()))
        kept.remove(weakest)
    return kept
