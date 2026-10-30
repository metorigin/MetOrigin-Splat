"""Verify native FFmpeg build identity, configuration and relocatable dylib links."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def validate_version(output, name):
    if not re.match(rf"{name} version (?:n)?8\.1\.2(?:\s|$)", output):
        raise ValueError(f"{name} does not report the fixed 8.1.2 release")
    for flag in ("--disable-gpl", "--disable-version3", "--disable-nonfree",
                 "--disable-autodetect", "--disable-network", "--enable-shared",
                 "--disable-static", "--enable-zlib"):
        if flag not in output.split():
            raise ValueError(f"{name} is missing required configuration {flag}")
    for flag in ("--enable-gpl", "--enable-version3", "--enable-nonfree"):
        if flag in output.split():
            raise ValueError(f"{name} contains forbidden configuration {flag}")


def validate_links(output):
    dependencies = []
    for line in output.splitlines()[1:]:
        dependency = line.strip().split(" (compatibility version", 1)[0]
        if not dependency.startswith(("@rpath/", "/usr/lib/", "/System/Library/")):
            raise ValueError(f"non-relocatable or external dependency: {dependency}")
        dependencies.append(dependency)
    if not dependencies:
        raise ValueError("missing Mach-O dependency inventory")
    return dependencies


def verify(install_dir, build_dir, source_commit, deployment_target):
    records = []
    for name in ("ffmpeg", "ffprobe"):
        binary = install_dir / "bin" / name
        version = run(str(binary), "-version")
        validate_version(version, name)
        (build_dir / f"{name}-version.txt").write_text(version)
        license_text = run(str(binary), "-L")
        normalized_license = " ".join(license_text.split())
        if "GNU Lesser General Public License" not in normalized_license or "version 2.1" not in normalized_license:
            raise ValueError(f"{name} does not report LGPL 2.1")
        (build_dir / f"{name}-license.txt").write_text(license_text)
    paths = [install_dir / "bin" / name for name in ("ffmpeg", "ffprobe")]
    paths += sorted(p for p in (install_dir / "lib").glob("*.dylib") if not p.is_symlink())
    if len(paths) <= 2:
        raise ValueError("shared FFmpeg libraries are missing")
    for path in paths:
        if run("lipo", "-archs", str(path)).strip() != "arm64":
            raise ValueError(f"not native arm64: {path.name}")
        links = validate_links(run("otool", "-L", str(path)))
        for dependency in links:
            if dependency.startswith("@rpath/") and not (install_dir / "lib" / dependency[7:]).is_file():
                raise ValueError(f"unresolved bundled dependency: {dependency}")
        commands = run("otool", "-l", str(path))
        if not re.search(rf"\bminos {re.escape(deployment_target)}(?:\s|$)", commands):
            raise ValueError(f"unexpected minimum deployment target: {path.name}")
        (build_dir / f"{path.name}-load-commands.txt").write_text(commands)
        records.append({
            "path": str(path.relative_to(install_dir)),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size_bytes": path.stat().st_size,
            "dependencies": links,
        })
    result = {
        "schema_version": 1, "engine": "ffmpeg", "version": "8.1.2",
        "source_commit": source_commit, "target": "aarch64-apple-darwin",
        "deployment_target": deployment_target, "license": "LGPL-2.1-or-later",
        "files": records, "media_smoke_passed": False,
    }
    temporary = build_dir / "build-info.json.tmp"
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(build_dir / "build-info.json")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-dir", type=Path, required=True)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--deployment-target", required=True)
    args = parser.parse_args()
    verify(args.install_dir, args.build_dir, args.source_commit, args.deployment_target)
