"""Chart JSON: the contract shared by the CLI, the engine API and the web
studio.

Generation emits notes with per-note provenance (origin tier + source meter);
.ssc rendering, stats and difficulty estimation are pure functions of the
JSON. Every chart carries its source osu objects, so regeneration (full or
region) never needs the original .osz.

Shapes (plain dicts, JSON-ready):
  song  = {title, artist, creator, audioFile, background,
           bpms: [[beat, bpm]], offsetSeconds, sampleStartSeconds}
  note  = {row, panels: [int], holdEndRow: int|None,
           origin: {tier: exact|downgrade|fallback|jump|manual,
                    sourceMeter: int|None}}
  chart = {id, name, level, notes: [note], stats,
           source: {objects: [[time, endTime, kind, repeats, finish, clap]]}}
"""
from __future__ import annotations

import random

from .generator import RuleGenerator
from .holds import classify
from .matcher import PatternMatcher
from .osu_parser import Beatmap, HitObject
from .patterns import (PHRASE_SPLIT_GAP, Library, avg_active_nps,
                       decode_panels, fast_share, p95_speed, panel_char)
from .ssc_writer import Chart, Song, render_ssc
from .timing import BeatGrid, ROWS_PER_BEAT, quantize

# window (seconds) for the peak-density difficulty estimate
DENSITY_WINDOW_S = 5.0

OBJ_KINDS = ("circle", "slider", "spinner")
TIER_KEYS = ("exact", "downgrade", "fallback", "jump")


# ---------------------------------------------------------------- timing

class JsonGrid:
    """Beat/ms mapping reconstructed from song JSON (#BPMS + #OFFSET).

    Beats are already in shifted chart space, so shift is 0; exposes the
    same interface surface as timing.BeatGrid where the pipeline needs it.
    """

    def __init__(self, bpms: list, offset_seconds: float):
        beat0_ms = -offset_seconds * 1000.0
        self.shift = 0.0
        self.segments: list[tuple[float, float, float]] = []
        for beat, bpm in bpms:
            mpb = 60000.0 / bpm
            if not self.segments:
                ms = beat0_ms + beat * mpb
            else:
                pms, pmpb, pbeat = self.segments[-1]
                ms = pms + (beat - pbeat) * pmpb
            self.segments.append((ms, mpb, beat))
        if not self.segments:
            self.segments.append((beat0_ms, 500.0, 0.0))

    def _segment_at_ms(self, ms: float):
        seg = self.segments[0]
        for s in self.segments:
            if s[0] <= ms + 1e-6:
                seg = s
            else:
                break
        return seg

    def beat_at(self, ms: float) -> float:
        start_ms, mpb, start_beat = self._segment_at_ms(ms)
        return start_beat + (ms - start_ms) / mpb

    def bpm_at_ms(self, ms: float) -> float:
        return 60000.0 / self._segment_at_ms(ms)[1]

    def row_time(self, row: int) -> float:
        beat = row / ROWS_PER_BEAT
        seg = self.segments[0]
        for s in self.segments:
            if s[2] <= beat + 1e-9:
                seg = s
            else:
                break
        start_ms, mpb, start_beat = seg
        return start_ms + (beat - start_beat) * mpb


def row_time_ms(grid, row: int) -> float:
    """Audio time of a grid row for either grid flavour (shift-aware)."""
    if isinstance(grid, JsonGrid):
        return grid.row_time(row)
    beat = row / ROWS_PER_BEAT - grid.shift
    seg = grid.segments[0]
    for s in grid.segments:
        if s[2] <= beat + 1e-9:
            seg = s
        else:
            break
    start_ms, beat_length, start_beat = seg
    return start_ms + (beat - start_beat) * beat_length


# ---------------------------------------------------------------- build

def build_project(beatmaps: list[Beatmap], rng: random.Random,
                  lib: Library | None, beginner: bool = True) -> dict:
    """Convert all difficulties of one mapset into project JSON.

    audioFile/background hold the raw in-archive names; callers that extract
    media rewrite them afterwards. With `beginner`, extra level-1/2 charts
    are derived by thinning the easiest difficulty (see beginner.py).
    """
    from .beginner import BEGINNER_TARGETS, derive_beginner

    ref = beatmaps[0]
    grid = BeatGrid(ref.red_points)  # difficulties of one set share timing
    grid.apply_shift_for(min(grid.beat_at(h.time)
                             for bm in beatmaps for h in bm.hit_objects))
    song = {
        "title": ref.title,
        "artist": ref.artist,
        "creator": ref.creator,
        "audioFile": ref.audio_filename,
        "background": ref.background,
        "bpms": [[beat, bpm] for beat, bpm in grid.bpm_changes()],
        "offsetSeconds": grid.offset_seconds,
        "sampleStartSeconds": max(ref.preview_time, 0.0) / 1000.0,
    }
    charts = [_build_chart_json(bm, grid, rng, lib, f"c{i}")
              for i, bm in enumerate(beatmaps)]
    if beginner:
        floor = min(c["level"] for c in charts)
        easiest = beatmaps[min(range(len(charts)),
                               key=lambda i: charts[i]["level"])]
        for target in BEGINNER_TARGETS:
            if floor <= target:
                continue
            thin = derive_beginner(easiest, grid, target, rng, lib)
            charts.append(_build_chart_json(thin, grid, rng, lib,
                                            f"c{len(charts)}", level=target))
    return {"song": song, "charts": charts}


