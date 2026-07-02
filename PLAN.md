# Pattern library — implementation plan

Goal: harvest leg patterns from real pump-single charts in `training/`, stitch
them over osu rhythms. Timing ALWAYS comes from the osu map — patterns only
supply the panel (leg) sequence. The rule generator remains the fallback.

## 0. Rhythm vocabulary (shared by harvester and matcher)

A note stream becomes a sequence of *gap classes* — the beat-distance to the
previous note, bucketed:

| class  | beat gap        | meaning                    |
|--------|-----------------|----------------------------|
| `FAST` | ≤ 0.30          | 16ths and tighter          |
| `HALF` | 0.30 – 0.70     | 8ths                       |
| `BEAT` | 0.70 – 1.50     | quarter notes              |
| `SLOW` | > 1.50          | rest / phrase boundary     |

Rationale: legs only care about how much time they have to move, so matching
on classes (not exact gaps, not milliseconds) maximizes library coverage while
preserving how a pattern feels. `SLOW` gaps split the stream into phrases —
patterns never span a long rest.

## 1. `sm_parser.py` — read training charts

- Parse `.sm` and `.ssc`; keep only `pump-single` charts with their `#METER`,
  `#BPMS`, note rows.
- Convert rows to `(beat, panel)` steps. v1 simplifications:
  - jumps (2+ panels on one row) end the current phrase (skip the row);
  - holds count as a step at their head, tails/rolls/mines/fakes ignored;
  - skip charts containing `#WARPS` or negative BPMs (gimmick charts).

## 2. `patterns.py` — build the index

For every chart, slide over each phrase and emit n-grams for n = 2..12:

```
key:   (gap_class_1, ..., gap_class_{n-1})          # n-1 gaps for n steps
entry: { panels: (p1..pn), meter: int, source: str, count: int }
```

- Identical `(key, panels)` entries merge, incrementing `count` — frequency
  becomes selection weight, so idiomatic pump patterns dominate.
- Persist to `patterns.json` (or pickle if slow). CLI:
  `python -m osu2piu build-patterns training/ -o patterns.json`
  Print stats: charts parsed, phrases, unique keys, entries per n.

## 3. `matcher.py` — pattern-first generation

At position `i` in the osu note stream (within one phrase):

1. For n from MAX down to 2: look up the gap-class key for notes `i..i+n-1`.
   Filter candidates by:
   - **level**: source `meter` within ±3 of the target chart level;
   - **continuity**: candidate's first TWO panels equal the last two placed
     panels (preserves foot alternation); fallback to one-panel overlap;
     no overlap check at phrase start.
2. Weighted-random pick among candidates of the longest matching n
   (weight = `count`). Emit panels at the osu timings; advance by n − overlap.
3. No match at any n → `RuleGenerator.step()` for one note, advance 1.
   The rule generator's foot state must be kept in sync with pattern-emitted
   steps (feed placed panels back into it).
4. Holds: slider→hold decision stays as today (duration + randomness); the
   pattern only decides WHICH panel. Skip hold-emission if pattern continuity
   would step on a held panel — fall back to rule generator for that note.

Report per chart: % notes from patterns vs fallback, avg source meter used.

## 4. `difficulty.py` — calibrated levels

- During `build-patterns`, also record `(peak_nps, avg_nps, meter)` for every
  training chart → store per-meter median peak_nps in `patterns.json`.
- `estimate_level()` inverts that table (nearest/interpolated lookup);
  falls back to the current `peak_nps * 2.3` heuristic when no data.
- Cross-check: print the pattern-source average meter next to the estimated
  level; large disagreement = heuristic needs tuning.

## 5. Wire into CLI

- `convert` gains `--patterns patterns.json`; without it, pure rule generator.
- Batch output prints the coverage stats so we can see per song how much
  came from the library.

## Later / v2

- Returning sliders → hold + taps on another panel with the free foot.
- Keep jumps as multi-panel tokens instead of phrase breaks (harder charts).
- Use osu x/y spatial data (stacks → same panel, big jumps → far panel).
- Hold-heavy low difficulties: convert short holds to taps below some level.
