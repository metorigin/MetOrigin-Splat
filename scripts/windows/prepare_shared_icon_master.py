"""Derive a Windows square crop without changing retained master RGBA pixels."""

import argparse
from hashlib import sha256
from io import BytesIO
import json
from math import ceil, floor
from pathlib import Path
import sys

# Verification must not create import caches alongside its input or helper files.
sys.dont_write_bytecode = True
from PIL import Image, __version__ as pillow_version  # noqa: E402


ALPHA_THRESHOLD = 128
PADDING_FRACTION = 0.02
CANONICAL_SOURCE = Path(__file__).resolve().parents[2] / "design/app-icon/metorigin-splat-icon-v4.png"


def digest(data):
    return sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def distinct_paths(source, output, report):
    for path in (output, report):
        require(path.resolve() != CANONICAL_SOURCE.resolve(), "Canonical artwork cannot be an output or report")
        if path.exists() and CANONICAL_SOURCE.exists():
            require(not path.samefile(CANONICAL_SOURCE), "Canonical artwork cannot be overwritten through an alias")
    paths = [source, output, report]
    for index, left in enumerate(paths):
        for right in paths[index + 1:]:
            require(left.resolve() != right.resolve(), "Source, output and report must be different files")
            if left.exists() and right.exists():
                require(not left.samefile(right), "Source, output and report must not share a file")


def derive(source):
    source_bytes = source.read_bytes()
    with Image.open(BytesIO(source_bytes)) as image:
        require(image.format == "PNG" and image.mode == "RGBA", "Source must be an RGBA PNG")
        image.load()
        width, height = image.size
        alpha = image.getchannel("A")
        bbox = alpha.point(lambda value: 255 if value >= ALPHA_THRESHOLD else 0).getbbox()
        require(bbox is not None, "Source contains no alpha>=128 pixels")
        left, top, right, bottom = bbox
        extent = max(right - left, bottom - top)
        padding = ceil(extent * PADDING_FRACTION)
        side = extent + 2 * padding
        crop_left = floor((left + right - side) / 2)
        crop_top = floor((top + bottom - side) / 2)
        box = (crop_left, crop_top, crop_left + side, crop_top + side)
        require(0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height,
                "The centered crop with safety padding must fit inside the source")

        alpha_bytes = alpha.tobytes()
        max_discarded = 0
        for y in range(height):
            row = alpha_bytes[y * width:(y + 1) * width]
            discarded = row if y < box[1] or y >= box[3] else row[:box[0]] + row[box[2]:]
            max_discarded = max(max_discarded, max(discarded, default=0))
        require(max_discarded <= 1, "Crop would discard visible pixels (alpha>1)")

        cropped = image.crop(box)
        original_rgba = image.tobytes()
        expected_rgba = b"".join(
            original_rgba[(y * width + box[0]) * 4:(y * width + box[2]) * 4]
            for y in range(box[1], box[3])
        )
        require(cropped.mode == "RGBA" and cropped.size == (side, side), "Crop must remain square RGBA")
        require(cropped.tobytes() == expected_rgba, "Crop changed retained RGBA pixels")

    metadata = {
        "schema_version": 1,
        "method": "exact_rgba_crop",
        "source": {"sha256": digest(source_bytes), "size": [width, height]},
        "crop": {
            "box": list(box),
            "size": [side, side],
            "alpha_threshold_inclusive": ALPHA_THRESHOLD,
            "padding_fraction": PADDING_FRACTION,
            "padding_pixels": padding,
            "max_discarded_alpha": max_discarded,
            "rgba_sha256": digest(expected_rgba),
        },
        "resampled": False,
        "rgba_pixels_preserved": True,
    }
    return cropped, metadata


def output_record(output, expected):
    data = output.read_bytes()
    with Image.open(BytesIO(data)) as image:
        require(image.format == "PNG" and image.mode == "RGBA", "Output must be an RGBA PNG")
        image.load()
        require(image.size == expected.size, "Output dimensions differ from the derived crop")
        require(image.tobytes() == expected.tobytes(), "Output RGBA pixels differ from the derived crop")
        return {"sha256": digest(data), "size": list(image.size)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--verify", action="store_true", help="Read-only validation of existing output and report")
    args = parser.parse_args()
    try:
        distinct_paths(args.source, args.output, args.report)
        expected, metadata = derive(args.source)
        if args.verify:
            metadata["output"] = output_record(args.output, expected)
            report = json.loads(args.report.read_text(encoding="utf-8"))
            require(type(report.get("schema_version")) is int and report["schema_version"] == 1,
                    "Report schema version is invalid")
            for key in ("method", "source", "crop", "output"):
                require(report.get(key) == metadata[key], f"Report {key} differs from the current source/output")
            require(report.get("resampled") is False, "Report must explicitly declare resampled=false")
            require(report.get("rgba_pixels_preserved") is True, "Report must explicitly declare preserved RGBA pixels")
            require(isinstance(report.get("pillow_version"), str) and bool(report["pillow_version"]),
                    "Report must record its generating Pillow version")
        else:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.report.parent.mkdir(parents=True, exist_ok=True)
            expected.save(args.output, format="PNG")
            metadata["output"] = output_record(args.output, expected)
            metadata["pillow_version"] = pillow_version
            args.report.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
            )
        print(json.dumps({
            "status": "passed",
            "mode": "verify" if args.verify else "prepare",
            "crop_box": metadata["crop"]["box"],
            "output_size": metadata["output"]["size"],
            "output_sha256": metadata["output"]["sha256"],
            "max_discarded_alpha": metadata["crop"]["max_discarded_alpha"],
            "resampled": False,
            "rgba_pixels_preserved": True,
        }, separators=(",", ":")))
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"Icon crop validation failed: {error}\n")


if __name__ == "__main__":
    main()