def _build_chart_json(bm: Beatmap, grid, rng: random.Random,
                      lib: Library | None, chart_id: str,
                      level: int | None = None) -> dict:
    forced_level = level
    level = forced_level or _estimate_pre_level(bm.hit_objects, lib)
    events = classify(bm, grid, level, rng,
                      hold_target=lib.hold_target(level) if lib else None,
                      jump_target=lib.jump_target(level) if lib else None)
    notes, tiers = _generate(events, rng, lib, level)
    chart = {
        "id": chart_id,
        "name": bm.version,
        "level": 0,  # filled below from the generated chart
        "notes": notes,
        "source": {"objects": [
            [ho.time, ho.end_time, OBJ_KINDS.index(ho.kind),
             ho.repeats, ho.finish, ho.clap]
            for ho in bm.hit_objects
        ]},
    }
    chart["level"] = forced_level or _estimate_final_level(notes, grid, lib)
    chart["stats"] = compute_stats(notes, grid, tiers)
    return chart


def regenerate_chart(song: dict, chart: dict, start_row: int | None = None,
                     end_row: int | None = None, seed: int | None = None,
                     options: dict | None = None,
                     lib: Library | None = None) -> dict:
    """Regenerate a chart (whole, or only rows in [start_row, end_row]).

    Notes outside the region are pinned and feed the matcher/generator as
    context; manual notes inside the region survive unless overwriteManual.
    """
    options = options or {}
    rng = random.Random(seed)
    grid = JsonGrid(song["bpms"], song["offsetSeconds"])
    objects = [HitObject(0, 0, t, OBJ_KINDS[k], et, repeats=r,
                         finish=bool(f), clap=bool(c))
               for t, et, k, r, f, c in chart["source"]["objects"]]

    full = start_row is None and end_row is None
    region = None if full else (start_row if start_row is not None else 0,
                                end_row if end_row is not None else 1 << 30)

    level_opt = options.get("level")
    if level_opt:
        gen_level = int(level_opt)
    elif full:
        gen_level = _estimate_pre_level(objects, lib)
    else:
        gen_level = int(chart["level"])

    hold_mult = float(options.get("holdMult", 1.0))
    jump_mult = float(options.get("jumpMult", 1.0))
    max_match = options.get("maxMatch")
    overwrite_manual = bool(options.get("overwriteManual", False))

    bm = Beatmap()
    bm.hit_objects = objects
    hold_target = lib.hold_target(gen_level) if lib else None
    jump_target = lib.jump_target(gen_level) if lib else None
    events = classify(bm, grid, gen_level, rng,
                      hold_target=hold_target * hold_mult if hold_target else None,
                      jump_target=jump_target * jump_mult if jump_target else None)

    if full:
        pinned = None
    else:
        lo, hi = region
        pinned = [n for n in chart["notes"]
                  if not (lo <= n["row"] <= hi)
                  or (n["origin"]["tier"] == "manual" and not overwrite_manual)]

    notes, tiers = _generate(events, rng, lib, gen_level,
                             max_match=int(max_match) if max_match else None,
                             pinned=pinned, region=region)

    new_chart = dict(chart)
    new_chart["notes"] = notes
    if level_opt:
        new_chart["level"] = int(level_opt)
    elif full:
        new_chart["level"] = _estimate_final_level(notes, grid, lib)
    new_chart["stats"] = compute_stats(notes, grid, tiers)
    return new_chart


# ---------------------------------------------------------------- generation

