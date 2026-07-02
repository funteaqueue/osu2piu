# osu2piu

Converts osu!standard beatmaps (`.osz`) into pump-single StepMania charts (`.ssc`)
for playing on a Pump It Up machine (XSanity / StepF2).

## Usage

```
# one-time: harvest the pattern library from StepMania packs in training/
python -m osu2piu build-patterns training -o patterns.pkl

# convert (with patterns; omit --patterns for the pure rule generator)
python -m osu2piu convert "path/to/map.osz" -o "D:/piu/XSanity/Songs/ZZ.OSU CONVERTS" --patterns patterns.pkl
python -m osu2piu convert "D:/piu/osu songs" -o "..." --patterns patterns.pkl --seed 42
```

Every osu difficulty in the archive becomes one pump-single chart. Levels are
calibrated against the training corpus (median peak notes-per-second per meter).
Each conversion prints coverage: % of notes from exact pattern matches /
rhythm-only downgrades / rule-generator fallback.

## How it works

1. `osu_parser` reads timing points and hit objects from each `.osu` in the archive.
2. `timing.BeatGrid` maps millisecond timestamps onto a beat grid (12 rows/beat),
   producing `#BPMS`/`#OFFSET` and quantized note rows.
3. `holds.classify` translates objects into TAP/HOLD tokens via the restfulness
   gate (holds are rest in PIU: only breather sliders become holds; returning
   sliders become hold + under-hold taps; spinners become long holds).
4. `matcher.PatternMatcher` stitches harvested phrases over the osu rhythm:
   trigram seed + extend for the longest match, two-panel overlap continuity,
   meter within ±3 of the target level. Timing always comes from osu — patterns
   only supply panels and hold shape.
5. `generator.RuleGenerator` fills anything patterns can't (foot-alternation
   rules, no crossovers, weighted-random panel choice).
6. `ssc_writer` renders the song folder with music + background from the `.osz`.

Details and design rationale: [PLAN.md](PLAN.md).
