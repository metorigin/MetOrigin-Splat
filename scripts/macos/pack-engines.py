#!/usr/bin/env python3
"""Build a relocatable, ad-hoc-signed macOS arm64 engine pack from local artifacts.

The output is a candidate, not a distribution approval. Existing destinations are
never replaced. Original binaries are checked before and after all operations.
"""

from dataclasses import asdict
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

from pack_macos import collect_closure, copy_closure, run, safe_pack_path, sha256, verify_pack, write_json
from pack_licenses import collect_ffmpeg_licenses, collect_licenses, deliver_rebuild_repository
from pack_spdx import write_release_status, write_spdx
from pack_brush_licenses import target_packages

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))
from engine_paths import resolve_engine_paths


BRUSH_SOURCE_EXCLUSIONS = {"crates/lpips/burn_mapped.bpk", "crates/lpips/apple.png", "crates/lpips/pear.png"}


def source_archive(source: Path, destination: Path, commit: str, exclusions: set) -> dict:
    actual = run(["/usr/bin/git", "-C", source, "rev-parse", "HEAD"]).strip()
    if actual != commit:
        raise ValueError(f"source commit mismatch: {source}: {actual} != {commit}")
    paths = subprocess.check_output(["/usr/bin/git", "-C", str(source), "ls-files", "--cached",
                                     "--others", "--exclude-standard", "-z"]).decode().split("\0")
    destination.parent.mkdir(parents=True, exist_ok=True)
    delivered = 0
    with tarfile.open(destination, "w") as archive:
        for name in sorted(set(paths) - exclusions - {""}):
            path = source / name
            if not path.exists():
                continue  # A tracked deletion is part of the patched source state.
            if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(source.resolve()):
                raise ValueError(f"unsafe source archive member: {path}")
            info = archive.gettarinfo(str(path), arcname="source/" + name)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            with path.open("rb") as contents:
                archive.addfile(info, contents)
            delivered += 1
    return {"source_commit": commit, "archive": destination.name, "sha256": sha256(destination),
            "archive_format": "deterministic tar of actual tracked/patched source files",
            "file_count": delivered, "excluded_paths": sorted(exclusions)}



def finalize_brush_audit(engine_root, metadata, source_identity):
    """Approve complete graph evidence only after exact sources are delivered."""
    audit_path = engine_root / "provenance/audit.json"
    audit = json.loads(audit_path.read_text())
    if audit["cargo_lock_sha256"] != metadata["cargo_lock_sha256"]:
        raise ValueError("Brush evidence lockfile disagrees with immutable artifact")
    tree_path = engine_root / "provenance/cargo/target-tree.txt"
    tree_hash = sha256(tree_path)
    active = target_packages(tree_path.read_text())
    declared = {(component["name"], component["version"]): component["license_declared"]
                for component in audit["components"]}
    if not active or active != declared or len(declared) != len(audit["components"]):
        raise ValueError("Brush audit components do not match its actual target graph")
    if tree_hash != audit["target_graph_sha256"]:
        raise ValueError("Brush license target graph changed")
    if metadata.get("target_graph_sha256") and tree_hash != metadata["target_graph_sha256"]:
        raise ValueError("Brush license graph disagrees with immutable artifact")
    for component in audit["components"]:
        source = component["source_archive"]
        if "sha256" not in source:
            if component["source"] != "workspace" or source["path"] != "provenance/source.tar":
                raise ValueError("Brush component lacks exact corresponding source: " + component["id"])
            source["sha256"] = source_identity["sha256"]
            source["scope"] = "actual patched workspace source delivered with this artifact"
        checks = [(component["manifest"], component["manifest_sha256"]),
                  (source["path"], source["sha256"])]
        checks.extend((notice["path"], notice["sha256"]) for notice in component["licenses"])
        for relative, expected in checks:
            if sha256(safe_pack_path(engine_root, relative)) != expected:
                raise ValueError("Brush license/source evidence changed: " + relative)
    audit["corresponding_source_status"] = "locked_crates_git_sources_and_actual_patched_workspace_delivered"
    audit["release_ready"] = not audit["issues"] and all(
        component["licenses"] and component["license_declared"] for component in audit["components"])
    write_json(audit_path, audit)
    return audit

