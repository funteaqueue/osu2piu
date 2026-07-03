"""Chart metrics: one vocabulary for generated charts and corpus charts,
so a conversion can be compared against real songs of the same level.

  peakNps    burst density (5 s window)
  avgNps     sustained density over active time
  p95Nps     rate of the fastest 5% of steps
  fastShare  fraction of steps within 115 ms of the previous one
  holdShare  fraction of steps that are holds
  jumpShare  fraction of steps that press two panels
  travel     mean pad distance between consecutive steps (panel units)
"""
from __future__ import annotations

import json
import re
import statistics
from pathlib import Path

from .patterns import avg_active_nps, fast_share, p95_speed
from .sm_parser import parse_ssc_file

# physical pad coordinates, panel units: DL, UL, C, UR, DR
PANEL_XY = ((-1.0, -1.0), (-1.0, 1.0), (0.0, 0.0), (1.0, 1.0), (1.0, -1.0))

# a gap this long is a rest: feet reposition for free, travel doesn't count
TRAVEL_MAX_GAP_S = 2.0

METRIC_KEYS = ("peakNps", "avgNps", "p95Nps", "fastShare", "holdShare",
               "jumpShare", "travel")

DENSITY_WINDOW_S = 5.0

TITLE_RE = re.compile(r"#TITLE:(.*?);", re.S)


def step_metrics(rows: list[tuple[float, tuple[int, ...], bool]]) -> dict:
    """rows: (time_seconds, panels, is_hold) per step row, any order."""
    rows = sorted(rows)
    times = [r[0] for r in rows]
    n = len(rows)
    if not n:
        return {k: None for k in METRIC_KEYS} | {"steps": 0}
    return {
        "peakNps": _peak_nps(times),
        "avgNps": avg_active_nps(times),
        "p95Nps": p95_speed(times),
        "fastShare": fast_share(times),
        "holdShare": sum(1 for r in rows if r[2]) / n,
        "jumpShare": sum(1 for r in rows if len(r[1]) >= 2) / n,
        "travel": _travel(rows),
        "steps": n,
    }


def _peak_nps(times: list[float]) -> float:
    if len(times) < 2:
        return 0.5
    peak, j = 0, 0
    for i, t in enumerate(times):
        while times[j] < t - DENSITY_WINDOW_S:
            j += 1
        peak = max(peak, i - j + 1)
    return peak / DENSITY_WINDOW_S


def _travel(rows) -> float | None:
    dists = []
    for (t0, p0, _), (t1, p1, _) in zip(rows, rows[1:]):
        if t1 - t0 > TRAVEL_MAX_GAP_S or t1 - t0 <= 0:
            continue
        x0 = sum(PANEL_XY[p][0] for p in p0) / len(p0)
        y0 = sum(PANEL_XY[p][1] for p in p0) / len(p0)
        x1 = sum(PANEL_XY[p][0] for p in p1) / len(p1)
        y1 = sum(PANEL_XY[p][1] for p in p1) / len(p1)
        dists.append(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5)
    return sum(dists) / len(dists) if len(dists) >= 8 else None


def notes_metrics(notes: list[dict], grid) -> dict:
    """Metrics of a generated chart (chart-JSON notes + a grid with
    row->ms mapping)."""
    from .chartjson import row_time_ms
    by_row: dict[int, tuple[set, bool]] = {}
    for n in notes:
        panels, hold = by_row.setdefault(n["row"], (set(), False))
        panels.update(n["panels"])
        by_row[n["row"]] = (panels, hold or n.get("holdEndRow") is not None)
    rows = [(row_time_ms(grid, row) / 1000.0, tuple(panels), hold)
            for row, (panels, hold) in by_row.items()]
    return step_metrics(rows)


# ---------------------------------------------------------------- corpus

def build_corpus_index(training_dir: str, out_path: str) -> dict:
    """Scan a StepMania pack tree, compute metrics for every pump-single
    chart, and store them plus per-level medians as JSON."""
    charts = []
    files = sorted(Path(training_dir).rglob("*.ssc"))
    for i, f in enumerate(files):
        parsed = parse_ssc_file(f)
        if not parsed:
            continue
        try:
            m = TITLE_RE.search(f.read_text(encoding="utf-8", errors="replace"))
            title = m.group(1).strip() if m else f.stem
        except OSError:
            title = f.stem
        for chart in parsed:
            rows = [(s.time,
                     (s.panel,) if s.panel2 is None else (s.panel, s.panel2),
                     s.is_hold)
                    for s in chart.steps]
            charts.append({"title": title, "meter": chart.meter,
                           "metrics": step_metrics(rows)})
        if (i + 1) % 500 == 0:
            print(f"  {i + 1}/{len(files)} files, {len(charts)} charts")

    levels: dict[str, dict] = {}
    by_meter: dict[int, list[dict]] = {}
    for c in charts:
        by_meter.setdefault(c["meter"], []).append(c["metrics"])
    for meter, ms in by_meter.items():
        if len(ms) < 5:
            continue
        entry: dict = {"count": len(ms)}
        for key in METRIC_KEYS:
            vals = [m[key] for m in ms if m[key] is not None]
            entry[key] = statistics.median(vals) if len(vals) >= 5 else None
        levels[str(meter)] = entry

    index = {"charts": charts, "levels": levels}
    Path(out_path).write_text(json.dumps(index), encoding="utf-8")
    print(f"corpus index: {len(charts)} charts, levels "
          f"{sorted(int(k) for k in levels)} -> {out_path}")
    return index


def load_corpus_index(path: str) -> dict | None:
    p = Path(path)
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))
