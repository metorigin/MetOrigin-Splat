#!/usr/bin/env python3
"""Independent Pillow pixel audit of production-controlled input preparation."""
import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageOps


def digest(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def compare(reference, actual):
    with Image.open(reference) as source, Image.open(actual) as target:
        source = ImageOps.exif_transpose(source).convert("RGB")
        target = target.convert("RGB")
        if source.size != target.size:
            raise ValueError(f"Dimensions disagree: {source.size} != {target.size}")
        histogram = ImageChops.difference(source, target).histogram()
    bins = [sum(histogram[channel * 256 + value] for channel in range(3)) for value in range(256)]
    count = sum(bins)
    mae = sum(value * n for value, n in enumerate(bins)) / count
    mse = sum(value * value * n for value, n in enumerate(bins)) / count
    cumulative, p99 = 0, 255
    for value, n in enumerate(bins):
        cumulative += n
        if cumulative >= math.ceil(count * 0.99):
            p99 = value
            break
    psnr = 10 * math.log10(255 * 255 / mse) if mse else None
    if mae > 6 or p99 > 28 or (psnr is not None and psnr < 28):
        raise ValueError(f"Predeclared pixel thresholds failed: MAE={mae}, P99={p99}, PSNR={psnr}")
    return dict(mae=mae, p99=p99, psnr_db=psnr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, required=True)
    parser.add_argument("--projects", type=Path)
    parser.add_argument("--rotated-project", type=Path)
    args = parser.parse_args()
    if args.rotated_project:
        receipt = json.loads((args.fixtures / "rotated-video-manifest.json").read_text(encoding="utf-8"))
        frames = json.loads((args.rotated_project / "frames/frames.json").read_text(encoding="utf-8"))
        if frames["source_metadata"]["rotation"] != 90:
            raise ValueError("Production probe did not preserve display-matrix angle")
        actual = args.rotated_project / "frames" / frames["frames"][0]["filename"]
        metrics = compare(args.fixtures / receipt["reference"], actual)
        result = dict(schema_version=1, status="independent_rotation_pixel_audit_passed",
                      scope="first5fps frame, independent Pillow90-degree counterclockwise transform", **metrics)
        (args.rotated_project / "runtime/rotation-pixel-audit.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result))
        return
    if not args.projects:
        parser.error("Set --projects or --rotated-project")
    preparation = args.projects / "input-preparation-evidence.json"
    manifest = json.loads((args.fixtures / "fixture-manifest.json").read_text(encoding="utf-8"))
    result = json.loads(preparation.read_text(encoding="utf-8"))
    references = {
        "positive-mixed": {item["path"]: item for item in manifest["images"]},
        "orientation-eight": {item["path"]: item for item in manifest["orientation_oracle"]},
    }
    audits = []
    for case in result["results"]:
        if case["case"] not in references:
            continue
        project = Path(case["project"])
        frames = json.loads((project / "frames/frames.json").read_text(encoding="utf-8"))
        for item in frames["frame_sources"]:
            expected = references[case["case"]][item["source_relative_path"]]
            original = args.fixtures / case["case"] / expected["path"]
            if digest(original) != expected["sha256"]:
                raise ValueError("Derived source identity changed")
            audits.append(dict(case=case["case"], source=expected["path"],
                               **compare(args.fixtures / expected["reference"], project / "frames" / item["filename"])))
    if len(audits) != 48:
        raise ValueError(f"Expected all40 mixed views and8 orientation cases, observed {len(audits)}")
    evidence = dict(schema_version=1, status="independent_pixel_audit_passed", images=48,
                    thresholds=manifest["pixel_thresholds"], max_mae=max(item["mae"] for item in audits),
                    max_p99=max(item["p99"] for item in audits),
                    min_psnr_db=min(item["psnr_db"] for item in audits if item["psnr_db"] is not None), audits=audits)
    (args.projects / "pixel-audit.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in evidence.items() if key != "audits"}))


if __name__ == "__main__":
    main()
