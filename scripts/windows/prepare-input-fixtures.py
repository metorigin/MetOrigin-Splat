#!/usr/bin/env python3
"""Create fresh, controlled CC0 derivatives for native input acceptance.

Uses test-only Pillow 11.3.0; never modifies originals or an existing fixture.
The synthetic camera tags are grouping inputs, not physical calibration claims.
"""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageOps, ImageStat, TiffImagePlugin, __version__


def sha256(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def normalized_reference(path, destination, long_edge=960):
    with Image.open(path) as encoded:
        image = ImageOps.exif_transpose(encoded).convert("RGB")
        if max(image.size) > long_edge:
            factor = long_edge / max(image.size)
            image = image.resize(
                (round(image.width * factor), round(image.height * factor)),
                Image.Resampling.LANCZOS,
            )
        image.save(destination, format="PNG")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if __version__ != "11.3.0":
        raise ValueError("Use the recorded test-only Pillow 11.3.0 wheel")
    repository = Path(__file__).resolve().parents[2]
    corpus_path = repository / "packaging/macos-arm64/fixtures/james-sample-40.json"
    corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    source_before = {item["path"]: sha256(args.images / item["path"]) for item in corpus["images"]}
    for item in corpus["images"]:
        if source_before[item["path"]] != item["sha256"]:
            raise ValueError(f"Original identity differs: {item['path']}")
    args.output.mkdir(parents=True, exist_ok=False)
    folders = ["positive-mixed", "orientation-eight", "low-texture", "low-overlap",
               "corrupt-only", "corrupt-plus-two", "empty", "unsupported-only", "references"]
    for name in folders:
        (args.output / name).mkdir()
    inverse = {1: None, 2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
               4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
               6: Image.Transpose.ROTATE_90, 7: Image.Transpose.TRANSVERSE,
               8: Image.Transpose.ROTATE_270}
    records = []
    for index, item in enumerate(corpus["images"]):
        group = index // 10
        dimensions = [(1536, 1024), (1200, 800), (1152, 768), (1536, 1024)][group]
        orientation = index % 8 + 1 if group < 2 else 1
        with Image.open(args.images / item["path"]) as original:
            display = ImageOps.exif_transpose(original).convert("RGB").resize(dimensions, Image.Resampling.LANCZOS)
        pixels = display.transpose(inverse[orientation]) if inverse[orientation] else display
        exif = Image.Exif()
        if group < 2:
            exif[274] = orientation
            exif[271] = "MetOrigin TEST DERIVATIVE"
            exif[272] = f"Synthetic identity {'A' if group == 0 else 'B'}"
            exif[34665] = {42036: f"Synthetic lens {'A' if group == 0 else 'B'}",
                           37386: TiffImagePlugin.IFDRational(50 if group == 0 else 35, 1)}
            if group == 1:
                exif[34665][41989] = 80
        destination = args.output / "positive-mixed" / item["path"]
        pixels.save(destination, quality=95, subsampling=0, exif=exif)
        reference = args.output / "references" / f"mixed-{index:02}.png"
        normalized_reference(destination, reference)
        records.append({"path": item["path"], "sha256": sha256(destination),
                        "original_sha256": item["sha256"], "group": group,
                        "orientation": orientation, "display_size": dimensions,
                        "reference": str(reference.relative_to(args.output)).replace("\\", "/")})
    first = corpus["images"][0]["path"]
    with Image.open(args.images / first) as original:
        display = ImageOps.exif_transpose(original).convert("RGB").resize((1536, 1024), Image.Resampling.LANCZOS)
    orientations = []
    for orientation in range(1, 9):
        pixels = display.transpose(inverse[orientation]) if inverse[orientation] else display
        exif = Image.Exif()
        exif[274] = orientation
        path = args.output / "orientation-eight" / f"orientation-{orientation}.jpg"
        pixels.save(path, quality=95, subsampling=0, exif=exif)
        reference = args.output / "references" / f"orientation-{orientation}.png"
        normalized_reference(path, reference)
        orientations.append({"path": path.name, "sha256": sha256(path), "orientation": orientation,
                             "reference": str(reference.relative_to(args.output)).replace("\\", "/")})
    color = tuple(round(value) for value in ImageStat.Stat(display).mean)
    for index in range(24):
        Image.new("RGB", (640, 480), color).save(args.output / "low-texture" / f"constant-{index:02}.jpg", quality=95)
        column, row = index % 6, index // 6
        display.crop((column * 256, row * 256, (column + 1) * 256, (row + 1) * 256)).save(
            args.output / "low-overlap" / f"disjoint-{index:02}.jpg", quality=95, subsampling=0)
    for name in ["corrupt-only", "corrupt-plus-two"]:
        (args.output / name / "bad-header.jpg").write_bytes(b"not a JPEG\n")
        encoded = (args.output / "positive-mixed" / first).read_bytes()
        (args.output / name / "truncated-entropy.jpg").write_bytes(encoded[:len(encoded) // 3])
    for item in corpus["images"][:2]:
        (args.output / "corrupt-plus-two" / item["path"]).write_bytes((args.output / "positive-mixed" / item["path"]).read_bytes())
    (args.output / "unsupported-only/readme.txt").write_text("Controlled unsupported input; no media.\n", encoding="utf-8")
    source_after = {name: sha256(args.images / name) for name in source_before}
    if source_before != source_after:
        raise ValueError("Source media changed")
    manifest = {"schema_version": 1, "fixture_id": "windows-james40-controlled-inputs-v1",
                "license": "CC0-1.0 derivatives of James/Robson DOI10.6084/m9.figshare.9120020.v1",
                "tool": {"pillow": __version__}, "source_manifest_sha256": sha256(corpus_path),
                "source_hashes_unchanged": True, "images": records, "orientation_oracle": orientations,
                "pixel_thresholds": {"mae_max": 6, "p99_max": 28, "psnr_min_db": 28},
                "synthetic_camera_tags_are_not_physical_calibration": True,
                "low_overlap_grid": {"columns": 6, "rows": 4, "tile_size": 256,
                                     "pairwise_source_pixel_intersection": 0}}
    (args.output / "fixture-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "created", "positive_views": len(records), "orientation_cases": len(orientations),
                      "manifest_sha256": sha256(args.output / "fixture-manifest.json")}))


if __name__ == "__main__":
    main()
