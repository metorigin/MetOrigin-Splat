#!/usr/bin/env python3
"""Collect a deliberately small, shareable M0 environment record.

This is build evidence, not an engine/GPU capability probe. No serial numbers,
user names, environment variables, source paths or raw command errors are saved.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile


def command(argv, timeout=30):
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                check=False)
    except FileNotFoundError:
        return {"status": "missing"}
    except subprocess.TimeoutExpired:
        return {"status": "timeout"}
    except OSError:
        return {"status": "unavailable"}
    if result.returncode:
        return {"status": "failed", "exit_code": result.returncode}
    return {"status": "available", "stdout": result.stdout.strip()}


def hardware_summary(payload):
    """Whitelist fields instead of attempting to redact a full system report."""
    hardware = payload.get("SPHardwareDataType", [])
    summary = {}
    if hardware and isinstance(hardware[0], dict):
        for source, key in (("chip_type", "chip"), ("machine_model", "model"),
                            ("physical_memory", "physical_memory"),
                            ("number_processors", "processors")):
            value = hardware[0].get(source)
            if isinstance(value, str):
                summary[key] = value
    summary["displays"] = [
        {key: item[source] for source, key in
         (("sppci_model", "device"), ("spdisplays_metal", "metal_reported"))
         if isinstance(item.get(source), str)}
        for item in payload.get("SPDisplaysDataType", []) if isinstance(item, dict)
    ]
    return summary


def version(executable, args):
    result = command([str(executable), *args])
    if result["status"] == "available":
        # FFmpeg/CMake can print configuration and local paths after the version.
        lines = result.pop("stdout").splitlines()
        result["version"] = "\n".join(lines[:2] if Path(executable).name == "xcodebuild" else lines[:1])
    return result


def collect(rust_bin=None):
    record = {
        "schema_version": 1,
        "recorded_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "purpose": "m0_build_environment_only",
        "host": {"system": platform.system(), "architecture": platform.machine()},
        "target": {"architecture": "arm64", "minimum_macos": "15.0"},
        "gpu_compute_verified": False,
        "minimum_os_verified": False,
    }
    record["host"]["os_version"] = version("/usr/bin/sw_vers", ["-productVersion"])
    profile = command(["/usr/sbin/system_profiler", "SPHardwareDataType",
                       "SPDisplaysDataType", "-json"], timeout=45)
    if profile["status"] == "available":
        try:
            record["hardware"] = hardware_summary(json.loads(profile["stdout"]))
        except (ValueError, AttributeError, TypeError):
            record["hardware"] = {"status": "invalid_report"}
    else:
        record["hardware"] = profile
    record["tools"] = {
        "xcode": version("/usr/bin/xcodebuild", ["-version"]),
        "sdk": version("/usr/bin/xcrun", ["--show-sdk-version"]),
        "python": {"status": "available", "version": platform.python_version()},
    }
    for name, args in (("cargo", ["--version"]), ("rustc", ["--version"]),
                       ("cmake", ["--version"]), ("ninja", ["--version"]),
                       ("node", ["--version"]), ("pnpm", ["--version"]),
                       ("ffmpeg", ["-version"]), ("ffprobe", ["-version"])):
        candidate = rust_bin / name if rust_bin and name in ("cargo", "rustc") else shutil.which(name)
        record["tools"][name] = version(candidate, args) if candidate else {"status": "missing"}
    return record


def write_record(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=path.name + ".", suffix=".tmp", delete=False) as file:
            temporary = Path(file.name)
            json.dump(record, file, indent=2, ensure_ascii=False)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rust-bin", type=Path, help="Optional pinned Rust toolchain bin directory")
    args = parser.parse_args()
    write_record(args.output, collect(args.rust_bin))
    print("Environment record saved. GPU compute and minimum OS remain unverified.")


if __name__ == "__main__":
    main()
