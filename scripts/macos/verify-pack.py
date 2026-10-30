#!/usr/bin/env python3
"""Verify hashes, closure, signatures and a physical Unicode/space relocation.

This is same-host evidence. It is deliberately not a clean-machine acceptance test.
"""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import time
import zlib

from pack_macos import sha256, verify_pack, write_json


def make_png(path: Path) -> None:
    """Deterministic synthetic texture; no third-party test-image license needed."""
    size = 512
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            # Multiple spatial scales, asymmetric cells and local contrast produce SIFT corners.
            c = ((x // 13) * 37 + (y // 17) * 53 + ((x * y) % 11) * 7) % 256
            pixels.extend((c, (c + x // 3) % 256, (c + y // 2) % 256))
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


def relocation_smoke(pack: Path, report_dir: Path) -> dict:
    report_dir.mkdir(parents=True, exist_ok=True)
    # shutil.copytree copies bytes; symlinks/hard links to the original pack are not used.
    moved = Path(tempfile.mkdtemp(prefix="引擎 重定位 ", dir=report_dir)).resolve()
    runtime = moved / "完整 引擎"
    shutil.copytree(pack, runtime, copy_function=shutil.copy2)
    for source_file in pack.rglob("*"):
        if source_file.is_file():
            copied = runtime / source_file.relative_to(pack)
            if source_file.stat().st_dev == copied.stat().st_dev and source_file.stat().st_ino == copied.stat().st_ino:
                raise ValueError("relocation retained a hard link to the original: " + str(source_file))
    report = verify_pack(runtime)
    source = verify_pack(pack)
    if source["manifest_sha256"] != report["manifest_sha256"]:
        raise ValueError("relocation changed manifest")
    home = moved / "空白 HOME"
    home.mkdir()
    env = {"PATH": "", "HOME": str(home), "TMPDIR": str(moved), "LANG": "en_US.UTF-8",
           "LC_ALL": "en_US.UTF-8"}
    commands = []
    def execute(name: str, args: list, timeout: int = 120) -> str:
        started = time.monotonic()
        result = subprocess.run([str(a) for a in args], env=env, cwd=moved,
                                capture_output=True, text=True, timeout=timeout)
        (moved / f"{name}.stdout.log").write_text(result.stdout)
        (moved / f"{name}.stderr.log").write_text(result.stderr)
        commands.append({"name": name, "argv": [str(a) for a in args], "return_code": result.returncode,
                         "elapsed_seconds": round(time.monotonic() - started, 3)})
        if result.returncode:
            raise ValueError(f"relocated {name} failed ({result.returncode}): {result.stderr[-4000:]}")
        return result.stdout
    ffmpeg, ffprobe = runtime / "ffmpeg/bin/ffmpeg", runtime / "ffmpeg/bin/ffprobe"
    colmap, brush = runtime / "colmap/bin/colmap", runtime / "brush/bin/brush"
    execute("ffmpeg-version", [ffmpeg, "-version"])
    execute("ffprobe-version", [ffprobe, "-version"])
    execute("colmap-help", [colmap, "--help"])
    execute("brush-version", [brush, "--version"])
    execute("brush-help", [brush, "--help"])
    for command in ("feature_extractor", "sequential_matcher", "exhaustive_matcher", "mapper", "global_mapper", "image_undistorter"):
        execute("colmap-" + command + "-help", [colmap, command, "--help"])
    images = moved / "测试 图像"
    images.mkdir()
    png = images / "纹理.png"
    make_png(png)
    execute("ffmpeg-cpu-decode", [ffmpeg, "-nostdin", "-hide_banner", "-v", "error", "-i", png,
                                  "-f", "null", "-"])
    probe = json.loads(execute("ffprobe-image", [ffprobe, "-v", "error", "-show_streams", "-of", "json", png]))
    if probe["streams"][0]["width"] != 512 or probe["streams"][0]["height"] != 512:
        raise ValueError("unexpected relocated decoded image dimensions")
    database = moved / "CPU 特征.db"
    execute("colmap-cpu-feature", [colmap, "feature_extractor", "--database_path", database,
                                   "--image_path", images, "--ImageReader.camera_model", "SIMPLE_PINHOLE",
                                   "--ImageReader.single_camera", "1", "--FeatureExtraction.use_gpu", "0",
                                   "--FeatureExtraction.num_threads", "2", "--SiftExtraction.max_num_features", "1024"])
    with sqlite3.connect(database) as db:
        image_count = db.execute("SELECT count(*) FROM images").fetchone()[0]
        feature_count = db.execute("SELECT coalesce(sum(rows),0) FROM keypoints").fetchone()[0]
    if image_count != 1 or feature_count <= 0:
        raise ValueError(f"relocated CPU feature extraction produced no features: {image_count}, {feature_count}")
    output = {"schema_version": 1, "validation_scope": "same-host physical relocation; not clean-machine acceptance",
              "host": {"system": platform.platform(), "machine": platform.machine()},
              "original_pack": str(pack), "relocated_pack": str(runtime), "environment": env,
              "dyld_environment_variables": [], "commands": commands,
              "cpu_feature_images": image_count, "cpu_feature_keypoints": feature_count,
              "synthetic_input_sha256": sha256(png), "verified_pack": report}
    write_json(moved / "relocation-report.json", output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pack", type=Path)
    parser.add_argument("--relocate", action="store_true")
    parser.add_argument("--report-dir", type=Path)
    parser.add_argument("--require-distributable", action="store_true")
    args = parser.parse_args()
    pack = args.pack.resolve()
    report = verify_pack(pack)
    if args.require_distributable:
        status_file = pack.parent / "release-status.json"
        status = json.loads(status_file.read_text())
        if status.get("manifest_sha256") != report["manifest_sha256"] or not status.get("distributable"):
            raise ValueError("engine pack is internal Alpha only; see release-status.json blockers")
        for engine in ("ffmpeg", "colmap", "brush"):
            # A hand-edited status flag cannot override the manifest-hashed
            # evidence or silently clear a component's unresolved notices.
            audit = json.loads((pack / engine / "provenance/audit.json").read_text())
            if not audit.get("release_ready") or audit.get("issues"):
                raise ValueError("manifest-hashed redistribution evidence is incomplete: " + engine)
    if args.relocate:
        destination = (args.report_dir or pack.parent / "verification").resolve()
        if destination.is_relative_to(pack):
            parser.error("report-dir must be outside the verified pack")
        smoke = relocation_smoke(pack, destination)
        write_json(destination / "latest-relocation-report.json", smoke)
        report["relocated_pack"] = smoke["relocated_pack"]
        report["cpu_feature_keypoints"] = smoke["cpu_feature_keypoints"]
    print(json.dumps({k: v for k, v in report.items() if k != "mach_o"}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
