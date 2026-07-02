"""Rule-based, foot-aware step generator for pump-single.

Panels (StepMania pump-single column order):
    0 = down-left, 1 = up-left, 2 = center, 3 = up-right, 4 = down-right

Core rules for comfortable low-level charts:
  * feet alternate on consecutive notes;
  * the left foot only plays DL/UL/C, the right foot only DR/UR/C (no crossovers);
  * fast consecutive notes prefer to stay on the same panel;
  * never step where the other foot is currently holding;
  * both feet piling onto center is forbidden.

Panel choice within those constraints is weighted-random, so every conversion
comes out different unless a seed is fixed.
"""
from __future__ import annotations

import random

DL, UL, C, UR, DR = range(5)
FOOT_PANELS = {"L": (DL, UL, C), "R": (C, UR, DR)}
HOME = {"L": DL, "R": DR}

# gaps at or below this many beats count as "fast" (16ths and tighter)
FAST_GAP = 0.26
# gaps at or above this many beats count as a rest that resets the flow
REST_GAP = 2.0


def _other(foot: str) -> str:
    return "L" if foot == "R" else "R"


class RuleGenerator:
    def __init__(self, rng: random.Random):
        self.rng = rng
        self.next_foot = rng.choice("LR")
        self.pos = {"L": DL, "R": DR}
        self.hold_until = {"L": -1.0, "R": -1.0}
        self.last_panel: int | None = None
        self.last_beat: float | None = None

    def step(self, beat: float, hold_end: float | None = None,
             fgap: float | None = None) -> int | None:
        """Pick a panel for a note at `beat`. Returns None if the note must be
        dropped (both feet busy holding, or no comfortable panel exists).
        `fgap` is the tempo-folded gap to the previous note; when omitted the
        raw beat distance is used."""
        if fgap is not None:
            gap = None if self.last_beat is None else fgap
        else:
            gap = None if self.last_beat is None else beat - self.last_beat

        foot = self.next_foot
        other = _other(foot)
        if self._is_holding(foot, beat):
            foot, other = other, foot
        if self._is_holding(foot, beat):
            return None  # both feet occupied by holds

        # after a rest either free foot may lead
        if (gap is None or gap >= REST_GAP) and not self._is_holding(other, beat):
            if self.rng.random() < 0.5:
                foot, other = other, foot

        panels, weights = [], []
        for p in FOOT_PANELS[foot]:
            if self._is_holding(other, beat) and p == self.pos[other]:
                continue
            w = 1.0
            if p == self.pos[foot]:
                w *= 3.0 if (gap is not None and gap <= FAST_GAP) else 1.4
            if p == HOME[foot]:
                w *= 1.8
            if p == C and self.pos[other] == C:
                w = 0.0
            if p == self.last_panel and p != self.pos[foot]:
                w *= 0.4  # stepping the panel the other foot just left is awkward
            if w > 0:
                panels.append(p)
                weights.append(w)

        if not panels:
            return None
        panel = self.rng.choices(panels, weights)[0]

        self.pos[foot] = panel
        self.last_panel = panel
        self.last_beat = beat
        self.next_foot = other
        if hold_end is not None:
            self.hold_until[foot] = hold_end
        return panel

    def observe(self, beat: float, panel: int, hold_end: float | None = None) -> None:
        """Sync foot state with a step placed by the pattern matcher, so the
        rule generator continues cleanly after pattern-emitted sections."""
        if panel in (DL, UL):
            foot = "L"
        elif panel in (UR, DR):
            foot = "R"
        else:
            foot = self.next_foot
            if self._is_holding(foot, beat):
                foot = _other(foot)
        self.pos[foot] = panel
        self.last_panel = panel
        self.last_beat = beat
        self.next_foot = _other(foot)
        if hold_end is not None:
            self.hold_until[foot] = hold_end

    def _is_holding(self, foot: str, beat: float) -> bool:
        return self.hold_until[foot] > beat + 1e-6
