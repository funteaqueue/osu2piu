"""Orchestrate: .osz in -> StepMania song folder out."""
from __future__ import annotations

import random
import re
from pathlib import Path

from .generator import RuleGenerator
from .holds import classify
from .matcher import PatternMatcher
from .osu_parser import Beatmap, load_osz
from .patterns import PHRASE_SPLIT_GAP, Library, p95_speed
from .ssc_writer import Chart, Song, render_ssc
from .timing import BeatGrid, quantize

# window (seconds) for the peak-density difficulty estimate
DENSITY_WINDOW_S = 5.0


def convert_osz(osz_path: str, out_root: str, seed: int | None = None,
                lib: Library | None = None) -> Path:
    rng = random.Random(seed)
    beatmaps, zf = load_osz(osz_path)
    if not beatmaps:
        raise ValueError(f"no osu!standard difficulties found in {osz_path}")

    ref = beatmaps[0]
    song_dir = Path(out_root) / _safe_name(f"{ref.artist} - {ref.title}")
    song_dir.mkdir(parents=True, exist_ok=True)

    names = {n.lower(): n for n in zf.namelist()}
    music = _extract(zf, names, ref.audio_filename, song_dir)
    background = _extract(zf, names, ref.background, song_dir)

    grid = BeatGrid(ref.red_points)  # difficulties of one set share timing
    grid.apply_shift_for(min(grid.beat_at(h.time) for bm in beatmaps for h in bm.hit_objects))

    song = Song(
        title=ref.title,
        artist=ref.artist,
        credit=f"{ref.creator} / osu2piu",
        music=music,
        background=background,
        offset=grid.offset_seconds,
        sample_start=max(ref.preview_time, 0.0) / 1000.0,
        bpms=grid.bpm_changes(),
    )
    for bm in beatmaps:
        chart = _build_chart(bm, grid, rng, lib)
        song.charts.append(chart)
        s = chart.stats
        total = max(1, s["exact"] + s["downgrade"] + s["fallback"])
        print(f"  [{bm.version:>20s}] lvl {chart.meter:>2d}  "
              f"exact {s['exact'] / total:4.0%}  downgrade {s['downgrade'] / total:4.0%}  "
              f"fallback {s['fallback'] / total:4.0%}  dropped {s['dropped']}"
              + (f"  src-meter {chart.avg_source_meter:.1f}" if chart.avg_source_meter else ""))

    ssc_path = song_dir / (song_dir.name + ".ssc")
    ssc_path.write_text(render_ssc(song), encoding="utf-8")
    return ssc_path


def _build_chart(bm: Beatmap, grid: BeatGrid, rng: random.Random,
                 lib: Library | None) -> Chart:
    level = _pre_level(bm, lib)
    events = classify(bm, grid, level, rng,
                      hold_target=lib.hold_target(level) if lib else None)
    tokens = [ev.token for ev in events]
    phrase_starts = _phrase_starts(events)

    matcher = PatternMatcher(lib, rng, level) if lib else None
    gen = RuleGenerator(rng)
    cells: dict[int, list[str]] = {}
    placed: list[int | None] = []
    active_holds: dict[int, float] = {}
    stats = {"exact": 0, "downgrade": 0, "fallback": 0, "dropped": 0}
    meters_used: list[int] = []

    i = 0
    while i < len(events):
        active_holds = {p: e for p, e in active_holds.items()
                        if e > events[i].beat + 1e-6}
        emission = None
        if matcher:
            emission = matcher.match(events, tokens, i, placed,
                                     active_holds, _phrase_of(phrase_starts, i))
        if emission:
            meters_used.append(emission.source_meter)
            for panel in emission.panels:
                ev = events[i]
                ok = _place(cells, ev, panel, gen_observe=(gen, active_holds))
                placed.append(panel if ok else None)
                stats[emission.tier if ok else "dropped"] += 1
                i += 1
        else:
            ev = events[i]
            hold_end = ev.end_beat if ev.kind in "OL" else None
            panel = gen.step(ev.beat, hold_end=hold_end,
                             fgap=min(ev.fgap, 99.0))
            if panel is None:
                placed.append(None)
                stats["dropped"] += 1
            else:
                ok = _place(cells, ev, panel, gen_observe=None,
                            holds=active_holds)
                placed.append(panel if ok else None)
                stats["fallback" if ok else "dropped"] += 1
            i += 1

    return Chart(
        description=bm.version,
        meter=_final_level(cells, grid, lib),
        cells=cells,
        dropped=stats["dropped"],
        stats=stats,
        avg_source_meter=(sum(meters_used) / len(meters_used)) if meters_used else 0.0,
    )


