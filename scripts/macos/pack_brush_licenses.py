#!/usr/bin/env python3
"""Archive the actual native Brush CLI Cargo dependency graph and local sources.

Uses the locked normal/build target tree, not every workspace lockfile entry.
Build dependencies are labeled graph inputs; no claim of symbol-level linkage.
"""

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

from pack_macos import run, safe_pack_path, sha256, write_json



SOURCE_SUFFIXES = {".rs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".m", ".mm",
                   ".py", ".pyc", ".js", ".jsx", ".ts", ".tsx", ".json", ".toml",
                   ".yaml", ".yml", ".xml", ".svg", ".png", ".jpg"}


def is_notice_file(path):
    # COPYING is a legal filename; copying.rs may implement NSCopying and is
    # not a notice. Never count ordinary program/config/image files as texts.
    return path.is_file() and path.suffix.lower() not in SOURCE_SUFFIXES

def lock_packages(path):
    records = {}
    for block in re.split(r"^\[\[package\]\]\s*$", path.read_text(), flags=re.M)[1:]:
        record = dict(re.findall(r'^([a-z_]+) = "([^"]*)"\s*$', block, re.M))
        key = (record["name"], record["version"])
        if key in records:
            raise ValueError(f"ambiguous lockfile package: {key}")
        records[key] = record
    return records


def package_name(path):
    text = path.read_text()
    section = re.search(r"^\[package\]\s*$(.*?)(?=^\[|\Z)", text, re.M | re.S)
    if section:
        match = re.search(r'^name\s*=\s*"([^"]+)"', section[1], re.M)
        return match[1] if match else None
    return None


def target_packages(text):
    active = {}
    for line in text.splitlines():
        match = re.search(r"([A-Za-z0-9_-]+) v([0-9][^\s]+)\s*(.*)$", line)
        if not match:
            continue
        suffix = match[3].replace("(*)", "").strip()
        # Source paths and proc-macro annotations precede the expression; SPDX
        # parenthesized expressions must not be stripped as though they were paths.
        while re.match(r"^\((?:/|https?://|proc-macro\b)", suffix):
            suffix = suffix[suffix.index(")") + 1:].strip()
        active[(match[1], match[2])] = suffix
    return active


