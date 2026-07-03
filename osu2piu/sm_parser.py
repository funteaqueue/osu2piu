"""Parse StepMania .ssc files (StepF2 flavor) into training-chart step data.

Findings from the training corpus this parser is built for:
  * ~94% of charts carry their own #BPMS inside #NOTEDATA — chart-level
    timing wins over the song header;
  * #DIFFICULTY slots are junk (mostly Edit); #METER is the real level,
    with 50/99 marking special/unranked charts;
  * note lines use StepF2 extras: {..} attribute blocks, M mines, F fakes,
    4 rolls, and `// measure N` comment lines.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from pathlib import Path

TAG_RE = re.compile(r"#(\w+):(.*?);", re.S)
CELL_RE = re.compile(r"\{[^}]*\}|\S")

PHRASE_BREAK = math.inf


@dataclass
class Step:
    beat: float          # chart beat of the step
    time: float          # seconds
    fgap: float          # folded-beat gap to the previous step (inf = phrase break)
    panel: int
    is_hold: bool
    fdur: float          # folded-beat hold duration (0 for taps)
    under_hold: bool
    panel2: int | None = None  # second panel of a two-tap jump


@dataclass
class ParsedChart:
    meter: int
    source: str
    steps: list[Step]
    peak_nps: float
    jump_share: float = 0.0  # jump rows / (steps + jump rows)


def fold_bpm(bpm: float) -> float:
    """Fold a tempo into the 90–180 range so that gap classes are comparable
    across notation conventions (osu's 240 == PIU's 120)."""
    while bpm > 180.0:
        bpm /= 2.0
    while bpm < 90.0 and bpm > 0:
        bpm *= 2.0
    return bpm


def parse_ssc_file(path: Path) -> list[ParsedChart]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    parts = text.split("#NOTEDATA:")
    header = dict(TAG_RE.findall(parts[0]))
    charts = []
    for block in parts[1:]:
        chart = _parse_chart(block, header, path.stem)
        if chart is not None:
            charts.append(chart)
    return charts


def _parse_chart(block: str, header: dict, source: str) -> ParsedChart | None:
    tags = dict(TAG_RE.findall(block))
    if tags.get("STEPSTYPE", "").strip() != "pump-single":
        return None
    try:
        meter = int(tags.get("METER", "0").strip())
    except ValueError:
        return None
    if not 1 <= meter <= 26:
        return None

    timing = tags if tags.get("BPMS", "").strip() else header
    # gimmick charts corrupt beat<->time mapping; the corpus is huge, skip them
    for key in ("WARPS", "STOPS", "DELAYS", "FAKES"):
        if timing.get(key, "").strip() or tags.get(key, "").strip():
            return None
    bpms = _parse_bpms(timing.get("BPMS", ""))
    # display-BPM gimmicks (e.g. 175/16 = 10.9375 with 16x row subdivision)
    # stay internally consistent: beat->time is correct and fold_bpm()
    # recovers the real tempo, so only non-positive BPMs are rejected
    if not bpms or any(bpm <= 0 for _, bpm in bpms):
        return None

    notes = tags.get("NOTES")
    if not notes:
        return None
    steps, n_jumps = _rows_to_steps(_parse_rows(notes), bpms)
    if len(steps) < 8:
        return None
    return ParsedChart(meter, source, steps, _peak_nps(steps),
                       n_jumps / len(steps))


def _parse_bpms(raw: str) -> list[tuple[float, float]]:
    out = []
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair or "=" not in pair:
            continue
        beat, bpm = pair.split("=", 1)
        try:
            out.append((float(beat), float(bpm)))
        except ValueError:
            return []
    out.sort()
    return out


def _parse_rows(notes: str) -> list[tuple[float, list[str]]]:
    """-> [(beat, 5 note chars)]; handles comments, {..} blocks, any measure
    resolution (beats stay float, no grid needed for harvesting)."""
    rows = []
    for m_i, measure in enumerate(notes.split(",")):
        lines = []
        for raw in measure.splitlines():
            line = raw.split("//")[0].strip()
            if not line:
                continue
            cells = CELL_RE.findall(line)
            if len(cells) == 5:
                lines.append([_cell_char(c) for c in cells])
        for i, cells in enumerate(lines):
            rows.append((m_i * 4.0 + i * 4.0 / len(lines), cells))
    return rows


def _cell_char(cell: str) -> str:
    ch = cell[1] if cell.startswith("{") and len(cell) > 1 else cell
    return ch if ch in "1234" else "0"  # mines/fakes/decorations -> empty


def _rows_to_steps(rows: list[tuple[float, list[str]]],
                   bpms: list[tuple[float, float]]) -> tuple[list[Step], int]:
    clock = _BeatClock(bpms)
    events = []       # [beat, panel, tail_beat | None, panel2 | None]
    open_holds: dict[int, float] = {}
    breaks: list[float] = []
    n_jumps = 0

    for beat, cells in rows:
        for col, ch in enumerate(cells):
            if ch == "3" and col in open_holds:
                events.append([open_holds.pop(col), col, beat, None])
        starts = [c for c, ch in enumerate(cells) if ch in "124"]
        if len(starts) == 2 and all(cells[c] == "1" for c in starts):
            n_jumps += 1  # plain two-tap jump: a first-class step
            events.append([beat, starts[0], None, starts[1]])
            continue
        if len(starts) >= 2:
            # brackets / jump-holds stay out of scope: break the phrase
            breaks.append(beat)
            continue
        for col in starts:
            if cells[col] == "1":
                events.append([beat, col, None, None])
            else:
                open_holds[col] = beat
    for col, head in open_holds.items():  # unclosed holds degrade to taps
        events.append([head, col, None, None])
    events.sort(key=lambda e: e[0])

    steps: list[Step] = []
    prev_beat = prev_time = None
    break_i = 0
    for beat, panel, tail, panel2 in events:
        time = clock.time_at(beat)
        fbpm = fold_bpm(clock.bpm_at(beat))
        while break_i < len(breaks) and breaks[break_i] <= beat:
            break_i += 1
        broke = break_i > 0 and prev_beat is not None and breaks[break_i - 1] > prev_beat
        if prev_time is None or broke:
            fgap = PHRASE_BREAK
        else:
            fgap = (time - prev_time) * fold_bpm(clock.bpm_at(prev_beat)) / 60.0
        fdur = 0.0
        if tail is not None:
            fdur = (clock.time_at(tail) - time) * fbpm / 60.0
        under = panel2 is None and any(
            e[2] is not None and e[0] < beat < e[2] and e[1] != panel
            for e in events
        )
        steps.append(Step(beat, time, fgap, panel, tail is not None, fdur,
                          under, panel2))
        prev_beat, prev_time = beat, time
    return steps, n_jumps


class _BeatClock:
    """beat -> seconds and beat -> bpm over piecewise-constant BPM segments."""

    def __init__(self, bpms: list[tuple[float, float]]):
        self.segs = []  # (start_beat, bpm, start_time_seconds)
        t = 0.0
        for i, (beat, bpm) in enumerate(bpms):
            if i > 0:
                pb, pbpm, pt = self.segs[-1]
                t = pt + (beat - pb) * 60.0 / pbpm
            self.segs.append((beat, bpm, t))

    def _seg(self, beat: float):
        seg = self.segs[0]
        for s in self.segs:
            if s[0] <= beat + 1e-9:
                seg = s
            else:
                break
        return seg

    def time_at(self, beat: float) -> float:
        b0, bpm, t0 = self._seg(beat)
        return t0 + (beat - b0) * 60.0 / bpm

    def bpm_at(self, beat: float) -> float:
        return self._seg(beat)[1]


def _peak_nps(steps: list[Step], window: float = 5.0) -> float:
    times = [s.time for s in steps]
    peak, j = 0, 0
    for i, t in enumerate(times):
        while times[j] < t - window:
            j += 1
        peak = max(peak, i - j + 1)
    return peak / window
