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
# > this many folded beats = new phrase. Above the SLOW gap-class boundary
# (1.5) so half-note rhythms (2.0) chain within a phrase; a real rest splits.
PHRASE_SPLIT_GAP = 2.50
POS_SHIFT = 4096         # position encoding: phrase_id * POS_SHIFT + offset


# jump pairs encode as single panel-string chars 'A'..'J'
PAIRS = [(a, b) for a in range(5) for b in range(a + 1, 5)]
PAIR_CHAR = {p: chr(ord("A") + i) for i, p in enumerate(PAIRS)}
PAIR_DECODE = {c: p for p, c in PAIR_CHAR.items()}


def panel_char(panel: int, panel2: int | None = None) -> str:
    if panel2 is None:
        return str(panel)
    return PAIR_CHAR[(panel, panel2) if panel < panel2 else (panel2, panel)]


def decode_panels(char: str) -> tuple[int, ...]:
    return (int(char),) if char in "01234" else PAIR_DECODE[char]


def gap_class(fgap: float) -> str:
    if fgap <= 0.30:
        return "F"
    if fgap <= 0.70:
        return "H"
    if fgap <= 1.50:
        return "B"
    return "S"


def kind_char(is_hold: bool, fdur: float, is_jump: bool = False) -> str:
    if is_jump:
        return "J"
    if not is_hold:
        return "T"
    return "L" if fdur >= 2.0 else "O"


def step_token(step: Step) -> str:
    return gap_class(step.fgap) + kind_char(step.is_hold, step.fdur,
                                            step.panel2 is not None)


def p95_speed(times_s: list[float]) -> float | None:
    """Instantaneous rate (nps) of the fastest 5% of steps — the 'hardest
    moment' ruler. Short bursts vanish in windowed density but dominate
    how hard a chart FEELS."""
    gaps = sorted(b - a for a, b in zip(times_s, times_s[1:]))
    gaps = [g for g in gaps if g > 0.01]
    if len(gaps) < 20:
        return None
    return 1.0 / gaps[max(0, int(len(gaps) * 0.05) - 1)]


MAX_COUNTED_GAP_S = 2.0  # breaks credit at most this much rest toward avg density


def avg_active_nps(times_s: list[float]) -> float | None:
    """Sustained density over ACTIVE time: each inter-note gap counts at most
    MAX_COUNTED_GAP_S, so mid-song breaks don't dilute the stamina ruler."""
    if len(times_s) < 2:
        return None
    active = sum(min(b - a, MAX_COUNTED_GAP_S) for a, b in zip(times_s, times_s[1:]))
    return len(times_s) / active if active > 15.0 else None


FAST_STEP_S = 0.115  # a step this soon after the previous one is "fast"


def fast_share(times_s: list[float]) -> float | None:
    """Fraction of steps arriving within FAST_STEP_S of the previous one —
    how much of the chart IS the fast content."""
    gaps = [b - a for a, b in zip(times_s, times_s[1:]) if b - a > 0.01]
    if len(gaps) < 20:
        return None
    return sum(1 for g in gaps if g <= FAST_STEP_S) / len(gaps)


