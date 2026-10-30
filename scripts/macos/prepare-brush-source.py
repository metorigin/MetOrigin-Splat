#!/usr/bin/env python3
"""Apply only a checksum-pinned integration patch to an isolated Brush checkout."""

import argparse
import hashlib
from pathlib import Path
import subprocess


COMMIT = "1388f74c6fe0236f68ee4915564bf00e9d2e3747"
PATCH_ID = "metorigin-macos.1"
PATCH_SHA256 = "00f507d8d14290232f2ddc02d5cffed88f127044a0bb3bd9e19ea9055929aadb"
PATCH = (Path(__file__).resolve().parents[2] / "integrations/brush-macos/patches/"
         "0001-report-initialized-adapter.patch")
PROFILES = {
    PATCH_ID: (PATCH, PATCH_SHA256),
    "metorigin-macos.2": (PATCH.with_name("metorigin-macos.2.patch"),
                          "0bd728c9f1048372791eb28923a7af5dd10d3ad1dd9b5cbf62ae5de57182cfc7"),
    "metorigin-macos.3": (PATCH.with_name("metorigin-macos.3.patch"),
                          "f2e0853ba495e492fa5ebb890ed8d2a7886ce54752740daacbc67aff3c228cc8"),
    "metorigin-macos.4": (PATCH.with_name("metorigin-macos.4.patch"),
                          "95e56aaa6b253fa21174d8ef002e95eba4a79f684d3b75a3b565f10141ccf631"),
    "metorigin-macos.5": (PATCH.with_name("metorigin-macos.5.patch"),
                          "1034676b02f2c42624368bb7183a315dc787037d8605cdbb7fde16c6e0b13249"),
    "metorigin-macos.6": (PATCH.with_name("metorigin-macos.6.patch"),
                          "1e342de3d80fc9ae3ac38873814b17b9bc6d8ce067159ad3eae02ef3148353d2"),
}
DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames",
             "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "HEAD"]


def prepare(source, patch=PATCH, expected_commit=COMMIT, expected_sha256=PATCH_SHA256, apply=True):
    source = Path(source).resolve()

    def git(*args, check=True):
        return subprocess.run(["git", "-C", str(source), *args], check=check,
                              capture_output=True)

    patch_bytes = Path(patch).read_bytes()
    if hashlib.sha256(patch_bytes).hexdigest() != expected_sha256:
        raise ValueError("Diagnostics patch checksum mismatch")
    if git("rev-parse", "HEAD").stdout.decode().strip() != expected_commit:
        raise ValueError("Diagnostics patch requires the pinned Brush commit")
    if git("symbolic-ref", "--quiet", "HEAD", check=False).returncode != 1:
        raise ValueError("Diagnostics patch requires a detached checkout; preserve user branches")
    if git("diff", "--cached", "--quiet", check=False).returncode != 0:
        raise ValueError("Diagnostics patch refuses staged changes")
    if git("ls-files", "--others", "--exclude-standard").stdout:
        raise ValueError("Diagnostics patch refuses untracked source files")
    diff = git(*DIFF_ARGS).stdout
    if diff == patch_bytes:
        return "already_applied"
    if diff:
        raise ValueError("Source has changes other than the pinned diagnostics patch")
    if not apply:
        raise ValueError("Expected diagnostics patch is not applied")
    git("apply", "--check", str(Path(patch).resolve()))
    git("apply", "--intent-to-add", str(Path(patch).resolve()))
    if git(*DIFF_ARGS).stdout != patch_bytes:
        raise ValueError("Patched source differs from the pinned diagnostics patch")
    return "applied"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--verify", action="store_true", help="Only verify already-patched source")
    parser.add_argument("--profile", choices=PROFILES, default=PATCH_ID)
    args = parser.parse_args()
    try:
        patch, checksum = PROFILES[args.profile]
        print(prepare(args.source, patch=patch, expected_sha256=checksum, apply=not args.verify))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Brush source preparation failed: {error}\n")