def deliver_packaging_recipes(repo_root: Path, engine_root: Path) -> dict:
    """Keep flat source snapshots and publish the executable repository tree."""
    flat = Path(engine_root) / "provenance/packaging"
    flat.mkdir(parents=True, exist_ok=True)
    for script in ("pack-engines.py", "pack_macos.py", "pack_licenses.py", "pack_sources.py",
                   "pack_spdx.py", "pack_brush_licenses.py", "pack-brush-notices.py"):
        shutil.copyfile(Path(repo_root) / "scripts/macos" / script, flat / script)
    return deliver_rebuild_repository(repo_root, engine_root)


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[2]
    parser.add_argument("--repo-root", type=Path, default=root)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--pack-version", default="0.1.0-alpha.1")
    parser.add_argument("--colmap-install", type=Path)
    parser.add_argument("--colmap-build", type=Path)
    parser.add_argument("--colmap-source", type=Path)
    parser.add_argument("--conda-prefix", type=Path)
    parser.add_argument("--conda-cache", type=Path)
    parser.add_argument("--ffmpeg-source", type=Path)
    parser.add_argument("--ffmpeg-build", type=Path)
    parser.add_argument("--ffmpeg-install", type=Path)
    parser.add_argument("--brush-artifact", type=Path, required=True, help="Immutable directory containing brush-cli and build-info.json")
    parser.add_argument("--brush-source", type=Path)
    parser.add_argument("--brush-evidence", type=Path, help="Prepared Brush license/SBOM tree containing brush/licenses and brush/provenance")
    parser.add_argument("--source-cache", type=Path, help="Optional checksum-addressed source archive cache")
    return parser, parser.parse_args(argv)


def resolve_pack_inputs(args):
    """Resolve defaults after --repo-root, retaining explicit caller inputs."""
    repo = args.repo_root.resolve()
    paths = resolve_engine_paths(repo)
    selected = {name: Path(getattr(args, name) or paths[key]).resolve() for name, key in {
        "output": "distributionEngines", "colmap_install": "colmapAlphaInstallEvidence",
        "colmap_build": "colmapAlphaBuildEvidence", "colmap_source": "colmapSource",
        "conda_prefix": "colmapAlphaDependencyEvidence", "conda_cache": "condaPackageCache",
        "ffmpeg_source": "ffmpegSource", "ffmpeg_build": "ffmpegBuildEvidence",
        "ffmpeg_install": "ffmpegInstall",
    }.items()}
    selected["brush_artifact"] = args.brush_artifact.resolve()
    if args.brush_source is not None:
        selected["brush_source"] = args.brush_source.resolve()
    else:
        metadata = json.loads((selected["brush_artifact"] / "build-info.json").read_text())
        profile = metadata.get("patch_id", "")
        suffix = profile.removeprefix("metorigin-macos.") if profile.startswith("metorigin-macos.") else profile
        if not suffix or "brushSource." + suffix not in paths:
            raise ValueError("Brush artifact has no recognized source profile; supply --brush-source explicitly")
        selected["brush_source"] = paths["brushSource." + suffix]
    return repo, selected


