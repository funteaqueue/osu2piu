# osu2piu web studio — implementation plan

A local web service: drag-and-drop an `.osz`, preview the generated pump chart
in sync with the music, edit it, regenerate it (fully or a selected region),
and publish straight into the XSanity Songs folder. Dockerized.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ browser  — React + TypeScript + Vite                     │
│   upload page · project view · chart editor/player       │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP (JSON) + static
┌──────────────────────────┴──────────────────────────────┐
│ web  — Node 22 (Fastify)                                 │
│   projects CRUD, file storage, audio streaming,          │
│   .ssc export, publish-to-Songs, proxy to engine         │
└──────────────────────────┬──────────────────────────────┘
                           │ internal HTTP
┌──────────────────────────┴──────────────────────────────┐
│ engine — Python 3.12 (FastAPI + uvicorn)                 │
│   existing osu2piu package; patterns.pkl loaded once     │
│   POST /convert · POST /regenerate · GET /health         │
└──────────────────────────────────────────────────────────┘
```

- The Python converter remains the single source of truth for generation;
  Node never re-implements chart logic.
- docker-compose services: `web`, `engine`. Volumes: `projects/` (uploads +
  saved work), `patterns.pkl` (read-only), and the host's
  `XSanity/Songs/ZZ.OSU CONVERTS` for one-click publish.

## Chart JSON (the contract between everything)

```jsonc
{
  "song":  { "title", "artist", "creator", "audioFile", "bpms": [[beat, bpm]],
             "offsetSeconds", "sampleStartSeconds", "background" },
  "charts": [{
    "id", "name",              // osu difficulty name
    "level": 8,                // editable #METER
    "notes": [{
      "row": 1234,             // 12 rows/beat grid (existing quantizer)
      "panels": [0, 4],        // 1 = tap, 2 = jump
      "holdEndRow": 1282,      // null for taps
      "origin": {              // provenance, set by the engine
        "tier": "exact|downgrade|fallback|jump|manual",
        "sourceMeter": 9
      }
    }],
    "stats": { "coverage", "jumps", "holds", "rulers": {peak, avg, speed} }
  }]
}
```

Engine-side work: refactor `convert.py` so `_build_chart` returns this
structure (notes with provenance) and `.ssc` rendering becomes a pure
function of it — CLI and web share one path.

## Engine API

- `POST /convert` — multipart `.osz` (+ options: seed, level overrides)
  → chart JSON for every difficulty. Library stays loaded between calls.
- `POST /regenerate` — chart JSON + `{chartId, startRow?, endRow?, seed,
  options}` → same chart with notes inside the region regenerated.
  - Region mode: notes outside the region are pinned; the matcher restarts
    inside using the last two pinned panels before the region as overlap
    context (mechanism already exists), and active holds crossing the
    boundary are respected. `origin.tier` of `manual` notes inside the
    region is preserved unless `overwriteManual: true`.
  - Options exposed: seed, target level override, hold budget ×, jump
    budget ×, max match length — the tuning knobs we already have.
- `POST /export` — chart JSON → `.ssc` text (used by Node for downloads
  and publish).

## Web server (Node)

- Fastify + TypeScript. No auth (home LAN tool).
- `POST /api/projects` — upload `.osz`, store it, call engine `/convert`,
  persist project JSON. `GET /api/projects[/:id]`, `DELETE`.
- `PUT /api/projects/:id/charts/:chartId` — save edits (whole-chart JSON;
  charts are small, no need for op-level patching).
- `POST .../regenerate` — proxy to engine, persist result as a new
  **revision**; keep last ~20 revisions per chart for undo-across-reload.
- `GET /api/projects/:id/audio` — range-request streaming of the mp3/ogg
  from inside the stored `.osz`.
- `POST /api/projects/:id/export` — zip of song folder (ssc + audio + bg).
- `POST /api/projects/:id/publish` — write song folder into the mounted
  Songs volume (and touch nothing else; XSanity picks it up on rescan).

## Frontend

React + TypeScript + Vite, Zustand for state, plain `<canvas>` 2D for the
notefield (5 lanes; PIU-style arrows: DL/UL red, C yellow, UR/DR blue —
drawn, no copyrighted assets).

### Player / preview
- `<audio>` element is the clock; render loop (requestAnimationFrame) maps
  `audio.currentTime` → beat via the bpms/offset (JS mirror of
  `timing.BeatGrid`, ~40 lines, unit-tested against Python goldens).
- Downward-scrolling notefield with receptors, beat/measure lines, hold
  bodies; approach speed (px per beat) adjustable.
- Transport: play/pause (space), progress slider (seek anywhere), ±5s
  fast-forward/back, playback rate 0.5×–1.5× (preserving pitch via
  `audio.preservesPitch`), jump-to-first-note, loop-a-section (A/B markers).
- Provenance overlay toggle: tint notes by origin tier — instantly see
  which parts are synthetic fallback vs real patterns.

### Editor
- Edit mode pauses playback and shows a vertically scrollable grid
  (snap selector: 4th/8th/12th/16th rows).
- Click a cell: toggle tap. Drag vertically: create/resize hold. Click two
  panels on one row: jump. Right-click: delete. Edited notes get
  `origin.tier = "manual"`.
- Selection: drag across the timeline (or shift+click two points) →
  highlighted region → actions: **Regenerate region** (with seed reroll
  button), delete notes, nudge ±1 row.
- Chart-level controls: level (#METER) field, chart name, per-chart
  regenerate-all with option knobs, revision history dropdown (restore).
- Undo/redo (in-memory op stack) + autosave (debounced PUT).
- Validation pass on every edit (same rules as our validator: hold
  integrity, ≤2 simultaneous panels, no notes inside holds on same panel)
  with inline error markers.

### Project view
- All difficulties with stats table (level, coverage %, jumps, holds,
  ruler values); convert-time options; download / publish buttons.

## Docker

- `engine/Dockerfile`: python slim, installs package, `uvicorn api:app`.
  `patterns.pkl` mounted read-only (rebuilt on the host where `training/`
  lives — the corpus is not baked into images).
- `web/Dockerfile`: multi-stage — build frontend (vite build), then node
  runtime serving static + API.
- `docker-compose.yml`:
  - `engine`: volume `./patterns.pkl:/data/patterns.pkl:ro`
  - `web`: volumes `./projects:/data/projects`,
    `D:/piu/XSanity/Songs/ZZ.OSU CONVERTS:/publish`
  - only `web` exposes a port (8080).
- Dev mode: `docker compose -f compose.dev.yml` runs vite dev + uvicorn
  --reload with bind mounts.

## Milestones

1. **M1 — pipeline to browser.** Engine JSON refactor + FastAPI wrapper;
   Node upload/convert/persist; frontend shows a static (non-audio)
   rendering of the chart. *Proves the JSON contract end to end.*
2. **M2 — synced player.** Audio streaming, canvas notefield synced to
   playback, all transport controls (slider, FF/RW, speed, A/B loop).
3. **M3 — editing.** Note editing, validation, undo/redo, autosave,
   .ssc export + publish-to-Songs volume.
4. **M4 — regeneration.** Full-chart and region regenerate with option
   knobs, seed rerolls, provenance overlay, revision history.
5. **M5 — polish.** Waveform strip under the slider, keyboard-first
   workflow, batch upload (whole `osu songs/` folder), per-project notes.

Each milestone is play-testable on its own; M2 alone already replaces the
current "convert, restart XSanity, walk to the pad" preview loop.

## Risks / notes

- **Timing sync**: `audio.currentTime` jitters ~10ms across browsers; the
  render loop must interpolate with `performance.now()` between audio
  clock reads. This is the one piece worth prototyping first in M2.
- **Engine memory**: patterns.pkl expands to a few hundred MB in RAM;
  fine for one warm process, don't fork per request.
- **Audio formats**: osz carries mp3/ogg — both play natively in browsers.
- **Windows volume mounts** (D:/piu path in compose) need Docker Desktop
  file sharing enabled for the drive.
- Not in scope for now: auth/multi-user, osu!mania input, doubles charts
  (the editor's data model keeps `panels` an array so 10-lane doubles can
  arrive later without schema changes).
