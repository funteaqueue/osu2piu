"""Seed-and-extend pattern matching over the harvested phrase library.

At each position in the osu event stream the matcher:
  1. seeds on a trigram lookup (window starts 2 steps back so the candidate's
     first two panels must equal the last two placed panels — foot-alternation
     continuity), falling back to 1-panel overlap, then no overlap at
     phrase starts;
  2. extends every seeded candidate token-by-token to find the longest match
     (capped at MAX_MATCH), filtered by source meter and hold legality;
  3. picks uniformly among the longest candidates — frequency weighting is
     implicit because common patterns occupy many index positions;
  4. downgrade tier: if the exact rhythm+kind key misses, retries with all
     kinds as TAP and imposes the osu holds onto the borrowed panels.
"""
from __future__ import annotations

import random
from dataclasses import dataclass

from .holds import NoteEvent
from .patterns import MAX_MATCH, POS_SHIFT, Library

MAX_SEEDS = 400        # positions sampled per trigram bucket
METER_WINDOW = 3       # |source meter - target level| tolerance


@dataclass
class Emission:
    panels: list[str]   # panel chars ('0'-'4' or pair 'A'-'J'), one per event
    tier: str           # 'exact' | 'downgrade'
    source_meter: int


class PatternMatcher:
    def __init__(self, lib: Library, rng: random.Random, target_level: int):
        self.lib = lib
        self.rng = rng
        self.level = target_level
        # closest sources first; when widening, easy charts may reach DOWN
        # freely but barely UP — a level-5 pattern has turns a level-2
        # player can't read, while the reverse is merely easy.
        up = 1 if target_level <= 5 else METER_WINDOW
        self.meter_ranges = [
            (target_level - 1, target_level + 1),
            (target_level - METER_WINDOW, target_level + up),
        ]

    def match(self, events: list[NoteEvent], tokens: list[str], i: int,
              placed: list[str | None], active_holds: dict[int, float],
              phrase_start: int) -> Emission | None:
        """events/tokens: full streams; i: index to generate from; placed:
        panels for events[:i] (None where dropped); active_holds:
        panel -> end_beat currently anchored."""
        for lo, hi in self.meter_ranges:
            for exact in (True, False):
                for overlap in (2, 1, 0):
                    if i - overlap < phrase_start:
                        continue
                    if overlap == 0 and i != phrase_start:
                        continue  # mid-phrase matches must chain onto placed feet
                    if overlap and any(p is None for p in placed[i - overlap:i]):
                        continue
                    em = self._try(events, tokens, i, overlap, placed,
                                   active_holds, exact, lo, hi)
                    if em:
                        return em
        return None

    def _try(self, events, tokens, i, overlap, placed, active_holds,
             exact, lo, hi) -> Emission | None:
        start = i - overlap
        window = tokens[start:start + MAX_MATCH]
        if len(window) < 3 or len(window) <= overlap:
            return None
        if not exact:  # rhythm-only tier: relax holds to taps, keep jumps
            window = [t[0] + ("T" if t[1] in "OL" else t[1]) for t in window]
        key = "".join(window[:3])
        bucket = self.lib.tri.get(key)
        if not bucket:
            return None
        seeds = (self.rng.sample(list(bucket), MAX_SEEDS)
                 if len(bucket) > MAX_SEEDS else bucket)

        best_len, best = 0, []
        for pos in seeds:
            ph = self.lib.phrases[pos // POS_SHIFT]
            if not lo <= ph["m"] <= hi:
                continue
            off = pos % POS_SHIFT
            tok, panels = ph["t"], ph["p"]
            if overlap and panels[off:off + overlap] != "".join(placed[start:i]):
                continue
            n = 3
            limit = min(len(window), len(tok) // 2 - off)
            while n < limit and tok[(off + n) * 2:(off + n + 1) * 2] == window[n]:
                n += 1
            emitted = self._legalize(
                list(panels[off + overlap:off + n]), events, i, active_holds)
            if not emitted:
                continue
            total = overlap + len(emitted)
            if total > best_len:
                best_len, best = total, [(emitted, ph["m"])]
            elif total == best_len:
                best.append((emitted, ph["m"]))

        if best_len <= max(overlap, 1) + 1:  # must emit >= 2 steps to beat
            return None                      # the rule-generator fallback
        panels, meter = self.rng.choice(best)
        return Emission(panels, "exact" if exact else "downgrade", meter)

    @staticmethod
    def _legalize(panels: list[str], events, i,
                  active_holds: dict[int, float]) -> list[str]:
        """Truncate an emission before any step that lands on a held panel.
        Holds declared by the osu events themselves anchor their candidate
        panel until their real end beat."""
        from .patterns import decode_panels
        active = dict(active_holds)
        out = []
        for k, char in enumerate(panels):
            ev = events[i + k]
            active = {p: end for p, end in active.items() if end > ev.beat + 1e-6}
            decoded = decode_panels(char)
            if any(p in active for p in decoded):
                break
            if ev.kind in "OL":
                active[decoded[0]] = ev.end_beat
            out.append(char)
        return out