def main():
    parser, args = parse_arguments()
    repo, inputs = resolve_pack_inputs(args)
    output = inputs["output"]
    if output.exists():
        parser.error("output already exists; choose a new output path to preserve existing evidence")
    configs = {
        "ffmpeg": {"executables": {"ffmpeg": inputs["ffmpeg_install"] / "bin/ffmpeg", "ffprobe": inputs["ffmpeg_install"] / "bin/ffprobe"},
                   "roots": [inputs["ffmpeg_install"]], "source": inputs["ffmpeg_source"], "info": inputs["ffmpeg_build"] / "build-info.json",
                   "url": "https://github.com/FFmpeg/FFmpeg"},
        "colmap": {"executables": {"colmap": inputs["colmap_install"] / "bin/colmap"},
                   "roots": [inputs["colmap_install"], inputs["conda_prefix"]], "source": inputs["colmap_source"],
                   "info": inputs["colmap_build"] / "build-info.json", "url": "https://github.com/colmap/colmap"},
        "brush": {"executables": {"brush": inputs["brush_artifact"] / "brush-cli"},
                  "roots": [inputs["brush_artifact"]], "source": inputs["brush_source"],
                  "info": inputs["brush_artifact"] / "build-info.json", "url": "https://github.com/ArthurBrussee/brush"},
    }
    for config in configs.values():
        for origin in [*config["roots"], config["source"], config["info"].parent]:
            origin = origin.resolve()
            if output.is_relative_to(origin) or origin.is_relative_to(output):
                parser.error("output must not overlap a development input: " + str(origin))
    if args.source_cache and (output.is_relative_to(args.source_cache.resolve()) or args.source_cache.resolve().is_relative_to(output)):
        parser.error("output must not overlap the source archive cache")
    for config in configs.values():
        config["metadata"] = json.loads(config["info"].read_text())
        config["graph"], config["edges"] = collect_closure(config["executables"], config["roots"])
        config["original_hashes"] = {str(p): sha256(p) for p in config["graph"]}
        expected = config["metadata"].get("binary_sha256")
        if expected and sha256(next(iter(config["executables"].values()))) != expected:
            raise ValueError("artifact binary disagrees with build-info: " + str(config["info"]))
    for entry in configs["ffmpeg"]["metadata"]["files"]:
        if sha256(inputs["ffmpeg_install"] / entry["path"]) != entry["sha256"]:
            raise ValueError("FFmpeg artifact disagrees with build-info: " + entry["path"])
    brush_info = configs["brush"]["metadata"]
    if sha256(configs["brush"]["source"] / "Cargo.lock") != brush_info["cargo_lock_sha256"]:
        raise ValueError("Brush Cargo.lock disagrees with immutable artifact")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".engine-pack-staging-", dir=output.parent))
    # A failed stage is intentionally retained for investigation, never substituted for output.
    manifest = {"schema_version": 1, "pack_version": args.pack_version, "platform": "macos-arm64", "engines": {}}
    for engine, config in configs.items():
        runtime_fields = json.loads((repo / "packaging/macos-arm64/runtime-prefix-fields.json").read_text()) if engine == "colmap" else None
        targets = copy_closure(stage / engine, config["executables"], config["graph"], config["edges"], runtime_fields)
        config["targets"] = targets
        provenance = stage / engine / "provenance"
        # Every producer, including Brush, delivers executable recipes separately
        # from the retained flat source/evidence snapshots above.
        deliver_packaging_recipes(repo, stage / engine)
        if runtime_fields:
            write_json(provenance / "packaging/runtime-prefix-fields.json", runtime_fields)
        shutil.copyfile(config["info"], provenance / "original-build-info.json")
        write_json(provenance / "relocation-map.json", [
            {"source": str(source), "source_sha256": config["original_hashes"][str(source)],
             "packaged_path": str(target.relative_to(stage)), "packaged_sha256": sha256(target),
             "original_load_commands": asdict(config["graph"][source])} for source, target in targets.items()])
        metadata = config["metadata"]
        source = source_archive(config["source"], provenance / "source.tar", metadata["source_commit"],
                                BRUSH_SOURCE_EXCLUSIONS if engine == "brush" else set())
        if engine == "brush":
            patch = repo / "integrations/brush-macos/patches" / (metadata["patch_id"] + ".patch")
            if sha256(patch) != metadata["patch_sha256"]:
                raise ValueError("Brush patch disagrees with artifact metadata")
            shutil.copyfile(patch, provenance / patch.name)
            shutil.copyfile(config["source"] / "Cargo.lock", provenance / "Cargo.lock")
            (stage / engine / "licenses").mkdir()
            shutil.copyfile(config["source"] / "LICENSE", stage / engine / "licenses/LICENSE")
            source["patch"] = {"path": patch.name, "sha256": sha256(patch)}
            for name in ("build-brush.sh", "prepare-brush-source.py"):
                shutil.copyfile(repo / "scripts/macos" / name, provenance / name)
            policy = args.brush_artifact.resolve() / "distribution-policy.json"
            if policy.is_file():
                shutil.copyfile(policy, provenance / policy.name)
            lpips_audit = repo / "integrations/brush-macos/LPIPS-AUDIT.md"
            if lpips_audit.is_file():
                shutil.copyfile(lpips_audit, provenance / lpips_audit.name)
            if args.brush_evidence:
                shutil.copytree(args.brush_evidence.resolve() / "brush", stage / "brush", dirs_exist_ok=True)
                finalize_brush_audit(stage / "brush", metadata, source)
        write_json(provenance / "source-identity.json", source)
        manifest["engines"][engine] = {"version": metadata.get("cli_version", metadata.get("version")),
            "executables": {name: str(targets[path.resolve()].relative_to(stage)) for name, path in config["executables"].items()},
            "source_url": config["url"] + "/tree/" + metadata["source_commit"], "source_sha256": source["sha256"],
            "files": [], "license_files": []}
    audit = collect_licenses(repo, list(configs["colmap"]["graph"]), stage,
                             colmap_build=inputs["colmap_build"], colmap_source=inputs["colmap_source"],
                             conda_prefix=inputs["conda_prefix"], conda_cache=inputs["conda_cache"])
    ffmpeg_audit = collect_ffmpeg_licenses(repo, stage, ffmpeg_build=inputs["ffmpeg_build"],
                                          ffmpeg_source=inputs["ffmpeg_source"], ffmpeg_install=inputs["ffmpeg_install"])
    # The complete local source archive and build instructions have now been delivered.
    ffmpeg_audit["corresponding_source_status"] = "source.tar_and_build_materials_delivered"
    ffmpeg_audit["issues"] = []
    ffmpeg_audit["release_ready"] = True
    write_json(stage / "ffmpeg/provenance/audit.json", ffmpeg_audit)
    audit["components"][0]["corresponding_source_status"] = "source.tar_and_build_materials_delivered"
    if args.source_cache:
        from pack_sources import include_sources
        include_sources(audit, args.source_cache.resolve(), stage / "colmap")
    write_json(stage / "colmap/provenance/audit.json", audit)
    for engine, record in manifest["engines"].items():
        write_spdx(stage / engine, engine, record["version"])
        record["files"] = [{"path": str(p.relative_to(stage)), "sha256": sha256(p), "size_bytes": p.stat().st_size}
                           for p in sorted((stage / engine).rglob("*")) if p.is_file()]
        record["license_files"] = [e["path"] for e in record["files"] if e["path"].startswith(engine + "/licenses/")]
    write_json(stage / "engine-manifest.json", manifest)
    report = verify_pack(stage)
    for config in configs.values():
        for source, expected in config["original_hashes"].items():
            if sha256(Path(source)) != expected:
                raise ValueError("original development file changed during packaging: " + source)
    stage.rename(output)
    release_status = write_release_status(output)
    write_json(output.parent / (output.name + "-verification.json"), report)
    print(json.dumps({"pack": str(output), "manifest_sha256": report["manifest_sha256"],
                      "macho_count": report["macho_count"], "file_count": report["file_count"],
                      "total_bytes": report["total_bytes"], "release_ready": release_status["distributable"],
                      "note": "See per-engine provenance/audit.json and same-host relocation evidence; release gates remain separate."}, indent=2))


if __name__ == "__main__":
    main()