def collect(source, tree, cargo_home, output):
    destination = output / "brush"
    if destination.exists():
        raise ValueError("license evidence output already exists; preserve it and choose a new path")
    provenance = destination / "provenance/cargo"
    provenance.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(tree, provenance / "target-tree.txt")
    packages = lock_packages(source / "Cargo.lock")
    active = target_packages(tree.read_text())
    if not active or ("brush-cli", "1.0.0") not in active:
        raise ValueError("not a Brush CLI target graph")
    git_index = {}
    for manifest in (cargo_home / "git/checkouts").glob("*/*/**/Cargo.toml"):
        name = package_name(manifest)
        if name:
            git_index.setdefault(name, []).append(manifest.parent)
    workspace_index = {package_name(p): p.parent for p in source.glob("**/Cargo.toml")}
    components, issues, git_archives = [], [], {}
    for (name, version), license_id in sorted(active.items()):
        package = packages[(name, version)]
        origin = package.get("source", "workspace")
        identifier = name + "-" + version
        archive = None
        if origin.startswith("registry+"):
            roots = list((cargo_home / "registry/src").glob("*/" + identifier))
            archives = list((cargo_home / "registry/cache").glob("*/" + identifier + ".crate"))
            if len(roots) != 1 or len(archives) != 1 or sha256(archives[0]) != package["checksum"]:
                raise ValueError(f"missing/ambiguous/unverified registry source: {identifier}")
            package_root = roots[0]
            archive = provenance / "sources" / (identifier + ".crate")
            archive.parent.mkdir(exist_ok=True)
            shutil.copyfile(archives[0], archive)
        elif origin.startswith("git+"):
            revision = origin.rsplit("#", 1)[1]
            roots = []
            for candidate in git_index.get(name, []):
                if run(["/usr/bin/git", "-C", candidate, "rev-parse", "HEAD"]).strip() == revision:
                    roots.append(candidate)
            if len(roots) != 1:
                raise ValueError(f"missing/ambiguous git source: {identifier}: {roots}")
            package_root = roots[0]
            repo = Path(run(["/usr/bin/git", "-C", package_root, "rev-parse", "--show-toplevel"]).strip())
            archive = provenance / "sources" / (revision + ".tar")
            archive.parent.mkdir(exist_ok=True)
            if revision not in git_archives:
                with archive.open("wb") as output_file:
                    subprocess.run(["/usr/bin/git", "-C", str(repo), "archive", "--format=tar", revision],
                                   check=True, stdout=output_file)
                git_archives[revision] = str(archive)
        elif origin == "workspace":
            package_root = workspace_index[name]
        else:
            raise ValueError("unknown Cargo source: " + origin)
        license_paths = []
        for candidate in package_root.rglob("*"):
            if is_notice_file(candidate) and (re.match(r"^(LICEN[CS]E|COPYING|NOTICE|COPYRIGHT)(?:[._-]|$)", candidate.name, re.I)
                                        or "LICENSES" in candidate.relative_to(package_root).parts):
                license_paths.append(candidate)
        if origin == "workspace" and not license_paths:
            license_paths = [source / "LICENSE"]
        if origin.startswith("git+"):
            top = Path(run(["/usr/bin/git", "-C", package_root, "rev-parse", "--show-toplevel"]).strip())
            license_paths += [p for p in top.iterdir() if is_notice_file(p) and re.match(r"^(LICENSE|NOTICE|COPYING)", p.name, re.I)]
        copied = []
        for index, candidate in enumerate(sorted(set(license_paths))):
            target = destination / "licenses/cargo" / identifier / (str(index) + "-" + candidate.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(candidate, target)
            copied.append({"path": str(target.relative_to(destination)), "sha256": sha256(target),
                           "source_path": str(candidate)})
        if not copied:
            issues.append({"kind": "license_text_missing", "component": identifier})
        if not license_id:
            issues.append({"kind": "license_declaration_missing", "component": identifier})
        manifest = provenance / "manifests" / (identifier + ".toml")
        manifest.parent.mkdir(exist_ok=True)
        shutil.copyfile(package_root / "Cargo.toml", manifest)
        component = {"id": identifier, "name": name, "version": version, "source": origin,
                     "license_declared": license_id, "licenses": copied,
                     "manifest": str(manifest.relative_to(destination)), "manifest_sha256": sha256(manifest)}
        if archive:
            component["source_archive"] = {"path": str(archive.relative_to(destination)), "sha256": sha256(archive)}
        else:
            component["source_archive"] = {"path": "provenance/source.tar", "scope": "patched workspace source, generated by pack-engines.py"}
        components.append(component)
    report = {"schema_version": 1, "scope": "cargo tree --locked -p brush-cli --target aarch64-apple-darwin -e normal,build",
              "target_graph_sha256": sha256(tree), "cargo_lock_sha256": sha256(source / "Cargo.lock"),
              "components": components, "issues": issues, "release_ready": False,
              "limitations": ["Cargo graph includes native normal and build dependencies; it is not a symbol-level inventory.",
                              "Rust standard library/compiler runtimes and platform SDKs are outside Cargo.lock; retain toolchain build provenance.",
                              "The source archive intentionally excludes LPIPS weights and two unprovenanced test images; default Alpha build disables the LPIPS feature."]}
    write_json(destination / "provenance/audit.json", report)
    return report



def reuse_verified_notices(previous_pack, expected_manifest_sha256, evidence):
    """Reuse exact upstream texts only for identical checksum-verified packages."""
    manifest_path = previous_pack / "engine-manifest.json"
    if sha256(manifest_path) != expected_manifest_sha256:
        raise ValueError("previous frozen manifest identity changed")
    manifest = json.loads(manifest_path.read_text())
    declared = {entry["path"]: entry for entry in manifest["engines"]["brush"]["files"]}

    def checked_previous(relative):
        path = safe_pack_path(previous_pack, relative)
        entry = declared[relative]
        if sha256(path) != entry["sha256"] or path.stat().st_size != entry["size_bytes"]:
            raise ValueError("previous evidence differs from frozen manifest: " + relative)
        return path

    previous = json.loads(checked_previous("brush/provenance/audit.json").read_text())
    previous_components = {component["id"]: component for component in previous["components"]}
    destination = evidence / "brush"
    audit_path = destination / "provenance/audit.json"
    audit = json.loads(audit_path.read_text())
    reused = []
    for component in audit["components"]:
        if component["licenses"] or component["id"] not in previous_components:
            continue
        old = previous_components[component["id"]]
        identity = ("source", "manifest_sha256", "license_declared")
        if any(component.get(field) != old.get(field) for field in identity):
            raise ValueError("cannot reuse notices for changed package: " + component["id"])
        digest = component.get("source_archive", {}).get("sha256")
        if not digest or digest != old.get("source_archive", {}).get("sha256"):
            raise ValueError("cannot reuse notices without identical source archive: " + component["id"])
        valid_notices = [notice for notice in old["licenses"]
                         if is_notice_file(checked_previous("brush/" + notice["path"]))]
        for key, expected in (("manifest", component["manifest_sha256"]),
                              ("source_archive", digest)):
            relative = component[key]["path"] if key == "source_archive" else component[key]
            if sha256(safe_pack_path(destination, relative)) != expected:
                raise ValueError("current package evidence changed: " + component["id"])
        if not valid_notices and component["source"].startswith("registry+"):
            # A sibling crate from an immutable workspace commit may carry the
            # same root notice. The checksum-verified published crate proves
            # the repository/commit; never infer it from a branch or version.
            cargo_manifest = safe_pack_path(destination, component["manifest"]).read_text()
            repository = re.search(r'^repository = "https://github.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/?"', cargo_manifest, re.M)
            with tarfile.open(safe_pack_path(destination, component["source_archive"]["path"])) as archive:
                vcs_members = [member for member in archive.getmembers()
                               if member.isfile() and member.name.endswith("/.cargo_vcs_info.json")
                               and len(Path(member.name).parts) == 2]
                vcs = json.load(archive.extractfile(vcs_members[0])) if len(vcs_members) == 1 else {}
            revision = vcs.get("git", {}).get("sha1", "")
            if repository and re.fullmatch(r"[0-9a-f]{40}", revision):
                prefix = "https://raw.githubusercontent.com/" + repository[1].removesuffix(".git") + "/" + revision + "/"
                seen = set()
                for sibling in previous["components"]:
                    for notice in sibling["licenses"]:
                        # Root notice only: a member's subdirectory license need
                        # not cover another member of the same repository.
                        url = notice.get("url", "")
                        suffix = url[len(prefix):] if url.startswith(prefix) else ""
                        if (suffix and "/" not in suffix and notice["path"] not in seen
                                and is_notice_file(checked_previous("brush/" + notice["path"]))):
                            valid_notices.append(dict(notice, published_package_vcs_revision=revision,
                                                      published_source_archive_sha256=digest))
                            seen.add(notice["path"])
        if not valid_notices:
            continue
        for notice in valid_notices:
            source = checked_previous("brush/" + notice["path"])
            if sha256(source) != notice["sha256"]:
                raise ValueError("old notice audit digest mismatch")
            target = destination / notice["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            component["licenses"].append(dict(notice, reused_from_manifest_sha256=expected_manifest_sha256))
        if "license_selected" in old:
            component["license_selected"] = old["license_selected"]
        reused.append(component["id"])
    audit["issues"] = [issue for issue in audit["issues"]
                       if not (issue["kind"] == "license_text_missing" and issue["component"] in reused)]
    audit["notice_reuse"] = {"previous_manifest_sha256": expected_manifest_sha256,
                            "identical_source_components": sorted(component["id"] for component in audit["components"]
                                if any(notice.get("reused_from_manifest_sha256") == expected_manifest_sha256
                                       for notice in component["licenses"]))}
    write_json(audit_path, audit)
    return audit

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--tree", type=Path, required=True)
    parser.add_argument("--cargo-home", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-notices-from", type=Path)
    parser.add_argument("--previous-manifest-sha256")
    args = parser.parse_args()
    if bool(args.reuse_notices_from) != bool(args.previous_manifest_sha256):
        parser.error("notice reuse requires both the previous pack and its frozen manifest SHA-256")
    report = collect(args.source.resolve(), args.tree.resolve(), args.cargo_home.resolve(), args.output.resolve())
    if args.reuse_notices_from:
        report = reuse_verified_notices(args.reuse_notices_from.resolve(), args.previous_manifest_sha256, args.output.resolve())
    print(json.dumps({"components": len(report["components"]), "issues": report["issues"]}, indent=2))


if __name__ == "__main__":
    main()
