"""CLI:
  python -m osu2piu convert <beatmap.osz|folder> [-o pack] [--patterns lib.pkl]
  python -m osu2piu build-patterns <training dir> [-o patterns.pkl]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="osu2piu",
        description="Convert osu!standard beatmaps into pump-single StepMania charts.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    conv = sub.add_parser("convert", help="convert .osz files to song folders")
    conv.add_argument("inputs", nargs="+", help=".osz files or folders containing them")
    conv.add_argument("-o", "--out", default="out", help="output pack directory")
    conv.add_argument("--patterns", default=None,
                      help="pattern library (patterns.pkl); omit for pure rule generator")
    conv.add_argument("--seed", type=int, default=None,
                      help="fix RNG for reproducible charts")

    build = sub.add_parser("build-patterns", help="harvest a pattern library")
    build.add_argument("training", help="directory with StepMania packs")
    build.add_argument("-o", "--out", default="patterns.pkl", help="library output path")

    args = parser.parse_args()
    if args.cmd == "build-patterns":
        from .patterns import build_library
        build_library(args.training, args.out)
        return 0
    return _convert(args)


def _convert(args) -> int:
    from .convert import convert_osz
    from .patterns import Library

    lib = None
    if args.patterns:
        print(f"loading pattern library {args.patterns} ...")
        lib = Library.load(args.patterns)

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
            ssc = convert_osz(str(osz), args.out, seed=args.seed, lib=lib)
            print(f"ok   {osz.name} -> {ssc}")
        except Exception as exc:  # keep converting the rest of the batch
            failures += 1
            print(f"FAIL {osz.name}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
