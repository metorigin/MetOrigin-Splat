#!/usr/bin/env python3
"""Derive a display-matrix test from the fixed captured TUM video, without reencoding."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from PIL import Image


def sha256(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def run(args, log):
    result = subprocess.run([str(item) for item in args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    log.write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError(f"Fixture tool failed with exit{result.returncode}; see {log.name}")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    args = parser.parse_args()
    expected = "3faa0fa667fa95d28ecf0d231c3383ddef8695f391f07d48f484af39de43a854"
    if sha256(args.source) != expected:
        raise ValueError("Fixed TUM source identity differs")
    output = args.fixtures / "rotated-video"
    output.mkdir(exist_ok=False)
    target = output / "tum-desk-display90.mp4"
    command = [args.ffmpeg, "-hide_banner", "-loglevel", "warning", "-display_rotation:v:0", "90",
               "-i", args.source, "-map", "0:v:0", "-c:v", "copy", "-map_metadata", "-1",
               "-movflags", "+faststart", target]
    run(command, args.fixtures / "rotated-video-derivation.log")
    probe = json.loads(run([args.ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", target],
                          args.fixtures / "rotated-video-probe.json"))
    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
    if not any(data.get("rotation") == 90 for data in video.get("side_data_list", [])):
        raise ValueError("Derived container does not carry the required90-degree display matrix")
    raw = args.fixtures / "references/rotated-raw-first.png"
    run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-noautorotate", "-i", target,
         "-vf", "fps=5", "-frames:v", "1", raw], args.fixtures / "rotated-video-reference.log")
    reference = args.fixtures / "references/rotated-display-first.png"
    with Image.open(raw) as image:
        image.transpose(Image.Transpose.ROTATE_90).save(reference)
    if sha256(args.source) != expected:
        raise ValueError("Original source changed")
    receipt = {"schema_version": 1, "fixture_id": "tum-desk-controlled-display90-v1",
               "license": "CC-BY-4.0 TUM RGB-D Freiburg1 desk derivative",
               "original_sha256": expected, "original_unchanged": True,
               "derived_sha256": sha256(target), "rotation": 90,
               "encoded_dimensions": [video["width"], video["height"]],
               "duration_seconds": float(probe["format"]["duration"]),
               "method": "stream copy; display matrix only, not a separately captured phone video",
               "reference": str(reference.relative_to(args.fixtures)).replace("\\", "/"),
               "tool_versions": {"ffmpeg": run([args.ffmpeg, "-version"], args.fixtures / "rotated-ffmpeg-version.txt").decode("utf-8").splitlines()[0]},
               "args": [str(item) for item in command[1:-1]]}
    (args.fixtures / "rotated-video-manifest.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: receipt[key] for key in ["fixture_id", "derived_sha256", "rotation", "duration_seconds"]}))


if __name__ == "__main__":
    main()
