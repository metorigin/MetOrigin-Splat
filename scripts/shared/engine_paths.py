"""Read-only engine layout and lexical access to migrated local build evidence."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PureWindowsPath
import re
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


def _relative_directory(value: object, label: str) -> str:
    if (not isinstance(value, str) or not value or value.strip() != value
            or "\\" in value or any(char in value for char in "\0\r\n:")
            or value.startswith("/") or PureWindowsPath(value).drive
            or any(part in {"", ".", ".."} for part in value.split("/"))):
        raise ValueError(f"{label} must be a repository-relative directory without traversal")
    return value


def _configuration(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise ValueError(f"Unsupported path configuration schema: {path.name}")
    return value


def _layout(repo_root: Path, platform: str, config_path: Path | None) -> tuple[Path, dict, dict[str, Path]]:
    # Do not follow the deliberately retained legacy compatibility links here.
    repo = Path(os.path.abspath(repo_root))
    config = _configuration(Path(config_path) if config_path is not None else repo / "packaging/shared/engine-paths.json")
    platforms = config.get("platforms")
    selected = platforms.get(platform) if isinstance(platforms, dict) and isinstance(platform, str) else None
    if not isinstance(selected, dict) or not isinstance(selected.get("paths"), dict):
        raise ValueError(f"Unsupported engine platform: {platform}")
    cache = _configuration(repo / "packaging/shared/cache-paths.json")
    artifacts = _configuration(repo / "packaging/shared/artifact-paths.json")
    cache_directories = cache.get("directories")
    if not isinstance(cache_directories, dict):
        raise ValueError("Cache directories must be a mapping")
    for key in ("supersplatSource", "supersplatNpm"):
        _relative_directory(cache_directories.get(key), "cache.directories." + key)
    directories = artifacts.get("directories")
    if not isinstance(directories, dict):
        raise ValueError("Artifact directories must be a mapping")
    for key in ("packages", "verification", "licenses"):
        _relative_directory(directories.get(key), "directories." + key)
    if platform not in {"macos-arm64", "windows-x64"}:
        raise ValueError(f"Unsupported artifact platform: {platform}")
    roots = {
        "engines": repo / _relative_directory(config.get("engines_root"), "engines_root"),
        "cache": repo / _relative_directory(cache.get("root"), "cache.root"),
        "verification": (repo / _relative_directory(artifacts.get("root"), "artifacts.root")
                         / _relative_directory(directories.get("verification"), "directories.verification")
                         / platform),
    }
    paths = {}
    for key, record in selected["paths"].items():
        base = record.get("base") if isinstance(record, dict) else None
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", key) or not isinstance(base, str) or base not in roots:
            raise ValueError(f"Invalid engine path definition: {key}")
        paths[key] = roots[record["base"]] / _relative_directory(record.get("path"), key)
    for key in ("developmentRoot", "distributionRoot"):
        if key not in paths or selected["paths"][key].get("base") != "engines":
            raise ValueError(f"Engine layout must define {key} beneath engines_root")
    paths["distributionEngines"] = paths["distributionRoot"] / "engines"
    paths["releaseStatus"] = paths["distributionRoot"] / "release-status.json"
    mappings = selected.get("legacy_mappings", {})
    if not isinstance(mappings, dict):
        raise ValueError("Legacy engine mappings must be a mapping")
    for old, record in mappings.items():
        prefix = repo / _relative_directory(old, "legacy mapping")
        key = record.get("key") if isinstance(record, dict) else None
        if not isinstance(key, str) or key not in paths or ("compatibility_link" in record and type(record["compatibility_link"]) is not bool):
            raise ValueError(f"Invalid legacy engine mapping: {old}")
        if record.get("compatibility_link") and (not old.startswith("target/") or paths[key] == prefix or prefix in paths[key].parents):
            raise ValueError(f"Unsafe engine compatibility entry: {old}")
    flat = selected.get("flat_compatibility", {})
    if not isinstance(flat, dict):
        raise ValueError("Flat engine compatibility paths must be a mapping")
    for name, key in flat.items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or not isinstance(key, str) or key not in paths:
            raise ValueError(f"Invalid flat engine compatibility entry: {name}")
    return repo, selected, paths


def resolve_engine_paths(repo_root: Path = REPOSITORY_ROOT, platform: str = "macos-arm64",
                         config_path: Path | None = None) -> dict[str, Path]:
    """Resolve absolute destinations without creating, moving or rewriting files."""
    return _layout(Path(repo_root), platform, config_path)[2]


def map_legacy_path(path: Path, repo_root: Path = REPOSITORY_ROOT, platform: str = "macos-arm64",
                    config_path: Path | None = None) -> Path:
    """Map only local recorded paths, preferring the longest old directory prefix.

    This changes the path used for I/O; callers retain original receipt text.
    Paths outside this checkout and unmatched local paths remain unchanged.
    """
    repo, selected, paths = _layout(Path(repo_root), platform, config_path)
    candidate = Path(os.path.abspath(repo / path))
    mappings = selected.get("legacy_mappings", {})
    if not isinstance(mappings, dict):
        raise ValueError("Legacy engine mappings must be a mapping")
    matches = []
    for old, record in mappings.items():
        prefix = repo / _relative_directory(old, "legacy mapping")
        key = record.get("key") if isinstance(record, dict) else None
        if not isinstance(key, str) or key not in paths:
            raise ValueError(f"Invalid legacy engine mapping: {old}")
        if "compatibility_link" in record and type(record["compatibility_link"]) is not bool:
            raise ValueError(f"Invalid compatibility-link marker: {old}")
        if candidate == prefix or prefix in candidate.parents:
            matches.append((len(prefix.parts), paths[record["key"]] / candidate.relative_to(prefix)))
    return max(matches, key=lambda item: item[0])[1] if matches else candidate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=REPOSITORY_ROOT)
    parser.add_argument("--platform", default="macos-arm64")
    parser.add_argument("--key")
    args = parser.parse_args(argv)
    try:
        paths = resolve_engine_paths(args.repo_root, args.platform)
        if args.key:
            if args.key not in paths:
                raise ValueError(f"Unknown engine path key: {args.key}")
            print(paths[args.key])
        else:
            print(json.dumps({key: str(value) for key, value in paths.items()}))
    except (OSError, ValueError) as error:
        print(f"Engine paths: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
