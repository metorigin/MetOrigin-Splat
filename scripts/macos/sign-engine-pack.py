#!/usr/bin/env python3
"""Derive a Developer ID signed engine pack from an explicitly pinned frozen pack.

The source is verified before copying, the copy is verified before signing, and
the source is verified again before publishing a new destination. Existing packs
are never replaced. This does not change license/public-release acceptance.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile

from pack_macos import (run, safe_pack_path, sha256, verify_developer_id_signature,
                        verify_pack, write_json)
from pack_spdx import write_release_status, write_spdx


def check_sha256(value: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        raise ValueError("expected a SHA-256 fingerprint")
    return value.lower()


def reject_symlinks(root: Path) -> None:
    if root.is_symlink():
        raise ValueError("source pack must not be a symlink")
    for path in root.rglob("*"):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise ValueError("source pack contains a symlink or special file: " + str(path))


def validate_source_status(pack: Path, manifest_sha256: str, expected_status_sha256: str) -> dict:
    path = pack.parent / "release-status.json"
    if path.is_symlink() or sha256(path) != expected_status_sha256:
        raise ValueError("source release status does not match the explicitly pinned fingerprint")
    status = json.loads(path.read_text())
    if status.get("schema_version") != 1 or status.get("manifest_sha256") != manifest_sha256:
        raise ValueError("source release status belongs to a different manifest")
    blockers, engines = [], {}
    for engine in sorted(json.loads((pack / "engine-manifest.json").read_text())["engines"]):
        audit = json.loads((pack / engine / "provenance/audit.json").read_text())
        issues = audit.get("issues", [])
        engines[engine] = {"release_ready": audit.get("release_ready", False), "issue_count": len(issues),
                           "audit_path": engine + "/provenance/audit.json"}
        blockers.extend(dict(issue, engine=engine) for issue in issues)
        if not audit.get("release_ready") and not issues:
            blockers.append({"engine": engine, "kind": "redistribution_evidence_review_pending"})
    canonical = lambda values: sorted(json.dumps(value, sort_keys=True) for value in values)
    if (status.get("engines") != engines or canonical(status.get("blockers", [])) != canonical(blockers)
            or status.get("distributable") is not (not blockers)
            or status.get("distribution_status") != ("blocked" if blockers else "evidence-complete")
            or status.get("allowed_use") != ("internal-alpha-validation" if blockers
                                              else "subject-to-app-signing-and-acceptance")):
        raise ValueError("source release status disagrees with manifest-hashed license evidence")
    return status


def file_entries(manifest: dict) -> dict[str, dict]:
    return {entry["path"]: entry for engine in manifest["engines"].values() for entry in engine["files"]}


def assert_original_files(pack: Path, manifest: dict, allowed_changes: set[str] | None = None) -> None:
    allowed_changes = allowed_changes or set()
    entries = file_entries(manifest)
    actual = {path.relative_to(pack).as_posix() for path in pack.rglob("*") if path.is_file()}
    if actual != set(entries) | {"engine-manifest.json"}:
        raise ValueError("file inventory changed during signing")
    for name, entry in entries.items():
        path = safe_pack_path(pack, name)
        if name not in allowed_changes and (sha256(path) != entry["sha256"]
                                            or path.stat().st_size != entry["size_bytes"]):
            raise ValueError("unexpected unsigned file mutation: " + name)


def refresh_signed_provenance(pack: Path, manifest: dict, signed: dict[str, dict]) -> set[str]:
    """Rebind only known final-artifact fields, retaining the original audit rows."""
    changed = set()
    for engine in manifest["engines"]:
        prefix = pack / engine / "provenance/embedded-prefix-rewrites.json"
        if prefix.exists():
            record = json.loads(prefix.read_text())
            for item in record["files"]:
                name = engine + "/" + item["path"]
                if name not in signed or item["final_signed_sha256"] != signed[name]["before_sha256"]:
                    raise ValueError("runtime-prefix audit does not bind the pinned signed input: " + name)
                item["final_signed_sha256"] = signed[name]["after_sha256"]
            write_json(prefix, record)
            changed.add(prefix.relative_to(pack).as_posix())
        relocation = pack / engine / "provenance/relocation-map.json"
        if relocation.exists():
            records = json.loads(relocation.read_text())
            for item in records:
                name = item["packaged_path"]
                if name not in signed or item["packaged_sha256"] != signed[name]["before_sha256"]:
                    raise ValueError("relocation audit does not bind the pinned signed input: " + name)
                item["packaged_sha256"] = signed[name]["after_sha256"]
            write_json(relocation, records)
            changed.add(relocation.relative_to(pack).as_posix())
    return changed


def write_signed_sbom(pack: Path, engine: str, version: str, signed: dict[str, dict],
                      source_manifest_sha256: str) -> None:
    # Regenerate the license/source inventory from its unchanged audit and add an
    # explicit projection of the actual signed runtime bytes, not build inputs.
    write_spdx(pack / engine, engine, version)
    path = pack / engine / "provenance/sbom.spdx.json"
    sbom = json.loads(path.read_text())
    sbom["files"] = []
    for index, (name, item) in enumerate(sorted(signed.items())):
        if not name.startswith(engine + "/"):
            continue
        identifier = f"SPDXRef-SignedRuntime-{index}"
        sbom["files"].append({"SPDXID": identifier, "fileName": "./" + name[len(engine) + 1:],
                              "fileTypes": ["BINARY"],
                              "checksums": [{"algorithm": "SHA256", "checksumValue": item["after_sha256"]}],
                              "licenseConcluded": "NOASSERTION", "copyrightText": "NOASSERTION"})
        sbom["relationships"].append({"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES",
                                       "relatedSpdxElement": identifier})
    identity = hashlib.sha256(json.dumps(sbom["files"], sort_keys=True).encode()).hexdigest()
    sbom["documentNamespace"] += "-signed-" + identity
    sbom["documentComment"] += (" Developer ID signed runtime projection derived from source engine manifest "
                                + source_manifest_sha256 + "; signing provenance is adjacent.")
    write_json(path, sbom)


def derive_signed_pack(source_pack: Path, output: Path, expected_source_manifest_sha256: str,
                       expected_source_release_status_sha256: str, identity: str, team_id: str) -> dict:
    expected_source_manifest_sha256 = check_sha256(expected_source_manifest_sha256)
    expected_source_release_status_sha256 = check_sha256(expected_source_release_status_sha256)
    if not re.fullmatch(r"[0-9A-Fa-f]{40}", identity):
        raise ValueError("identity must be the Developer ID Application certificate SHA-1 fingerprint")
    if not re.fullmatch(r"[A-Z0-9]{10}", team_id):
        raise ValueError("expected a ten-character Apple Developer Team ID")
    identity = identity.upper()
    reject_symlinks(source_pack)
    source_pack, output = source_pack.resolve(strict=True), output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("output already exists; choose a new directory")
    if output.is_relative_to(source_pack) or source_pack.is_relative_to(output):
        raise ValueError("output must not overlap the source pack")
    # Resolve the parent before creating it so a symlink cannot turn a distinct
    # spelling of the source directory into the publication destination.
    output = output.resolve()
    if output.is_relative_to(source_pack) or source_pack.is_relative_to(output):
        raise ValueError("output must not overlap the source pack")
    if sha256(source_pack / "engine-manifest.json") != expected_source_manifest_sha256:
        raise ValueError("source manifest does not match the explicitly pinned fingerprint")
    source_report = verify_pack(source_pack)
    source_manifest = json.loads((source_pack / "engine-manifest.json").read_text())
    source_status = validate_source_status(source_pack, expected_source_manifest_sha256,
                                           expected_source_release_status_sha256)
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".developer-id-engine-staging-", dir=output.parent))
    pack = stage / "engines"
    # Failed staging directories are deliberately retained for diagnosis. They
    # are never substituted for a completed output directory.
    shutil.copytree(source_pack, pack, copy_function=shutil.copy2)
    copied_report = verify_pack(pack)
    if copied_report["manifest_sha256"] != expected_source_manifest_sha256:
        raise ValueError("copied pack does not match the pinned source")
    for name in file_entries(source_manifest):
        if (pack / name).stat().st_ino == (source_pack / name).stat().st_ino:
            raise ValueError("copy retained an inode from the immutable source pack")
    source_evidence = stage / "source-evidence"
    source_evidence.mkdir()
    shutil.copy2(source_pack / "engine-manifest.json", source_evidence / "engine-manifest.json")
    shutil.copy2(source_pack.parent / "release-status.json", source_evidence / "release-status.json")
    executables = {name for engine in source_manifest["engines"].values() for name in engine["executables"].values()}
    macho_names = {item["path"] for item in source_report["mach_o"]}
    if not executables.issubset(macho_names):
        raise ValueError("source manifest declares a non-Mach-O executable")
    signed = {}
    for name in sorted(macho_names, key=lambda name: (name in executables, name)):
        path = safe_pack_path(pack, name)
        before = sha256(path)
        if before != file_entries(source_manifest)[name]["sha256"]:
            raise ValueError("copied binary changed before signing: " + name)
        command = ["/usr/bin/codesign", "--force", "--sign", identity, "--timestamp"]
        if name in executables:
            command += ["--options", "runtime"]
        run([*command, path], timeout=300)
        verification = verify_developer_id_signature(path, team_id, name in executables, identity)
        signed[name] = {"before_sha256": before, "after_sha256": sha256(path),
                        "before_size_bytes": file_entries(source_manifest)[name]["size_bytes"],
                        "after_size_bytes": path.stat().st_size, "signature": verification}
    assert_original_files(pack, source_manifest, set(signed))
    refresh_signed_provenance(pack, source_manifest, signed)
    # Store the exact original manifest/audits outside the derived pack. The
    # signing record below binds each changed file to that already verified input.
    old_entries = file_entries(source_manifest)
    metadata_before = {name: entry["sha256"] for name, entry in old_entries.items()
                       if "/provenance/" in name and (name.endswith("embedded-prefix-rewrites.json")
                                                      or name.endswith("relocation-map.json")
                                                      or name.endswith("sbom.spdx.json"))}
    for engine, record in source_manifest["engines"].items():
        for name in metadata_before:
            if name.startswith(engine + "/"):
                destination = source_evidence / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_pack / name, destination)
                # Ship the original audit alongside its derived current view,
                # rather than relying on an external build directory surviving.
                embedded = pack / engine / "provenance/developer-id-source" / Path(name).name
                embedded.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_pack / name, embedded)
        evidence = {"schema_version": 1, "scope": "Developer ID signature derivation; no license or application acceptance granted",
                    "source_manifest_sha256": expected_source_manifest_sha256,
                    "source_release_status_sha256": expected_source_release_status_sha256,
                    "team_id": team_id, "identity_sha1": identity,
                    "signed_files": {name: item for name, item in signed.items() if name.startswith(engine + "/")},
                    "source_provenance_sha256": {name: value for name, value in metadata_before.items()
                                                  if name.startswith(engine + "/")}}
        write_json(pack / engine / "provenance/developer-id-signing.json", evidence)
        recipes = pack / engine / "provenance/developer-id-packaging"
        recipes.mkdir(exist_ok=False)
        for recipe in (Path(__file__), Path(__file__).with_name("pack_macos.py"), Path(__file__).with_name("pack_spdx.py")):
            shutil.copy2(recipe, recipes / recipe.name)
        write_signed_sbom(pack, engine, record["version"], signed, expected_source_manifest_sha256)
    manifest = json.loads(json.dumps(source_manifest))
    for engine, record in manifest["engines"].items():
        record["files"] = [{"path": path.relative_to(pack).as_posix(), "sha256": sha256(path),
                             "size_bytes": path.stat().st_size}
                            for path in sorted((pack / engine).rglob("*")) if path.is_file()]
        record["license_files"] = [entry["path"] for entry in record["files"]
                                    if entry["path"].startswith(engine + "/licenses/")]
    write_json(pack / "engine-manifest.json", manifest)
    report = verify_pack(pack)
    release_status = write_release_status(pack)
    if (release_status["distributable"] != source_status["distributable"]
            or release_status["engines"] != source_status["engines"]
            or sorted(json.dumps(v, sort_keys=True) for v in release_status["blockers"])
            != sorted(json.dumps(v, sort_keys=True) for v in source_status["blockers"])):
        raise ValueError("signing changed the source pack's license acceptance")
    # Full final source verification, not just a check of its manifest, catches
    # modification of immutable input bytes during codesign/network execution.
    reject_symlinks(source_pack)
    final_source_report = verify_pack(source_pack)
    if final_source_report["manifest_sha256"] != expected_source_manifest_sha256:
        raise ValueError("source manifest changed during signing")
    validate_source_status(source_pack, expected_source_manifest_sha256, expected_source_release_status_sha256)
    evidence = {"schema_version": 1, "scope": "Signed engine-pack derivation; not notarization or clean-machine acceptance",
                "created_at": datetime.now(timezone.utc).isoformat(), "source_pack": str(source_pack),
                "source_manifest_sha256": expected_source_manifest_sha256,
                "source_release_status_sha256": expected_source_release_status_sha256,
                "manifest_sha256": report["manifest_sha256"], "release_status_sha256": sha256(stage / "release-status.json"),
                "team_id": team_id, "identity_sha1": identity, "signed_macho_count": len(signed),
                "source_preserved_and_reverified": True, "signed_files": signed}
    write_json(stage / "engine-signing.json", evidence)
    write_json(stage / "engines-verification.json", report)
    if output.exists():
        raise ValueError("output appeared during signing; refusing to replace it")
    stage.rename(output)
    return {"distribution": str(output), "pack": str(output / "engines"),
            "manifest_sha256": report["manifest_sha256"],
            "release_status_sha256": evidence["release_status_sha256"],
            "signing_report": str(output / "engine-signing.json"), "signed_macho_count": len(signed)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-pack", type=Path, required=True)
    parser.add_argument("--expected-source-manifest-sha256", required=True)
    parser.add_argument("--expected-source-release-status-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True, help="New distribution directory containing engines and release-status.json")
    parser.add_argument("--identity", required=True, help="Developer ID Application certificate SHA-1 fingerprint")
    parser.add_argument("--team-id", required=True)
    args = parser.parse_args()
    print(json.dumps(derive_signed_pack(args.source_pack, args.output, args.expected_source_manifest_sha256,
                                       args.expected_source_release_status_sha256, args.identity, args.team_id), indent=2))


if __name__ == "__main__":
    main()