def _generate(events, rng: random.Random, lib: Library | None, level: int,
              max_match: int | None = None, pinned: list | None = None,
              region: tuple[int, int] | None = None):
    """The placement loop. With pinned/region unset this is the classic
    full-generation path (RNG call order preserved); otherwise pinned notes
    are fixed context and only events whose row falls inside region emit."""
    tokens = [ev.token for ev in events]
    phrase_starts = [i for i, ev in enumerate(events)
                     if i == 0 or ev.fgap > PHRASE_SPLIT_GAP]

    matcher = (PatternMatcher(lib, rng, level, max_match=max_match)
               if lib else None)
    gen = RuleGenerator(rng)
    cells: dict[int, list[str]] = {}
    notes: list[dict] = []
    placed: list[str | None] = []
    active_holds: dict[int, float] = {}
    tiers = {k: 0 for k in TIER_KEYS} | {"dropped": 0}

    pinned_by_row: dict[int, list[dict]] = {}
    pinned_holds: list[tuple[float, float, int]] = []
    if pinned:
        for n in pinned:
            _note_into_cells(n, cells)
            pinned_by_row.setdefault(n["row"], []).append(n)
            if n.get("holdEndRow"):
                for p in n["panels"]:
                    pinned_holds.append((n["row"] / ROWS_PER_BEAT,
                                         n["holdEndRow"] / ROWS_PER_BEAT, p))

    def in_region(row: int) -> bool:
        return region is None or region[0] <= row <= region[1]

    def holds_for(beat: float) -> dict[int, float]:
        if not pinned_holds:
            return active_holds
        merged = dict(active_holds)
        for sb, eb, p in pinned_holds:
            if sb <= beat + 1e-6 and eb > beat + 1e-6:
                merged[p] = max(merged.get(p, 0.0), eb)
        return merged

    def consume_pin(row: int, beat: float) -> bool:
        """Adopt a pinned note at this event as context. True if consumed."""
        cand = pinned_by_row.get(row)
        if not cand:
            return False
        n = cand.pop(0)
        panels = n["panels"]
        end_row = n.get("holdEndRow")
        end_beat = end_row / ROWS_PER_BEAT if end_row else None
        if len(panels) == 2 and not end_row:
            placed.append(panel_char(panels[0], panels[1]))
            gen.observe_jump(beat, (panels[0], panels[1]))
        else:
            placed.append(str(panels[0]))
            gen.observe(beat, panels[0], hold_end=end_beat)
            if end_beat:
                active_holds[panels[0]] = end_beat
        return True

    i = 0
    while i < len(events):
        ev = events[i]
        row = quantize(ev.beat)
        active_holds = {p: e for p, e in active_holds.items()
                        if e > ev.beat + 1e-6}

        if pinned is not None:
            outside = not in_region(row)
            if outside or row in pinned_by_row and pinned_by_row[row]:
                if not consume_pin(row, ev.beat):
                    placed.append(None)  # outside, nothing pinned here
                i += 1
                continue

        emission = None
        if matcher:
            emission = matcher.match(events, tokens, i, placed,
                                     holds_for(ev.beat),
                                     _phrase_of(phrase_starts, i))
        if emission:
            for char in emission.panels:
                ev = events[i]
                if not in_region(quantize(ev.beat)):
                    break  # emission tail crossed the region edge
                panels = decode_panels(char)
                if len(panels) == 2:
                    note = _place_jump(cells, ev, panels)
                    if note:
                        gen.observe_jump(ev.beat, panels)
                else:
                    note = _place(cells, ev, panels[0],
                                  gen_observe=(gen, active_holds))
                placed.append(char if note else None)
                tiers[emission.tier if note else "dropped"] += 1
                if note:
                    note["origin"] = {"tier": emission.tier,
                                      "sourceMeter": emission.source_meter}
                    notes.append(note)
                i += 1
        elif events[i].jump:  # no pattern covers this jump: rule generator
            ev = events[i]
            pair = gen.jump(ev.beat)
            note = _place_jump(cells, ev, pair) if pair is not None else None
            if note:
                tiers["jump"] += 1
                placed.append(panel_char(*pair))
                note["origin"] = {"tier": "jump", "sourceMeter": None}
                notes.append(note)
            else:
                tiers["dropped"] += 1
                placed.append(None)
            i += 1
        else:
            ev = events[i]
            hold_end = ev.end_beat if ev.kind in "OL" else None
            panel = gen.step(ev.beat, hold_end=hold_end,
                             fgap=min(ev.fgap, 99.0))
            note = None
            if panel is not None:
                note = _place(cells, ev, panel, gen_observe=None,
                              holds=active_holds)
            placed.append(str(panel) if note else None)
            if note:
                tiers["fallback"] += 1
                note["origin"] = {"tier": "fallback", "sourceMeter": None}
                notes.append(note)
            else:
                tiers["dropped"] += 1
            i += 1

    if pinned:
        notes = _drop_inside_pinned_holds(notes, pinned_holds)
        notes = sorted(notes + pinned, key=lambda n: (n["row"], n["panels"]))
    return notes, tiers


def _drop_inside_pinned_holds(notes, pinned_holds):
    """Generated steps landing mid-body on a pinned hold's panel are illegal
    (cells only guard head/tail rows) — drop them."""
    if not pinned_holds:
        return notes
    out = []
    for n in notes:
        beat = n["row"] / ROWS_PER_BEAT
        if any(sb < beat + 1e-6 and beat < eb - 1e-6 and p in n["panels"]
               for sb, eb, p in pinned_holds):
            continue
        out.append(n)
    return out


