"""Orchestrate: .osz in -> StepMania song folder out.

Generation itself lives in chartjson (shared with the engine API); this
module is the CLI-facing wrapper that extracts media and writes the .ssc.
"""
from __future__ import annotations

import random
import re
from pathlib import Path

from .chartjson import build_project, render_project_ssc
from .osu_parser import load_osz
from .patterns import Library


def convert_osz(osz_path: str, out_root: str, seed: int | None = None,
                lib: Library | None = None, beginner: bool = True) -> Path:
    rng = random.Random(seed)
    beatmaps, zf = load_osz(osz_path)
    if not beatmaps:
        raise ValueError(f"no osu!standard difficulties found in {osz_path}")

    ref = beatmaps[0]
    song_dir = Path(out_root) / _safe_name(f"{ref.artist} - {ref.title}")
    song_dir.mkdir(parents=True, exist_ok=True)

    names = {n.lower(): n for n in zf.namelist()}
    music = _extract(zf, names, ref.audio_filename, song_dir)
    background = _extract(zf, names, ref.background, song_dir)

    project = build_project(beatmaps, rng, lib, beginner=beginner)
    project["song"]["audioFile"] = music
    project["song"]["background"] = background

    for chart in project["charts"]:
        t = chart["stats"]["tiers"]
        total = max(1, t["exact"] + t["downgrade"] + t["fallback"])
        meters = [n["origin"]["sourceMeter"] for n in chart["notes"]
                  if n["origin"]["sourceMeter"]]
        src = (f"  src-meter {sum(meters) / len(meters):.1f}" if meters else "")
        print(f"  [{chart['name']:>20s}] lvl {chart['level']:>2d}  "
              f"exact {t['exact'] / total:4.0%}  downgrade {t['downgrade'] / total:4.0%}  "
              f"fallback {t['fallback'] / total:4.0%}  jumps {t['jump']}  "
              f"dropped {t['dropped']}" + src)

    ssc_path = song_dir / (song_dir.name + ".ssc")
    ssc_path.write_text(render_project_ssc(project), encoding="utf-8")
    return ssc_path


def _extract(zf, names: dict[str, str], filename: str, song_dir: Path) -> str:
    if not filename or filename.lower() not in names:
        return ""
    real = names[filename.lower()]
    out_name = _safe_name(Path(real).name)
    (song_dir / out_name).write_bytes(zf.read(real))
    return out_name


def _safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', "", name).strip().rstrip(".")
