#!/usr/bin/env python3
"""Collect local license/provenance evidence for an actual COLMAP dylib closure.

No downloads or release approval. Recipe URLs/hashes are evidence, not delivered
corresponding source. Uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_records(recipe: Path) -> list[dict]:
    """Read rendered source blocks conservatively, preserving exact line evidence.

    This is deliberately not a YAML interpreter. Never evaluate recipe templates
    or infer a hash from a version. Multiple mirror URLs retain their source item.
    """
    lines = recipe.read_text().splitlines()
    records = []
    for index, line in enumerate(lines):
        match = re.fullmatch(r"(\s*)source:\s*", line)
        if not match:
            continue
        indent = len(match[1])
        block = []
        for number, current in enumerate(lines[index + 1 :], index + 2):
            if current.strip() and not current.lstrip().startswith("#"):
                depth = len(current) - len(current.lstrip())
                if depth < indent or (depth == indent and not current.lstrip().startswith("-")):
                    break
            block.append((number, current))
        groups = [[]]
        list_starts = [(len(text) - len(text.lstrip()), number) for number, text in block
                       if re.match(r"\s*-\s+[\w_]+:(?:\s|$)", text)]
        list_depth = min((depth for depth, _ in list_starts), default=None)
        for number, current in block:
            if (list_depth is not None and len(current) - len(current.lstrip()) == list_depth
                    and re.match(r"\s*-\s+[\w_]+:(?:\s|$)", current) and groups[-1]):
                groups.append([])
            groups[-1].append((number, current))
        for group in groups:
            raw = "\n".join(line for _, line in group)
            urls = re.findall(r"https?://[^\s\"'\],]+", raw)
            hashes = re.findall(r"\bsha256:\s*[\"']?([a-fA-F0-9]{64})\b", raw)
            patches = re.findall(r"^\s*-\s+[\"']?([^\s\"']+\.(?:patch|diff))[\"']?\s*$", raw, re.M)
            if urls:
                records.append({"urls": urls, "sha256": hashes,
                                "patches": patches, "line": group[0][0],
                                "exact_recipe_source_block": raw,
                                "archive_collected": False})
    return records


def collect_licenses(repo_root: Path, closure_paths: list[Path], output_dir: Path,
                     colmap_build: Path | None = None,
                     colmap_source: Path | None = None,
                     conda_prefix: Path | None = None,
                     conda_cache: Path | None = None) -> dict:
    """Write <output_dir>/colmap/{licenses,provenance}; return audit/SBOM inputs.

    Select static components from the actual final executable link statement,
    not default CMake options. Canonical physical files determine package owners;
    packages owning only aliases (e.g. libblas) are recorded separately.
    """
    repo_root = Path(repo_root).resolve()
    m0 = repo_root / "target/macos-m0"
    build = Path(colmap_build or m0 / "colmap-build").resolve()
    source = Path(colmap_source or m0 / "colmap").resolve()
    prefix = Path(conda_prefix or m0 / "colmap-deps").resolve()
    cache = Path(conda_cache or m0 / "conda-pkgs").resolve()
    output = Path(output_dir).resolve() / "colmap"
    output.mkdir(parents=True, exist_ok=True)
    closure = {Path(p).resolve() for p in closure_paths}
    issues = []

    def copy(path: Path, relative: str | Path) -> dict:
        dest = output / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
        return {"path": str(dest.relative_to(output)), "sha256": sha256(dest),
                "evidence_origin": str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)}

    metadata = []
    for path in sorted((prefix / "conda-meta").glob("*.json")):
        data = json.loads(path.read_text())
        metadata.append((path, data))
    exact = {}
    aliases = {}
    for path, data in metadata:
        for filename in data.get("files", []):
            absolute = prefix / filename
            if absolute in closure:
                exact.setdefault(absolute, []).append(path.stem)
            elif absolute.is_symlink() and absolute.resolve() in closure:
                aliases.setdefault(path.stem, []).append(filename)
    owned = {owner for owners in exact.values() for owner in owners}
    for path in sorted(closure):
        if path.is_relative_to(prefix) and len(exact.get(path, [])) != 1:
            issues.append({"kind": "ambiguous_or_missing_owner", "file": str(path),
                           "owners": exact.get(path, [])})

    ninja = (build / "build.ninja").read_text()
    final_link = re.search(r"^build src/colmap/exe/colmap:.*?(?=^build |\Z)", ninja, re.M | re.S)
    if not final_link:
        raise ValueError("Cannot find final COLMAP executable link statement")
    link = final_link[0]
    cache_text = (build / "CMakeCache.txt").read_text()
    flags = dict(re.findall(r"^([A-Z][A-Z_]+):(?:BOOL|STRING|UNINITIALIZED)=(.*)$", cache_text, re.M))
    # Headers compile into object files even though no CGAL/Eigen dylib exists.
    header_names = {"eigen", "libboost-headers"}
    if flags.get("CGAL_ENABLED") == "ON":
        header_names.add("cgal-cpp")
    header_ids = {path.stem for path, data in metadata if data["name"] in header_names}
    selected = owned | header_ids
    components = []
    for meta_path, data in metadata:
        component_id = meta_path.stem
        if component_id not in selected:
            continue
        info = cache / component_id / "info"
        provenance = Path("provenance/conda") / component_id
        license_root = Path("licenses/conda") / component_id
        component = {"id": component_id, "name": data["name"], "version": data["version"],
                     "build": data["build"], "license_declared": data.get("license", "NOASSERTION"),
                     "linkage": "header-only" if component_id in header_ids else "dynamic",
                     "binary_package": {"url": data.get("url"), "sha256": data.get("sha256")},
                     "files": sorted(str(path.relative_to(prefix)) for path, owners in exact.items() if component_id in owners),
                     "aliases": sorted(aliases.get(component_id, [])), "licenses": [], "evidence": [],
                     "sources": [], "corresponding_source_status": "not_collected"}
        for name in ["index.json", "about.json", "hash_input.json", "git"]:
            if (info / name).is_file():
                component["evidence"].append(copy(info / name, provenance / name))
        if (info / "about.json").is_file():
            about = json.loads((info / "about.json").read_text())
            extra = about.get("extra", {})
            component["feedstock"] = {"url": extra.get("remote_url"), "commit": extra.get("sha")}
        recipe_dir = info / "recipe"
        for path in sorted(recipe_dir.rglob("*")):
            if path.is_file():
                component["evidence"].append(copy(path, provenance / "recipe" / path.relative_to(recipe_dir)))
        for name in ["rendered_recipe.yaml", "meta.yaml", "recipe.yaml"]:
            recipe = recipe_dir / name
            if recipe.is_file():
                component["source_recipe"] = str(provenance / "recipe" / name)
                component["sources"] = source_records(recipe)
                break
        for path in sorted((info / "licenses").rglob("*")):
            if path.is_file():
                component["licenses"].append(copy(path, license_root / path.relative_to(info / "licenses")))
        # Split-output packages sometimes install notices outside info/licenses.
        for filename in data.get("files", []):
            path = prefix / filename
            if path.is_file() and (filename.startswith("share/licenses/") or
                                  (filename.startswith("share/doc/") and re.search(r"(?:LICENSE|COPYING)", path.name))):
                component["licenses"].append(copy(path, license_root / "installed" / filename))
        if data["name"] == "libfreetype6" and not component["licenses"]:
            # Same upstream version, matching feedstock commit, split package.
            for sibling_path, sibling in metadata:
                if sibling["name"] != "freetype" or sibling["version"] != data["version"]:
                    continue
                sibling_info = cache / sibling_path.stem / "info"
                sibling_about = json.loads((sibling_info / "about.json").read_text())
                if sibling_about.get("extra", {}).get("sha") != component["feedstock"]["commit"]:
                    continue
                for path in sorted((sibling_info / "licenses").rglob("*")):
                    if path.is_file():
                        component["licenses"].append(copy(path, license_root / "sibling-freetype" / path.relative_to(sibling_info / "licenses")))
                component["license_selection"] = "FTL"
        if data["name"] in {"libgcc", "libgfortran5"}:
            # The package carries the exception, but omits its GPLv3 base text.
            gpl = prefix / "share/doc/CGAL/LICENSE.GPL"
            if gpl.is_file():
                component["licenses"].append(copy(gpl, license_root / "GPL-3.0-standard-text.txt"))
            component["notes"] = ["GCC exception applies only to covered runtime code; it does not remove source obligations for distributing the runtime itself.",
                                  "libgcc package also owns libquadmath: package-level license metadata is not file-level proof. Obtain exact GCC source and verify libquadmath LGPL notices."] if data["name"] == "libgcc" else ["GCC runtime exception and exact recipe evidence retained."]
        if data["name"] == "libsqlite":
            header = prefix / "include/sqlite3.h"
            if header.is_file():
                component["licenses"].append(copy(header, license_root / "sqlite3.h"))
        if data["name"] == "ffmpeg":
            # The Conda license field says GPL-2.0-or-later, but this variant
            # enables version3. Record actual embedded configure evidence.
            for filename in component["files"]:
                if not Path(filename).name.startswith("libavcodec."):
                    continue
                configs = [part.decode("utf-8", errors="replace") for part in (prefix / filename).read_bytes().split(b"\0")
                           if b"--enable-gpl" in part and b"--enable-version3" in part and b"--prefix=" in part]
                if configs:
                    config_path = output / provenance / "embedded-configure.txt"
                    config_path.write_text("\n".join(configs) + "\n")
                    component["license_effective"] = "GPL-3.0-or-later"
                    component["license_effective_evidence"] = str(config_path.relative_to(output))
        if not component["licenses"]:
            issues.append({"kind": "license_text_missing", "component": component_id})
        if not component["sources"]:
            issues.append({"kind": "source_locator_missing", "component": component_id})
        for entry in component["sources"]:
            entry["patch_evidence"] = []
            for patch in entry["patches"]:
                patch_file = next((p for p in [recipe_dir / patch, recipe_dir / "parent" / patch] if p.is_file()), None)
                if patch_file:
                    entry["patch_evidence"].append({"path": str(provenance / "recipe" / patch_file.relative_to(recipe_dir)), "sha256": sha256(patch_file)})
                else:
                    issues.append({"kind": "recipe_patch_missing", "component": component_id, "patch": patch})
        if "GPL" in component["license_declared"] or data["name"] in {"eigen", "cgal-cpp"}:
            issues.append({"kind": "corresponding_source_not_delivered", "component": component_id})
        components.append(component)

    build_info = json.loads((build / "build-info.json").read_text())
    commit = build_info["source_commit"]
    colmap = {"id": "colmap", "name": "COLMAP", "version": build_info["version"],
              "license_declared": "BSD-3-Clause", "license_scope": "COLMAP-authored code only; linked components have their own licenses",
              "linkage": "executable", "source": {"url": "https://github.com/colmap/colmap", "commit": commit},
              "licenses": [copy(source / "COPYING.txt", "licenses/COLMAP/COPYING.txt")],
              "corresponding_source_status": "local_checkout_not_delivered"}
    components.insert(0, colmap)
    bundled = [("LSD", "libcolmap_lsd.a", "AGPL-3.0-or-later"),
               ("PoissonRecon", "libcolmap_poisson_recon.a", "MIT"),
               ("VLFeat", "libcolmap_vlfeat.a", "BSD-2-Clause")]
    for name, archive, license_id in bundled:
        if archive not in link:
            continue
        components.append({"id": name, "name": name, "version": "vendored-at-" + commit,
                           "license_declared": license_id, "linkage": "static", "link_evidence": archive,
                           "source": {"url": "https://github.com/colmap/colmap", "commit": commit,
                                      "path": "src/thirdparty/" + name},
                           "licenses": [copy(source / "src/thirdparty" / name / "LICENSE", Path("licenses/bundled") / name / "LICENSE")],
                           "corresponding_source_status": "local_checkout_not_delivered"})
        if name == "LSD":
            issues.append({"kind": "agpl_statically_linked", "component": name})
    for name, directory, archive, license_id in [("PoseLib", "poselib", "libPoseLib.a", "BSD-3-Clause"),
                                                ("FAISS", "faiss", "libfaiss.a", "MIT")]:
        if archive not in link:
            continue
        override = re.search(r"^FETCHCONTENT_SOURCE_DIR_" + directory.upper() + r":PATH=(.+)$", cache_text, re.M)
        dep_source = Path(override[1]) if override else build / f"_deps/{directory}-src"
        stamp = dep_source.parent / f"{directory}-subbuild/{directory}-populate-prefix/src/{directory}-populate-stamp/{directory}-populate-urlinfo.txt"
        stamp_text = stamp.read_text()
        url = re.search(r"^url\(s\)=(.+)$", stamp_text, re.M)
        checksum = re.search(r"^hash=SHA256=([a-f0-9]{64})$", stamp_text, re.M)
        components.append({"id": name, "name": name, "license_declared": license_id, "linkage": "static",
                           "source": {"url": url[1] if url else None, "sha256": checksum[1] if checksum else None},
                           "link_evidence": archive, "corresponding_source_status": "local_source_tree_not_delivered",
                           "evidence": [copy(stamp, Path("provenance/bundled") / name / stamp.name)],
                           "licenses": [copy(dep_source / "LICENSE", Path("licenses/bundled") / name / "LICENSE")]})
    for name in ["CMakeCache.txt", "build-info.json", "build-environment.txt"]:
        if (build / name).is_file():
            copy(build / name, Path("provenance/build") / name)
    link_path = output / "provenance/build/colmap-final-link.txt"
    link_path.parent.mkdir(parents=True, exist_ok=True)
    link_path.write_text(link)
    for path in [repo_root / "scripts/macos/build-colmap.sh", repo_root / "scripts/macos/colmap-m0-deps.explicit.txt"]:
        copy(path, Path("provenance/build") / path.name)
    if flags.get("CGAL_ENABLED") == "ON":
        for name in ["Advancing_front_surface_reconstruction.h", "Delaunay_triangulation_3.h"]:
            copy(prefix / "include/CGAL" / name, Path("provenance/CGAL") / name)
        issues.append({"kind": "gpl_headers_compiled", "component": "cgal-cpp",
                       "license": "GPL-3.0-or-later OR LicenseRef-Commercial", "commercial_license_evidence": None})
    if any(c["name"] == "libgcc" and any("quadmath" in p for p in c["files"]) for c in components):
        issues.append({"kind": "libquadmath_file_license_needs_source_verification", "component": "libgcc"})
    report = {"schema_version": 1, "scope": "COLMAP actual linked components, including header/static dependencies",
              "release_ready": False, "corresponding_source_delivered": False,
              "closure_files": len(closure), "conda_canonical_files": len(exact),
              "canonical_owner_package_count": len(owned), "build_options": flags,
              "components": components, "alias_only_packages": {k: sorted(v) for k, v in aliases.items() if k not in owned},
              "issues": issues,
              "limitations": ["No source archives downloaded. URL/hash/recipe evidence does not itself fulfill corresponding-source delivery.",
                              "Conda declared licenses are retained verbatim; file-level exceptions require source verification.",
                              "This report covers COLMAP, not the independent FFmpeg engine or Brush/LPIPS.",
                              "System framework dependencies are not copied and are outside this component inventory."]}
    report_path = output / "provenance/audit.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def collect_ffmpeg_licenses(repo_root: Path, output_dir: Path,
                           ffmpeg_build: Path | None = None,
                           ffmpeg_source: Path | None = None,
                           ffmpeg_install: Path | None = None) -> dict:
    """Collect the separate locally built LGPL FFmpeg engine's evidence."""
    repo_root = Path(repo_root).resolve()
    m0 = repo_root / "target/macos-m0"
    build = Path(ffmpeg_build or m0 / "ffmpeg-build")
    source = Path(ffmpeg_source or m0 / "ffmpeg")
    install = Path(ffmpeg_install or m0 / "ffmpeg-install")
    output = Path(output_dir).resolve() / "ffmpeg"
    files = []
    sources = [(p, Path("licenses") / p.name) for p in (install / "share/licenses/ffmpeg").glob("*") if p.is_file()]
    sources += [(build / name, Path("provenance/build") / name) for name in ["build-info.json", "build-environment.txt", "config.h"]]
    sources += [(repo_root / "scripts/macos/build-ffmpeg.sh", Path("provenance/build/build-ffmpeg.sh"))]
    for origin, relative in sources:
        if not origin.is_file():
            raise FileNotFoundError(origin)
        dest = output / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(origin, dest)
        files.append({"path": str(relative), "sha256": sha256(dest), "evidence_origin": str(origin.relative_to(repo_root))})
    info = json.loads((build / "build-info.json").read_text())
    report = {"schema_version": 1, "name": "FFmpeg", "version": info["version"],
              "license_declared": info["license"], "release_ready": False,
              "source": {"url": "https://git.ffmpeg.org/ffmpeg.git", "commit": info["source_commit"],
                         "local_checkout": str(source.relative_to(repo_root))},
              "corresponding_source_status": "local_checkout_not_delivered", "evidence": files,
              "issues": [{"kind": "corresponding_source_not_delivered", "component": "ffmpeg-local"}],
              "notes": ["Independent LGPL engine; do not confuse with COLMAP's Conda GPL FFmpeg dependency.",
                        "Ship exact source, build script and configuration, license notices and a working mechanism for replacing the LGPL shared libraries."]}
    (output / "provenance/audit.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--closure", type=Path, required=True, help="JSON list of original files, or object with files mapping")
    parser.add_argument("--output", type=Path, required=True, help="Pack root; writes colmap/licenses and colmap/provenance")
    parser.add_argument("--colmap-build", type=Path)
    parser.add_argument("--colmap-source", type=Path)
    parser.add_argument("--conda-prefix", type=Path)
    parser.add_argument("--conda-cache", type=Path)
    parser.add_argument("--include-ffmpeg", action="store_true")
    args = parser.parse_args()
    closure = json.loads(args.closure.read_text())
    if isinstance(closure, dict):
        closure = closure["files"]
    report = collect_licenses(args.repo_root, [Path(p) for p in closure], args.output,
                              args.colmap_build, args.colmap_source, args.conda_prefix, args.conda_cache)
    if args.include_ffmpeg:
        collect_ffmpeg_licenses(args.repo_root, args.output)
    print(json.dumps({"components": len(report["components"]), "canonical_owner_package_count": report["canonical_owner_package_count"],
                      "issues": len(report["issues"]), "release_ready": report["release_ready"],
                      "audit": str(args.output / "colmap/provenance/audit.json")}, indent=2))


if __name__ == "__main__":
    main()
