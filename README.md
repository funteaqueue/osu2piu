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

## Web studio

Drag-and-drop `.osz` → preview the chart in sync with the music → edit /
regenerate (whole chart or a selected region) → publish into the XSanity
Songs folder. Design: [WEBAPP.md](WEBAPP.md).

```
docker compose up --build          # http://localhost:8080
docker compose -f compose.dev.yml up   # dev: vite on :5173, hot reload
```

`patterns.pkl` and `corpus_stats.json` are checked into git (~45MB total —
under GitHub's limits, and simpler than shipping them out-of-band), so a
plain `git clone` + `docker compose up --build` is the entire deploy with
no setup. `training/` itself stays gitignored (it's ~2,800 song folders,
not something to version). To rebuild either artifact after adding more
training charts:

```
python -m osu2piu build-patterns training -o patterns.pkl
python -m osu2piu build-corpus-stats training -o corpus_stats.json
```

(each rebuild adds a new ~45MB blob to git history — fine for occasional
updates, but don't run it in a loop.)

Every path defaults to this directory — no `patterns.pkl`? conversion falls
back to the rule generator; "publish" writes into `./publish`; the
noteskin falls back to canvas-drawn. Copy `.env.example` to `.env` to point
`PUBLISH_DIR` / `NOTESKIN_SOURCE_DIR` / etc. at a real XSanity install.

Without Docker (three terminals):

```
PATTERNS_PATH=patterns.pkl python -m uvicorn osu2piu.api:app --port 8001
cd web/server   && npm install && npm run build && node --env-file=.env.local dist/index.js
cd web/frontend && npm install && npm run dev    # http://localhost:5173
```

(`web/server/.env.local` holds the local paths: projects dir, engine URL,
publish dir, built-frontend dir, noteskin dir — gitignored, one per machine.)

## CLI notes

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
