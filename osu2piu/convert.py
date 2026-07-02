"""Orchestrate: .osz in -> StepMania song folder out."""
from __future__ import annotations

import random
import re
from pathlib import Path

from .generator import RuleGenerator
from .osu_parser import Beatmap, load_osz
from .ssc_writer import Chart, Song, render_ssc
from .timing import BeatGrid, quantize

# a slider must last at least this many beats to be worth a hold note
MIN_HOLD_BEATS = 0.75
# chance that a hold-worthy slider actually becomes a hold (rest become taps)
HOLD_CHANCE = 0.85
# window (seconds) for the peak-density difficulty estimate
DENSITY_WINDOW_S = 6.0


def convert_osz(osz_path: str, out_root: str, seed: int | None = None) -> Path:
    rng = random.Random(seed)
    beatmaps, zf = load_osz(osz_path)
    if not beatmaps:
        raise ValueError(f"no osu!standard difficulties found in {osz_path}")

    ref = beatmaps[0]
    song_dir = Path(out_root) / _safe_name(f"{ref.artist} - {ref.title}")
    song_dir.mkdir(parents=True, exist_ok=True)

    # audio and background come out of the archive as-is
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
        song.charts.append(_build_chart(bm, grid, rng))

    ssc_path = song_dir / (song_dir.name + ".ssc")
    ssc_path.write_text(render_ssc(song), encoding="utf-8")
    return ssc_path


def _build_chart(bm: Beatmap, grid: BeatGrid, rng: random.Random) -> Chart:
    gen = RuleGenerator(rng)
    cells: dict[int, list[str]] = {}
    dropped = 0

    for ho in bm.hit_objects:
        row = quantize(grid.beat_at(ho.time))
        end_row = quantize(grid.beat_at(ho.end_time))
        beat = row / 12.0
        end_beat = end_row / 12.0

        is_hold = (
            ho.kind == "slider"
            and end_beat - beat >= MIN_HOLD_BEATS
            and rng.random() < HOLD_CHANCE
        )
        panel = gen.step(beat, hold_end=end_beat if is_hold else None)
        if panel is None:
            dropped += 1
            continue

        head = cells.setdefault(row, list("00000"))
        if head[panel] != "0":
            dropped += 1  # collision with an earlier hold tail on the same row
            continue
        if is_hold:
            tail = cells.setdefault(end_row, list("00000"))
            head[panel] = "2"
            tail[panel] = "3"
        else:
            head[panel] = "1"

    return Chart(
        description=bm.version,
        meter=_estimate_level(bm),
        cells=cells,
        dropped=dropped,
    )


def _estimate_level(bm: Beatmap) -> int:
    """Rough PIU-ish level from peak note density. Calibrate against real
    charts once we have the pattern library."""
    times = sorted(h.time for h in bm.hit_objects)
    if len(times) < 2:
        return 1
    window = DENSITY_WINDOW_S * 1000.0
    peak, j = 0, 0
    for i, t in enumerate(times):
        while times[j] < t - window:
            j += 1
        peak = max(peak, i - j + 1)
    peak_nps = peak / DENSITY_WINDOW_S
    return max(1, min(24, round(peak_nps * 2.3)))


def _extract(zf, names: dict[str, str], filename: str, song_dir: Path) -> str:
    if not filename or filename.lower() not in names:
        return ""
    real = names[filename.lower()]
    out_name = _safe_name(Path(real).name)
    (song_dir / out_name).write_bytes(zf.read(real))
    return out_name


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "", name).strip().rstrip(".")
