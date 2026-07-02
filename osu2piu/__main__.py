"""CLI: python -m osu2piu <beatmap.osz> [more.osz ...] -o <Songs pack dir>"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .convert import convert_osz


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="osu2piu",
        description="Convert osu!standard beatmaps into pump-single StepMania charts.",
    )
    parser.add_argument("inputs", nargs="+", help=".osz files or folders containing them")
    parser.add_argument("-o", "--out", default="out", help="output pack directory")
    parser.add_argument("--seed", type=int, default=None, help="fix RNG for reproducible charts")
    args = parser.parse_args()

    osz_files: list[Path] = []
    for item in args.inputs:
        p = Path(item)
        if p.is_dir():
            osz_files.extend(sorted(p.glob("*.osz")))
        else:
            osz_files.append(p)

    failures = 0
    for osz in osz_files:
        try:
            ssc = convert_osz(str(osz), args.out, seed=args.seed)
            print(f"ok   {osz.name} -> {ssc}")
        except Exception as exc:  # keep converting the rest of the batch
            failures += 1
            print(f"FAIL {osz.name}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
