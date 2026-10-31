#!/usr/bin/env python3
"""Verify frozen Mac build inputs without running or relabelling native evidence."""
import hashlib
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "integrations/brush-windows/macos-protection.json"


def verify(root=ROOT, lock=LOCK):
    manifest = json.loads(lock.read_text(encoding="utf-8"))
    failures = []
    for item in manifest["files"]:
        path = root / item["path"]
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        if actual != item["sha256"]:
            failures.append(item["path"])
    if failures:
        raise ValueError("Frozen Mac inputs changed: " + ", ".join(failures))
    return len(manifest["files"])


if __name__ == "__main__":
    try:
        print(f"{verify()} frozen Mac build inputs unchanged; native regression remains separate")
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
