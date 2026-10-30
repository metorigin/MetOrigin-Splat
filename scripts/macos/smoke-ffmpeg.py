#!/usr/bin/env python3
"""Relocate the native FFmpeg runtime and verify video, JPEG/PNG and rotation I/O.

This is a media smoke check on the current host, not a clean-machine acceptance.
The video is local and unchanged; the output directory must be new.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from verify_ffmpeg_build import validate_version


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def smoke(install, video, output):
    install, video, output = install.resolve(), video.resolve(), output.resolve()
    if not video.is_file() or not (install / "bin/ffmpeg").is_file():
        raise ValueError("installed runtime and local input video are required")
    for source in (install, video):
        if source == output or source in output.parents or output in source.parents:
            raise ValueError("output must not overlap inputs")
    output.mkdir(parents=True, exist_ok=False)
    runtime = output / "relocated 中文 空格"
    for directory in ("bin", "lib"):
        shutil.copytree(install / directory, runtime / directory, symlinks=True)
    ffmpeg, ffprobe = runtime / "bin/ffmpeg", runtime / "bin/ffprobe"
    # No inherited DYLD/PATH/Conda/Homebrew overrides may help this relocated run.
    environment = {"PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"}
    if os.environ.get("TMPDIR"):
        environment["TMPDIR"] = os.environ["TMPDIR"]
    commands = []

    def run(program, arguments):
        command = [str(program), *map(str, arguments)]
        commands.append(command)
        result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=120)
        index = len(commands)
        (output / f"command-{index:02d}.stderr.log").write_text(result.stderr)
        if result.returncode:
            raise RuntimeError(f"media command {index} failed with exit {result.returncode}")
        return result.stdout

    def inspect(path):
        metadata = json.loads(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]))
        return next(stream for stream in metadata["streams"] if stream["codec_type"] == "video")

    before = digest(video)
    for name, binary in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)):
        validate_version(run(binary, ["-version"]), name)
    source = inspect(video)
    jpeg, png = output / "frame.jpg", output / "frame.png"
    common = ["-nostdin", "-hide_banner", "-n", "-i", video, "-frames:v", "1"]
    run(ffmpeg, [*common, "-update", "1", jpeg])
    run(ffmpeg, [*common, "-update", "1", png])
    jpeg_info, png_info = inspect(jpeg), inspect(png)
    dimensions = [source["width"], source["height"]]
    for frame in (jpeg_info, png_info):
        if [frame["width"], frame["height"]] != dimensions:
            raise ValueError("decoded image dimensions changed")
    # Exercise PNG decoding as well as its system-zlib-dependent encoding path.
    run(ffmpeg, ["-nostdin", "-hide_banner", "-v", "error", "-i", png, "-f", "null", "-"])
    rotated = output / "rotated.mp4"
    run(ffmpeg, ["-nostdin", "-hide_banner", "-n", "-display_rotation", "90", "-i", video,
                 "-map", "0:v:0", "-c", "copy", rotated])
    rotated_info = inspect(rotated)
    if not any(abs(side.get("rotation", 0)) == 90 for side in rotated_info.get("side_data_list", [])):
        raise ValueError("rotation metadata was not retained")
    rotated_jpeg = output / "rotated.jpg"
    run(ffmpeg, ["-nostdin", "-hide_banner", "-n", "-i", rotated, "-frames:v", "1", "-update", "1", rotated_jpeg])
    rotated_frame = inspect(rotated_jpeg)
    if [rotated_frame["width"], rotated_frame["height"]] != dimensions[::-1]:
        raise ValueError("automatic rotation did not swap the decoded dimensions")
    if digest(video) != before:
        raise ValueError("input video changed")
    evidence = {
        "schema_version": 1, "status": "media_smoke_passed", "version": "8.1.2",
        "relocated_runtime": True, "environment_overrides_removed": True,
        "clean_machine_verified": False, "input_sha256": before,
        "input_codec": source["codec_name"], "input_dimensions": dimensions,
        "jpeg_and_png_encode_decode": True, "rotation_metadata_and_autorotate": True,
        "source_unchanged": True,
        "ffmpeg_sha256": digest(ffmpeg), "ffprobe_sha256": digest(ffprobe),
        "commands": commands,
    }
    temporary = output / "evidence.json.tmp"
    temporary.write_text(json.dumps(evidence, indent=2) + "\n")
    temporary.replace(output / "evidence.json")
    print("FFmpeg relocated media smoke passed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", required=True, type=Path)
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    smoke(args.install_dir, args.video, args.output)
