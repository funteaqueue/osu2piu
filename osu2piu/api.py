"""Engine HTTP API: the web studio's generation backend.

    uvicorn osu2piu.api:app --port 8000

The pattern library is loaded once at startup (PATTERNS_PATH, default
/data/patterns.pkl); requests are CPU-bound and run in the default thread
pool, one warm process.
"""
from __future__ import annotations

import io
import os
import random
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .chartjson import build_project, regenerate_chart, render_project_ssc
from .metrics import load_corpus_index
from .osu_parser import load_osz
from .patterns import Library

app = FastAPI(title="osu2piu engine")
_lib: Library | None = None
_corpus: dict | None = None


@app.on_event("startup")
def _load_library() -> None:
    global _lib, _corpus
    # is_file() (not exists()) — an unset bind mount source makes Docker
    # auto-create an empty directory at this path, which must not look "present"
    path = os.environ.get("PATTERNS_PATH", "/data/patterns.pkl")
    if Path(path).is_file():
        print(f"loading pattern library {path} ...")
        _lib = Library.load(path)
        print(f"library ready: {len(_lib.phrases)} phrases")
    else:
        print(f"no pattern library at {path} — rule generator only")
    corpus_path = os.environ.get("CORPUS_STATS", "/data/corpus_stats.json")
    _corpus = load_corpus_index(corpus_path) if Path(corpus_path).is_file() else None
    if _corpus:
        print(f"corpus index: {len(_corpus['charts'])} charts")
    else:
        print(f"no corpus index at {corpus_path} — reference metrics disabled")


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "patterns": _lib is not None,
            "corpus": _corpus is not None}


@app.get("/reference/level/{level}")
def reference_level(level: int) -> dict:
    if not _corpus:
        raise HTTPException(404, "no corpus index loaded")
    entry = _corpus["levels"].get(str(level))
    if not entry:
        raise HTTPException(404, f"no corpus data for level {level}")
    return {"level": level, "count": entry["count"],
            "metrics": {k: v for k, v in entry.items() if k != "count"}}


@app.get("/reference/search")
def reference_search(q: str = "", level: int | None = None) -> list[dict]:
    if not _corpus:
        raise HTTPException(404, "no corpus index loaded")
    needle = q.strip().lower()
    out = []
    for i, c in enumerate(_corpus["charts"]):
        if level is not None and c["meter"] != level:
            continue
        if needle and needle not in c["title"].lower():
            continue
        out.append({"id": i, "title": c["title"], "meter": c["meter"]})
        if len(out) >= 30:
            break
    return out


@app.get("/reference/chart/{chart_id}")
def reference_chart(chart_id: int) -> dict:
    if not _corpus:
        raise HTTPException(404, "no corpus index loaded")
    if not 0 <= chart_id < len(_corpus["charts"]):
        raise HTTPException(404, "no such chart")
    c = _corpus["charts"][chart_id]
    return {"id": chart_id, "title": c["title"], "meter": c["meter"],
            "metrics": c["metrics"]}


@app.post("/convert")
async def convert(osz: UploadFile = File(...),
                  seed: int | None = Form(None)) -> dict:
    data = await osz.read()
    try:
        beatmaps, _zf = load_osz(io.BytesIO(data))
    except Exception as exc:
        raise HTTPException(400, f"not a readable .osz: {exc}")
    if not beatmaps:
        raise HTTPException(400, "no osu!standard difficulties in archive")
    rng = random.Random(seed)
    return build_project(beatmaps, rng, _lib)


class RegenerateRequest(BaseModel):
    song: dict
    chart: dict
    startRow: int | None = None
    endRow: int | None = None
    seed: int | None = None
    options: dict = {}


@app.post("/regenerate")
def regenerate(req: RegenerateRequest) -> dict:
    if "source" not in req.chart:
        raise HTTPException(400, "chart carries no source objects")
    return regenerate_chart(req.song, req.chart, start_row=req.startRow,
                            end_row=req.endRow, seed=req.seed,
                            options=req.options, lib=_lib)


class ExportRequest(BaseModel):
    song: dict
    charts: list[dict]


@app.post("/export", response_class=PlainTextResponse)
def export(req: ExportRequest) -> str:
    return render_project_ssc({"song": req.song, "charts": req.charts})