def _note_into_cells(note: dict, cells: dict[int, list[str]]) -> None:
    row, end_row = note["row"], note.get("holdEndRow")
    is_hold = end_row is not None and end_row > row
    head = cells.setdefault(row, list("00000"))
    for p in note["panels"]:
        if head[p] != "0":
            continue
        if is_hold:
            head[p] = "2"
            cells.setdefault(end_row, list("00000"))[p] = "3"
        else:
            head[p] = "1"


def _place_jump(cells, ev, pair) -> dict | None:
    row = quantize(ev.beat)
    cols = cells.setdefault(row, list("00000"))
    free = [p for p in pair if cols[p] == "0"]
    if not free:
        return None
    for p in free:  # a hold tail may occupy one panel; keep the other
        cols[p] = "1"
    return {"row": row, "panels": sorted(free), "holdEndRow": None}


def _place(cells, ev, panel, gen_observe=None, holds=None) -> dict | None:
    row = quantize(ev.beat)
    is_hold = ev.kind in "OL"
    end_row = quantize(ev.end_beat) if is_hold else row
    if is_hold and end_row <= row:
        is_hold = False

    head = cells.setdefault(row, list("00000"))
    if head[panel] != "0":
        return None  # collision with an earlier hold tail on the same row
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
    return {"row": row, "panels": [panel],
            "holdEndRow": end_row if is_hold else None}


def _phrase_of(starts: list[int], i: int) -> int:
    lo = 0
    for s in starts:
        if s <= i:
            lo = s
        else:
            break
    return lo


# ---------------------------------------------------------------- stats

def compute_stats(notes: list[dict], grid, tiers: dict | None = None) -> dict:
    from .metrics import notes_metrics
    times_s = sorted({row_time_ms(grid, n["row"]) for n in notes})
    times_s = [t / 1000.0 for t in times_s]
    placed = sum(tiers[k] for k in TIER_KEYS) if tiers else 0
    stats = {
        "coverage": ((tiers["exact"] + tiers["downgrade"]) / placed
                     if tiers and placed else None),
        "jumps": sum(1 for n in notes
                     if len(n["panels"]) == 2 and not n.get("holdEndRow")),
        "holds": sum(1 for n in notes if n.get("holdEndRow")),
        "rulers": {
            "peak": _peak_nps([t * 1000.0 for t in times_s]),
            "avg": avg_active_nps(times_s),
            "speed": p95_speed(times_s),
        },
        "metrics": notes_metrics(notes, grid),
    }
    if tiers:
        stats["tiers"] = dict(tiers)
    return stats


def _estimate_pre_level(objects, lib: Library | None) -> int:
    times = [h.time for h in objects]
    if lib:
        secs = [t / 1000.0 for t in times]
        return lib.estimate_level(_peak_nps(times), _avg_nps(times),
                                  p95_speed(secs), fast_share(secs))
    return max(1, min(24, round(_peak_nps(times) * 2.3)))


def _estimate_final_level(notes: list[dict], grid,
                          lib: Library | None) -> int:
    """Level from the GENERATED chart's density (at high levels most sliders
    became taps, so osu object counts under-measure)."""
    times = sorted({row_time_ms(grid, n["row"]) for n in notes})
    if lib:
        secs = [t / 1000.0 for t in times]
        return lib.estimate_level(_peak_nps(times), _avg_nps(times),
                                  p95_speed(secs), fast_share(secs))
    return max(1, min(24, round(_peak_nps(times) * 2.3)))


def _avg_nps(times_ms: list[float]) -> float | None:
    return avg_active_nps(sorted(t / 1000.0 for t in times_ms))


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


# ---------------------------------------------------------------- .ssc

def notes_to_cells(notes: list[dict]) -> dict[int, list[str]]:
    cells: dict[int, list[str]] = {}
    for n in sorted(notes, key=lambda n: n["row"]):
        _note_into_cells(n, cells)
    return cells


def render_project_ssc(project: dict) -> str:
    song = project["song"]
    ssc_song = Song(
        title=song["title"],
        artist=song["artist"],
        credit=f"{song['creator']} / osu2piu",
        music=song["audioFile"],
        background=song.get("background") or "",
        offset=song["offsetSeconds"],
        sample_start=song["sampleStartSeconds"],
        bpms=[(b, v) for b, v in song["bpms"]],
    )
    for chart in project["charts"]:
        ssc_song.charts.append(Chart(
            description=chart["name"],
            meter=int(chart["level"]),
            cells=notes_to_cells(chart["notes"]),
        ))
    return render_ssc(ssc_song)
