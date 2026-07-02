"""Parsing of .osu beatmap files and .osz archives."""
from __future__ import annotations

import zipfile
from dataclasses import dataclass, field


@dataclass
class TimingPoint:
    time: float          # ms
    beat_length: float   # ms per beat (uninherited) or negative SV percent (inherited)
    uninherited: bool


@dataclass
class HitObject:
    x: int
    y: int
    time: float          # ms
    kind: str            # 'circle' | 'slider' | 'spinner'
    end_time: float      # ms (== time for circles)
    repeats: int = 1


@dataclass
class Beatmap:
    mode: int = 0
    title: str = ""
    artist: str = ""
    creator: str = ""
    version: str = ""            # osu difficulty name
    audio_filename: str = ""
    preview_time: float = -1.0   # ms
    background: str = ""
    slider_multiplier: float = 1.4
    timing_points: list[TimingPoint] = field(default_factory=list)
    hit_objects: list[HitObject] = field(default_factory=list)

    @property
    def red_points(self) -> list[TimingPoint]:
        return [tp for tp in self.timing_points if tp.uninherited]


def parse_osu(text: str) -> Beatmap:
    bm = Beatmap()
    section = None
    hit_lines: list[str] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue

        if section in ("General", "Metadata", "Difficulty"):
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key, value = key.strip(), value.strip()
            if key == "Mode":
                bm.mode = int(value)
            elif key == "AudioFilename":
                bm.audio_filename = value
            elif key == "PreviewTime":
                bm.preview_time = float(value)
            elif key == "Title":
                bm.title = value
            elif key == "Artist":
                bm.artist = value
            elif key == "Creator":
                bm.creator = value
            elif key == "Version":
                bm.version = value
            elif key == "SliderMultiplier":
                bm.slider_multiplier = float(value)
        elif section == "Events":
            parts = line.split(",")
            if len(parts) >= 3 and parts[0] in ("0", "Background") and not bm.background:
                bm.background = parts[2].strip().strip('"')
        elif section == "TimingPoints":
            parts = line.split(",")
            if len(parts) < 2:
                continue
            time = float(parts[0])
            beat_length = float(parts[1])
            if len(parts) >= 7:
                uninherited = parts[6] == "1"
            else:  # old format versions: only red lines exist
                uninherited = beat_length > 0
            bm.timing_points.append(TimingPoint(time, beat_length, uninherited))
        elif section == "HitObjects":
            hit_lines.append(line)

    bm.timing_points.sort(key=lambda tp: tp.time)
    for line in hit_lines:
        ho = _parse_hit_object(line, bm)
        if ho is not None:
            bm.hit_objects.append(ho)
    bm.hit_objects.sort(key=lambda h: h.time)
    return bm


def _parse_hit_object(line: str, bm: Beatmap) -> HitObject | None:
    parts = line.split(",")
    if len(parts) < 4:
        return None
    x, y, time, obj_type = int(parts[0]), int(parts[1]), float(parts[2]), int(parts[3])

    if obj_type & 1:  # circle
        return HitObject(x, y, time, "circle", time)
    if obj_type & 2:  # slider
        repeats = int(parts[6]) if len(parts) > 6 else 1
        length = float(parts[7]) if len(parts) > 7 else 0.0
        duration = _slider_duration(time, length, bm) * repeats
        return HitObject(x, y, time, "slider", time + duration, repeats)
    if obj_type & 8:  # spinner
        end_time = float(parts[5]) if len(parts) > 5 else time
        return HitObject(x, y, time, "spinner", end_time)
    return None


def _slider_duration(time: float, pixel_length: float, bm: Beatmap) -> float:
    """Duration in ms of one slider pass, per the osu file format spec."""
    beat_length = 500.0
    sv = 1.0
    for tp in bm.timing_points:
        if tp.time > time + 1e-6:
            break
        if tp.uninherited:
            beat_length = tp.beat_length
            sv = 1.0  # green-line effects reset on each red line
        elif tp.beat_length < 0:
            sv = -100.0 / tp.beat_length
    px_per_beat = bm.slider_multiplier * 100.0 * sv
    if px_per_beat <= 0:
        return 0.0
    return pixel_length / px_per_beat * beat_length


def load_osz(path: str) -> tuple[list[Beatmap], zipfile.ZipFile]:
    """Return all osu!standard beatmaps in the archive plus the open zip
    (for pulling out audio/background afterwards)."""
    zf = zipfile.ZipFile(path)
    maps = []
    for name in zf.namelist():
        if not name.lower().endswith(".osu"):
            continue
        text = zf.read(name).decode("utf-8", errors="replace")
        bm = parse_osu(text)
        if bm.mode == 0 and bm.hit_objects and bm.red_points:
            maps.append(bm)
    return maps, zf
