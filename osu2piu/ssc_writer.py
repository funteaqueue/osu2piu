"""Render converted charts into a StepMania .ssc file."""
from __future__ import annotations

from dataclasses import dataclass, field

from .timing import ROWS_PER_MEASURE

# smallest note-line counts per measure that the 48-row grid can collapse to
MEASURE_LINE_OPTIONS = (4, 8, 12, 16, 24, 48)

# StepMania difficulty slots, assigned to charts in ascending level order
DIFFICULTY_SLOTS = ("Beginner", "Easy", "Medium", "Hard", "Challenge")


@dataclass
class Chart:
    description: str                      # osu difficulty name
    meter: int
    cells: dict[int, list[str]]           # row -> 5 note chars
    dropped: int = 0
    stats: dict = field(default_factory=dict)   # exact/downgrade/fallback counts
    avg_source_meter: float = 0.0


@dataclass
class Song:
    title: str
    artist: str
    credit: str
    music: str
    background: str
    offset: float
    sample_start: float
    bpms: list[tuple[float, float]]
    charts: list[Chart] = field(default_factory=list)


def render_ssc(song: Song) -> str:
    bpms = ",\n".join(f"{beat:.3f}={bpm:.3f}" for beat, bpm in song.bpms)
    head = [
        "#VERSION:0.83;",
        f"#TITLE:{_esc(song.title)};",
        f"#ARTIST:{_esc(song.artist)};",
        f"#CREDIT:{_esc(song.credit)};",
        f"#BANNER:;",
        f"#BACKGROUND:{_esc(song.background)};",
        f"#MUSIC:{_esc(song.music)};",
        f"#OFFSET:{song.offset:.6f};",
        f"#SAMPLESTART:{song.sample_start:.3f};",
        "#SAMPLELENGTH:12.000;",
        "#SELECTABLE:YES;",
        f"#BPMS:{bpms};",
        "#STOPS:;",
        "#DELAYS:;",
        "#WARPS:;",
        "#TIMESIGNATURES:0.000=4=4;",
        "#TICKCOUNTS:0.000=4;",
        "#COMBOS:0.000=1;",
        "#SPEEDS:0.000=1.000=0.000=0;",
        "#SCROLLS:0.000=1.000;",
        "#FAKES:;",
        "#LABELS:0.000=Song Start;",
    ]
    parts = ["\n".join(head)]

    for i, chart in enumerate(sorted(song.charts, key=lambda c: c.meter)):
        slot = DIFFICULTY_SLOTS[i] if i < len(DIFFICULTY_SLOTS) else "Edit"
        parts.append(
            f"\n//---------------pump-single - {chart.description}----------------\n"
            "#NOTEDATA:;\n"
            f"#CHARTNAME:{_esc(chart.description)};\n"
            "#STEPSTYPE:pump-single;\n"
            f"#DESCRIPTION:{_esc(chart.description)};\n"
            f"#DIFFICULTY:{slot};\n"
            f"#METER:{chart.meter};\n"
            "#RADARVALUES:0,0,0,0,0;\n"
            "#CREDIT:osu2piu;\n"
            f"#NOTES:\n{_render_notes(chart.cells)}\n;"
        )
    return "\n".join(parts) + "\n"


def _render_notes(cells: dict[int, list[str]]) -> str:
    if not cells:
        return "\n".join(["00000"] * 4)
    n_measures = max(cells) // ROWS_PER_MEASURE + 1
    measures = []
    for m in range(n_measures):
        base = m * ROWS_PER_MEASURE
        rows = {r - base: v for r, v in cells.items() if base <= r < base + ROWS_PER_MEASURE}
        lines = next(
            n for n in MEASURE_LINE_OPTIONS
            if all(r % (ROWS_PER_MEASURE // n) == 0 for r in rows)
        )
        step = ROWS_PER_MEASURE // lines
        measures.append(
            "\n".join("".join(rows[i * step]) if i * step in rows else "00000"
                      for i in range(lines))
        )
    return "\n,\n".join(measures)


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace(";", "\\;").replace("#", "\\#")
