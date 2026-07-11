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

The home page can also search official osu! beatmap listings. Register an
OAuth application in your osu! account settings, then set `OSU_CLIENT_ID` and
`OSU_CLIENT_SECRET` in `.env`. Search uses osu! API v2; downloads open the
official osu! website and the downloaded `.osz` can be dropped into the studio.
“Convert now” first tries an authenticated official-site download when
`OSU_SESSION_COOKIE` is configured, then falls back to Chimu and Beatconnect;
the UI shows each provider attempt. Keep this cookie private and rotate it if
it is ever exposed.
Place a Mozilla/Netscape-format `cookies.txt` export at the repository root
(or set `OSU_COOKIES_FILE`). Docker mounts it read-only and the backend extracts
only `osu_session` in memory. Cookie exports are gitignored.

Song videos are retained in their original form inside the project. Preview and
song export share a cached H.264/yuv420p MP4 conversion; exported `.ssc` files
reference that compatibility MP4 instead of the source container/codec.

### Production (Linux server)

Fresh clone to running app, no setup:

```
git clone <repo> && cd osu2piu
make prod                          # build + start, http://<host>:8080
```

Everything the container needs is in the repo (`patterns.pkl` /
`corpus_stats.json` are committed), so there's nothing to fetch or
configure. To change ports or wire in a real Songs/noteskin folder, copy
`.env.example` to `.env` first and edit it:

```
cp .env.example .env               # then set WEB_PORT, PUBLISH_DIR, …
make prod                          # http://<host>:$WEB_PORT
```

- **Ports** are `.env`-driven. In prod only `WEB_PORT` is published (the web
  UI); `engine` stays internal to the compose network. `make dev` also
  honours `ENGINE_PORT` / `FRONTEND_PORT`.
- **Images:** `engine` (`engine/Dockerfile`) and `web` (`web/Dockerfile`)
  build from the repo and are tagged `osu2piu-engine` / `osu2piu-web`.
- `make down` / `make logs` / `make ps` manage the running stack.

### Data artifacts

`patterns.pkl` and `corpus_stats.json` are checked into git (~45MB total —
under GitHub's limits, and simpler than shipping them out-of-band), so a
plain `git clone` + `make prod` is the entire deploy with no setup. `training/` itself stays gitignored (it's ~2,800 song folders,
not something to version). To rebuild either artifact after adding more
training charts:

```
python -m osu2piu build-patterns training -o patterns.pkl
python -m osu2piu build-corpus-stats training -o corpus_stats.json
```

(each rebuild adds a new ~45MB blob to git history — fine for occasional
updates, but don't run it in a loop.)

Every path defaults to this directory — no `patterns.pkl`? conversion falls
back to the rule generator; "publish" writes into `./publish`; the pump
noteskin sprites ship in `./noteskin`, so the real in-game arrows render
(point `NOTESKIN_SOURCE_DIR` at a different `NoteSkins/pump/<name>` to swap
skins, or empty the folder to fall back to the canvas-drawn one). Copy
`.env.example` to `.env` to point `PUBLISH_DIR` / `NOTESKIN_SOURCE_DIR` /
etc. at a real XSanity install.

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
