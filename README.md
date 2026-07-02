# osu2piu

Converts osu!standard beatmaps (`.osz`) into pump-single StepMania charts (`.ssc`)
for playing on a Pump It Up machine (XSanity / StepF2).

## Usage

```
python -m osu2piu "path/to/map.osz" -o "D:/piu/XSanity/Songs/ZZ.OSU CONVERTS"
python -m osu2piu "D:/piu/osu songs" -o "..." --seed 42   # whole folder, reproducible
```

Every osu difficulty in the archive becomes one pump-single chart; the level
(`#METER`) is estimated from peak note density.

## How it works

1. `osu_parser` reads timing points and hit objects from each `.osu` in the archive.
2. `timing.BeatGrid` maps millisecond timestamps onto a beat grid (12 rows/beat),
   producing `#BPMS`/`#OFFSET` and quantized note rows.
3. `generator.RuleGenerator` picks panels with weighted-random choice under
   foot-alternation rules (no crossovers, don't step on held panels, fast notes
   stay on the same panel). Sliders long enough become holds.
4. `ssc_writer` renders the song folder with music + background from the `.osz`.

## Planned: pattern library

`training/` is for StepMania song packs to harvest real pump patterns from.
Phrases will be indexed by rhythm signature (beat-gap n-grams) and chart level,
then stitched over the osu rhythm with panel-overlap continuity; the rule
generator stays as the fallback when no harvested phrase matches.
