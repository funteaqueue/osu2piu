"""Pattern library: harvest phrases from training charts, index them for
seed-and-extend matching, and hold the difficulty calibration table.

Storage model (scaled for ~12k charts / ~5M steps): every phrase is stored
once; a trigram index maps 3-token keys to (phrase, offset) positions. The
matcher seeds on a trigram lookup and extends the match token by token —
longest-match with frequency weighting emerging from position counts.

Token = 2 chars: gap class + kind.
  gap:  F (<=0.30 folded beats), H (<=0.70), B (<=1.50), S (rest / phrase start)
  kind: T tap, O hold < 2 folded beats, L hold >= 2
"""
from __future__ import annotations

import pickle
import statistics
from array import array
from collections import defaultdict
from pathlib import Path

from .sm_parser import Step, parse_ssc_file

MAX_MATCH = 12          # longest pattern (in steps) the matcher will use
PHRASE_SPLIT_GAP = 1.50  # folded beats; > this = new phrase
POS_SHIFT = 4096         # position encoding: phrase_id * POS_SHIFT + offset


def gap_class(fgap: float) -> str:
    if fgap <= 0.30:
        return "F"
    if fgap <= 0.70:
        return "H"
    if fgap <= 1.50:
        return "B"
    return "S"


def kind_char(is_hold: bool, fdur: float) -> str:
    if not is_hold:
        return "T"
    return "L" if fdur >= 2.0 else "O"


def step_token(step: Step) -> str:
    return gap_class(step.fgap) + kind_char(step.is_hold, step.fdur)


class Library:
    def __init__(self, phrases, tri, level_table, hold_share=None, avg_table=None):
        self.phrases = phrases          # list of {t, p, u, m}
        self.tri = tri                  # 6-char token key -> array('Q') of positions
        self.level_table = level_table  # meter -> median peak_nps
        self.hold_share = hold_share or {}  # meter -> fraction of steps that hold
        self.avg_table = avg_table or {}    # meter -> median sustained nps

    def save(self, path: str) -> None:
        with open(path, "wb") as f:
            pickle.dump(
                {"phrases": self.phrases, "tri": self.tri,
                 "level_table": self.level_table, "hold_share": self.hold_share,
                 "avg_table": self.avg_table},
                f, protocol=pickle.HIGHEST_PROTOCOL,
            )

    @classmethod
    def load(cls, path: str) -> "Library":
        with open(path, "rb") as f:
            d = pickle.load(f)
        return cls(d["phrases"], d["tri"], d["level_table"],
                   d.get("hold_share"), d.get("avg_table"))

    def estimate_level(self, peak_nps: float, avg_nps: float | None = None) -> int:
        """Two rulers: burst level (peak density) and stamina level (sustained
        density). osu conversions often rest less than real charts of the same
        peak, so the average of the two catches 'never lets you breathe'."""
        if not self.level_table:
            return max(1, min(24, round(peak_nps * 2.3)))
        lvl_p = min(self.level_table, key=lambda m: abs(self.level_table[m] - peak_nps))
        if avg_nps is None or not self.avg_table:
            return lvl_p
        lvl_a = min(self.avg_table, key=lambda m: abs(self.avg_table[m] - avg_nps))
        return int((lvl_p + lvl_a) / 2.0 + 0.5)  # ties round toward stamina

    def hold_target(self, level: int) -> float | None:
        """Fraction of notes that real charts of this level make holds."""
        if not self.hold_share:
            return None
        nearest = min(self.hold_share, key=lambda m: abs(m - level))
        return self.hold_share[nearest]


def build_library(training_dir: str, out_path: str) -> Library:
    phrases: list[dict] = []
    nps_by_meter: dict[int, list[float]] = defaultdict(list)
    share_by_meter: dict[int, list[float]] = defaultdict(list)  # per-chart hold shares
    files = sorted(Path(training_dir).rglob("*.ssc"))
    n_charts = 0

    avg_by_meter: dict[int, list[float]] = defaultdict(list)
    for i, f in enumerate(files):
        for chart in parse_ssc_file(f):
            n_charts += 1
            nps_by_meter[chart.meter].append(chart.peak_nps)
            share_by_meter[chart.meter].append(
                sum(1 for s in chart.steps if s.is_hold) / len(chart.steps))
            duration = chart.steps[-1].time - chart.steps[0].time
            if duration > 20.0:
                avg_by_meter[chart.meter].append(len(chart.steps) / duration)
            for phrase_steps in _split_phrases(chart.steps):
                phrases.append(_encode_phrase(phrase_steps, chart.meter))
        if (i + 1) % 500 == 0:
            print(f"  parsed {i + 1}/{len(files)} files, "
                  f"{n_charts} charts, {len(phrases)} phrases")

    tri: dict[str, array] = defaultdict(lambda: array("Q"))
    for pid, ph in enumerate(phrases):
        tok = ph["t"]
        n = len(tok) // 2
        for off in range(min(n - 2, POS_SHIFT - 1)):
            tri[tok[off * 2:(off + 3) * 2]].append(pid * POS_SHIFT + off)

    level_table = {
        m: statistics.median(v) for m, v in nps_by_meter.items() if len(v) >= 5
    }
    # median among charts that USE holds: zero-hold charts (~45% at low meters!)
    # correspond to osu maps with nothing to hold, which self-select out via
    # slider eligibility — they must not dilute the budget.
    hold_share = {}
    for m, shares in share_by_meter.items():
        users = [s for s in shares if s > 0]
        if len(users) >= 10 and m in level_table:
            hold_share[m] = statistics.median(users)
    avg_table = {
        m: statistics.median(v) for m, v in avg_by_meter.items()
        if len(v) >= 5 and m in level_table
    }
    lib = Library(phrases, dict(tri), level_table, hold_share, avg_table)
    lib.save(out_path)

    n_steps = sum(len(p["p"]) for p in phrases)
    n_hold_keys = sum(1 for k in lib.tri if "O" in k or "L" in k)
    print(f"library: {n_charts} charts, {len(phrases)} phrases, {n_steps} steps")
    print(f"         {len(lib.tri)} trigram keys ({n_hold_keys} contain holds)")
    print(f"         level table: { {m: round(v, 1) for m, v in sorted(level_table.items())} }")
    return lib


def _split_phrases(steps: list[Step]) -> list[list[Step]]:
    phrases, current = [], []
    for s in steps:
        if current and (s.fgap > PHRASE_SPLIT_GAP):
            if len(current) >= 2:
                phrases.append(current)
            current = []
        current.append(s)
    if len(current) >= 2:
        phrases.append(current)
    return phrases


def _encode_phrase(steps: list[Step], meter: int) -> dict:
    tok, panels, under = [], [], []
    for i, s in enumerate(steps):
        tok.append(("S" + kind_char(s.is_hold, s.fdur)) if i == 0 else step_token(s))
        panels.append(str(s.panel))
        under.append("1" if s.under_hold else "0")
    return {"t": "".join(tok), "p": "".join(panels), "u": "".join(under), "m": meter}