def _place(cells, ev, panel, gen_observe=None, holds=None) -> bool:
    row = quantize(ev.beat)
    is_hold = ev.kind in "OL"
    end_row = quantize(ev.end_beat) if is_hold else row
    if is_hold and end_row <= row:
        is_hold = False

    head = cells.setdefault(row, list("00000"))
    if head[panel] != "0":
        return False  # collision with an earlier hold tail on the same row
    if is_hold:
        tail = cells.setdefault(end_row, list("00000"))
        head[panel] = "2"
        tail[panel] = "3"
    else:
        head[panel] = "1"

    if gen_observe is not None:
        gen, active = gen_observe
        gen.observe(ev.beat, panel, hold_end=ev.end_beat if is_hold else None)
        if is_hold:
            active[panel] = ev.end_beat
    elif holds is not None and is_hold:
        holds[panel] = ev.end_beat
    return True


def _phrase_starts(events) -> list[int]:
    return [i for i, ev in enumerate(events)
            if i == 0 or ev.fgap > PHRASE_SPLIT_GAP]


def _phrase_of(starts: list[int], i: int) -> int:
    lo = 0
    for s in starts:
        if s <= i:
            lo = s
        else:
            break
    return lo


def _pre_level(bm: Beatmap, lib: Library | None) -> int:
    times = [h.time for h in bm.hit_objects]
    if lib:
        return lib.estimate_level(_peak_nps(times), _avg_nps(times),
                                  p95_speed([t / 1000.0 for t in times]))
    return max(1, min(24, round(_peak_nps(times) * 2.3)))


def _final_level(cells, grid: BeatGrid, lib: Library | None) -> int:
    """Level from the GENERATED chart's density (at high levels most sliders
    became taps, so osu object counts under-measure). Rows holding only hold
    tails ('3') are not steps."""
    times = sorted(_row_time(grid, row) for row, chars in cells.items()
                   if any(c in "12" for c in chars))
    if lib:
        return lib.estimate_level(_peak_nps(times), _avg_nps(times),
                                  p95_speed([t / 1000.0 for t in times]))
    return max(1, min(24, round(_peak_nps(times) * 2.3)))


def _avg_nps(times_ms: list[float]) -> float | None:
    if len(times_ms) < 2:
        return None
    duration = (max(times_ms) - min(times_ms)) / 1000.0
    return len(times_ms) / duration if duration > 20.0 else None


def _row_time(grid: BeatGrid, row: int) -> float:
    beat = row / 12.0 - grid.shift
    start_ms, beat_length, start_beat = grid.segments[0]
    for s in grid.segments:
        if s[2] <= beat + 1e-9:
            start_ms, beat_length, start_beat = s
        else:
            break
    return start_ms + (beat - start_beat) * beat_length


def _peak_nps(times_ms: list[float]) -> float:
    if len(times_ms) < 2:
        return 0.5
    times = sorted(times_ms)
    window = DENSITY_WINDOW_S * 1000.0
    peak, j = 0, 0
    for i, t in enumerate(times):
        while times[j] < t - window:
            j += 1
        peak = max(peak, i - j + 1)
    return peak / DENSITY_WINDOW_S


def _extract(zf, names: dict[str, str], filename: str, song_dir: Path) -> str:
    if not filename or filename.lower() not in names:
        return ""
    real = names[filename.lower()]
    out_name = _safe_name(Path(real).name)
    (song_dir / out_name).write_bytes(zf.read(real))
    return out_name


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "", name).strip().rstrip(".")
