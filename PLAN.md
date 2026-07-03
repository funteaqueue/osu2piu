# Pattern library — implementation plan

Goal: harvest leg patterns (taps AND holds) from real pump-single charts in
`training/`, stitch them over osu rhythms. Timing and hold durations ALWAYS
come from the osu map — patterns only supply panels and hold shape. The rule
generator remains the fallback.

## 0. Token vocabulary (shared by harvester and matcher)

A note stream becomes a sequence of tokens `(gap_class, kind)`:

**gap_class** — beat-distance to the previous step, bucketed:

| class  | beat gap        | meaning                    |
|--------|-----------------|----------------------------|
| `FAST` | ≤ 0.30          | 16ths and tighter          |
| `HALF` | 0.30 – 0.70     | 8ths                       |
| `BEAT` | 0.70 – 1.50     | quarter notes              |
| `SLOW` | > 1.50          | rest / phrase boundary     |

**kind** — `TAP`, `HOLD_S` (< 2 beats), `HOLD_L` (≥ 2 beats). Taps carry an
`under_hold` flag when another panel is held at that moment (the hold+tap
idiom). Hold durations are NOT matched on — tails are always placed at the
osu slider's real end time.

Rationale: legs only care about how much time they have to move and whether a
foot is anchored, so matching on classes maximizes coverage while preserving
how a pattern feels. `SLOW` gaps split the stream into phrases — patterns
never span a long rest.

## 1. `sm_parser.py` — read training charts

- Parse `.sm` and `.ssc`; keep only `pump-single` charts with their `#METER`,
  `#BPMS`, note rows.
- Convert rows to steps `(beat, panel, kind, hold_end)`. Holds are parsed
  fully (head `2` … tail `3`); rolls (`4`) count as holds; mines/fakes/lifts
  ignored. Taps under an active hold get `under_hold`.
- v1 simplifications:
  - jumps (2+ panels starting on one row) end the current phrase (skip row);
  - skip charts containing `#WARPS` or negative BPMs (gimmick charts).

## 2. `patterns.py` — build the index

For every chart, slide over each phrase and emit n-grams for n = 2..12:

```
key:   ((gap_1, kind_1), ..., (gap_n, kind_n))   # gap_1 relative to phrase pos
entry: { panels: (p1..pn), under_hold_mask, meter: int, source: str, count: int }
```

- Identical `(key, panels)` entries merge, incrementing `count` — frequency
  becomes selection weight, so idiomatic pump patterns dominate.
- Persist to `patterns.json`. CLI:
  `python -m osu2piu build-patterns training/ -o patterns.json`
  Print stats: charts parsed, phrases, unique keys, share of keys with holds.

## 3. `holds.py` — osu hold intent (restfulness gate)

Decides, per osu object, which kind-token it becomes. Core insight: in PIU a
hold anchors a foot and mostly functions as REST; in osu sliders are flow.
osu!standard objects never overlap, so a slider's rest value is fully
described by its duration and the gap after its tail.

- `rest_score = duration_beats + gap_to_next_note_beats`
- `effort` = generated steps over the trailing ~8 beats (the "does the player
  need a break" meter), optionally weighted by panel travel distance.
- Policy by target level:
  - level ≤ ~5: liberal holds (current duration + randomness rule);
  - mid: hold if `rest_score ≥ 1.5`;
  - high: hold only if `rest_score ≥ 2.5`, OR effort is high and
    `rest_score ≥ 1.5` — otherwise the slider is just a `TAP` on its head.
- Consecutive-hold limiter at all levels: several holds in a row with small
  gaps → force taps (kills the alternating-hold-ladder artifact).
- **Slider with repeats** that passes the gate → `HOLD` + under-hold `TAP`s at
  the repeat timestamps (osu hands us the inner rhythm for hold+tap patterns).
- **Spinner** → `HOLD_L` (rest-section anchor; center-biased if rule-generated).
- Break periods (`[Events]` type 2) are free rest markers: holds ending into
  a break are always safe.

## 4. `matcher.py` — pattern-first generation

Tokenize the osu stream via `holds.py`, then at position `i` within a phrase:

1. For n from MAX down to 2, look up the token key for steps `i..i+n-1`.
   Filter candidates by:
   - **level**: source `meter` within ±3 of the target chart level;
   - **continuity**: candidate's first TWO panels equal the last two placed
     panels (preserves foot alternation); fallback to one-panel overlap;
     no overlap check at phrase start;
   - **hold legality**: no candidate panel may step on a currently-held panel.
2. Weighted-random pick among candidates of the longest matching n
   (weight = `count`). Emit panels at osu timings; hold tails at osu slider
   ends; advance by n − overlap.
3. **Downgrade tier**: no exact key match → retry with all kinds set to `TAP`
   (rhythm-only); impose the hold on the pattern's panel at that position and
   shrink the match if later panels would step on it.
4. Still nothing → `RuleGenerator.step()` for one note, advance 1. The rule
   generator's foot state stays in sync with pattern-emitted steps.

Report per chart: % notes from exact / downgraded / fallback tiers, and the
avg source meter used.

## 5. `difficulty.py` — calibrated levels

- During `build-patterns`, record `(peak_nps, avg_nps, meter)` for every
  training chart → store per-meter median peak_nps in `patterns.json`.
- `estimate_level()` inverts that table (nearest/interpolated lookup);
  falls back to the current `peak_nps * 2.3` heuristic when no data.
- Cross-check: print the pattern-source average meter next to the estimated
  level; large disagreement = heuristic needs tuning.
- Note: at high levels most sliders become taps, so density (and thus level)
  is measured on the GENERATED chart, not on osu object counts.

## 6. Wire into CLI

- `convert` gains `--patterns patterns.json`; without it, pure rule generator
  (which also consults `holds.py` instead of the inline duration check).
- Batch output prints coverage stats per song.

## Later / v2

- ~~Keep jumps as multi-panel tokens~~ DONE: jumps are first-class steps
  (kind `J`, pair chars `A`-`J`); osu-side jumps synthesized on emphasis
  (hitsound finish/clap, phrase boundaries, downbeats) under a corpus budget,
  then matched through patterns like any step. Deliberate gap: notes inside
  fast streams (< 0.45 folded beats of gathering room) never jump — dense
  charts under-jump; a level-scaled gap threshold is the knob if play-testing
  wants stream jumps at 12+.
- Use osu x/y spatial data (stacks → same panel, big cursor jumps → far panel).
- ~~Learn hold placement from training charts~~ DONE: the corpus hold-share
  table (per meter) sets a hold budget; rest_score ranks which sliders win
  the slots. Real charts: ~3% holds at lvl 4, ~12% at lvl 15-21, falling
  again 22+. Note the original per-level threshold policy had this backwards
  (assumed easy = hold-liberal).
