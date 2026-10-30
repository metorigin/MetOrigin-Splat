#!/usr/bin/env python3
"""Validate captured help from the pinned M0 COLMAP executable."""

import argparse
from pathlib import Path
import re


REQUIRED_FLAGS = {
    "feature_extractor": {
        "database_path", "image_path", "ImageReader.camera_model", "ImageReader.single_camera",
        "FeatureExtraction.use_gpu", "FeatureExtraction.num_threads",
        "FeatureExtraction.max_image_size",
    },
    "sequential_matcher": {
        "database_path", "FeatureMatching.use_gpu", "FeatureMatching.num_threads",
    },
    "exhaustive_matcher": {
        "database_path", "FeatureMatching.use_gpu", "FeatureMatching.num_threads",
    },
    "mapper": {
        "database_path", "image_path", "output_path", "Mapper.num_threads",
        "Mapper.ba_use_gpu",
    },
    "global_mapper": {
        "database_path", "image_path", "output_path", "GlobalMapper.num_threads",
        "GlobalMapper.gp_use_gpu", "GlobalMapper.ba_ceres_use_gpu",
    },
    "image_undistorter": {"image_path", "input_path", "output_path", "output_type", "max_image_size"},
}


def validate_help(directory: Path) -> None:
    """Reject missing/incompatible help instead of treating exit code 0 as enough."""
    header = (directory / "colmap.txt").read_text(encoding="utf-8")
    if not re.match(r"COLMAP 4\.1\.0 \(Commit fa8e3b3f[^\n]* without CUDA\)", header):
        raise ValueError("expected COLMAP 4.1.0, commit fa8e3b3f, without CUDA")
    for command, required in REQUIRED_FLAGS.items():
        help_text = (directory / f"{command}.txt").read_text(encoding="utf-8")
        available = set(re.findall(r"^\s+--([A-Za-z0-9_.]+)(?=\s|$)", help_text, re.MULTILINE))
        missing = sorted(required - available)
        if missing:
            raise ValueError(f"{command}: missing CLI flags: {', '.join(missing)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        validate_help(args.directory)
    except (OSError, UnicodeError, ValueError) as error:
        parser.exit(1, f"COLMAP CLI contract failed: {error}\n")
    print("COLMAP 4.1.0 CPU CLI help contract passed; SfM and image decoding remain untested.")


if __name__ == "__main__":
    main()