class Library:
    def __init__(self, phrases, tri, level_table, hold_share=None,
                 avg_table=None, speed_table=None, jump_share=None):
        self.phrases = phrases          # list of {t, p, u, m}
        self.tri = tri                  # 6-char token key -> array('Q') of positions
        self.level_table = level_table  # meter -> median peak_nps
        self.hold_share = hold_share or {}  # meter -> fraction of steps that hold
        self.avg_table = avg_table or {}    # meter -> median sustained nps
        self.speed_table = speed_table or {}  # meter -> median p95 step speed
        self.jump_share = jump_share or {}    # meter -> mean fraction of jump rows

    def save(self, path: str) -> None:
        with open(path, "wb") as f:
            pickle.dump(
                {"phrases": self.phrases, "tri": self.tri,
                 "level_table": self.level_table, "hold_share": self.hold_share,
                 "avg_table": self.avg_table, "speed_table": self.speed_table,
                 "jump_share": self.jump_share},
                f, protocol=pickle.HIGHEST_PROTOCOL,
            )

    @classmethod
    def load(cls, path: str) -> "Library":
        with open(path, "rb") as f:
            d = pickle.load(f)
        return cls(d["phrases"], d["tri"], d["level_table"],
                   d.get("hold_share"), d.get("avg_table"),
                   d.get("speed_table"), d.get("jump_share"))

    def estimate_level(self, peak_nps: float, avg_nps: float | None = None,
                       speed: float | None = None,
                       fast_share: float | None = None) -> int:
        """Three rulers — burst density (peak), stamina (sustained density),
        absolute speed of the hardest moments — averaged; PLUS a skill gate:
        a player must survive the hardest demand, so when fast steps are a
        real presence (fast_share), the speed ruler acts as a floor rather
        than being averaged away. Rare bursts discount the floor by 1."""
        if not self.level_table:
            return max(1, min(24, round(peak_nps * 2.3)))
        rulers = [min(self.level_table,
                      key=lambda m: abs(self.level_table[m] - peak_nps))]
        if avg_nps is not None and self.avg_table:
            rulers.append(min(self.avg_table,
                              key=lambda m: abs(self.avg_table[m] - avg_nps)))
        lvl_speed = None
        if speed is not None and self.speed_table:
            lvl_speed = min(self.speed_table,
                            key=lambda m: abs(self.speed_table[m] - speed))
            rulers.append(lvl_speed)
        level = int(sum(rulers) / len(rulers) + 0.5)
        if lvl_speed is not None and fast_share is not None and fast_share >= 0.02:
            # the speed table holds MEDIANS — a chart one or two levels below
            # can still legitimately contain such bursts, so small fast shares
            # discount the floor harder
            if fast_share >= 0.15:
                discount = 0
            elif fast_share >= 0.08:
                discount = 1
            else:
                discount = 2
            level = max(level, lvl_speed - discount)
        return level

    def hold_target(self, level: int) -> float | None:
        """Fraction of notes that real charts of this level make holds."""
        if not self.hold_share:
            return None
        nearest = min(self.hold_share, key=lambda m: abs(m - level))
        return self.hold_share[nearest]

    def jump_target(self, level: int) -> float | None:
        """Fraction of rows that real charts of this level make jumps."""
        if not self.jump_share:
            return None
        nearest = min(self.jump_share, key=lambda m: abs(m - level))
        return self.jump_share[nearest]


def build_library(training_dir: str, out_path: str) -> Library:
    phrases: list[dict] = []
    nps_by_meter: dict[int, list[float]] = defaultdict(list)
    share_by_meter: dict[int, list[float]] = defaultdict(list)  # per-chart hold shares
    files = sorted(Path(training_dir).rglob("*.ssc"))
    n_charts = 0

    avg_by_meter: dict[int, list[float]] = defaultdict(list)
    speed_by_meter: dict[int, list[float]] = defaultdict(list)
    jump_by_meter: dict[int, list[float]] = defaultdict(list)
    for i, f in enumerate(files):
        for chart in parse_ssc_file(f):
            n_charts += 1
            nps_by_meter[chart.meter].append(chart.peak_nps)
            share_by_meter[chart.meter].append(
                sum(1 for s in chart.steps if s.is_hold) / len(chart.steps))
            avg = avg_active_nps([s.time for s in chart.steps])
            if avg is not None:
                avg_by_meter[chart.meter].append(avg)
            spd = p95_speed([s.time for s in chart.steps])
            if spd is not None:
                speed_by_meter[chart.meter].append(spd)
            jump_by_meter[chart.meter].append(chart.jump_share)
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
    speed_table = {
        m: statistics.median(v) for m, v in speed_by_meter.items()
        if len(v) >= 5 and m in level_table
    }
    # median: nearly every chart jumps (99%), and the mean is inflated by
    # jump-heavy outliers — the typical chart is the right budget
    jump_share = {
        m: statistics.median(v) for m, v in jump_by_meter.items()
        if len(v) >= 10 and m in level_table
    }
    lib = Library(phrases, dict(tri), level_table, hold_share, avg_table,
                  speed_table, jump_share)
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
        kind = kind_char(s.is_hold, s.fdur, s.panel2 is not None)
        tok.append(("S" + kind) if i == 0 else step_token(s))
        panels.append(panel_char(s.panel, s.panel2))
        under.append("1" if s.under_hold else "0")
    return {"t": "".join(tok), "p": "".join(panels), "u": "".join(under), "m": meter}
