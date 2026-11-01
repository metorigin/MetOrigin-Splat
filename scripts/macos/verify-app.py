#!/usr/bin/env python3
"""Verify final app signatures, frozen engine hashes and the exact app in a DMG.

Developer ID and stapled notarization checks are explicit options. Neither is
application acceptance, license clearance or a clean-machine run.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import tempfile

import pack_macos
from pack_macos import MACHO_MAGICS, SYSTEM_PREFIXES, inspect_macho, run, safe_pack_path, sha256, verify_pack, version_tuple, write_json
from webp_evidence import verify_webp_evidence


ENGINES = {"ffmpeg", "colmap", "brush"}
NOTARIZATION_CONTAINER = "stapled-dmg-with-developer-id-application"
NOTARIZATION_STRICT = "stapled-application-and-dmg"


def verify_release_status(status: dict, manifest_sha256: str, internal_alpha: bool) -> None:
    fields = {"schema_version", "manifest_sha256", "distributable", "distribution_status",
              "allowed_use", "engines", "blockers", "acceptance_scope"}
    if not isinstance(status, dict) or set(status) != fields or type(status["schema_version"]) is not int or status["schema_version"] != 1:
        raise ValueError("unsupported or malformed release status schema")
    if (not isinstance(status["manifest_sha256"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", status["manifest_sha256"])
            or status["manifest_sha256"] != manifest_sha256):
        raise ValueError("release status belongs to a different manifest")
    if (type(status["distributable"]) is not bool
            or not isinstance(status["acceptance_scope"], str) or not status["acceptance_scope"].strip()
            or not isinstance(status["engines"], dict) or set(status["engines"]) != ENGINES
            or not isinstance(status["blockers"], list)):
        raise ValueError("malformed distribution approval evidence")
    for engine, record in status["engines"].items():
        if (not isinstance(record, dict) or set(record) != {"release_ready", "issue_count", "audit_path"}
                or type(record["release_ready"]) is not bool or type(record["issue_count"]) is not int
                or record["issue_count"] < 0 or record["audit_path"] != engine + "/provenance/audit.json"
                or (record["release_ready"] and record["issue_count"] != 0)):
            raise ValueError("malformed engine approval evidence: " + engine)
    for blocker in status["blockers"]:
        if (not isinstance(blocker, dict) or blocker.get("engine") not in ENGINES
                or not isinstance(blocker.get("kind"), str) or not blocker["kind"].strip()
                or ("component" in blocker and not isinstance(blocker["component"], str))):
            raise ValueError("malformed distribution blocker")
    ready = all(record["release_ready"] for record in status["engines"].values())
    expected_use = "subject-to-app-signing-and-acceptance" if ready else "internal-alpha-validation"
    if (status["distributable"] != ready or bool(status["blockers"]) == ready
            or status["distribution_status"] != ("evidence-complete" if ready else "blocked")
            or status["allowed_use"] != expected_use):
        raise ValueError("inconsistent distribution approval evidence")
    if not ready and not internal_alpha:
        raise ValueError("unresolved distribution requirements; only explicit --internal-alpha is allowed")


def critical_path(app: Path, relative: str) -> Path:
    """Critical runtime/evidence paths must physically live in this bundle."""
    path = app
    for component in Path(relative).parts:
        path = path / component
        if path.is_symlink():
            raise ValueError("critical bundle path is a symlink: " + str(path))
    path.resolve(strict=True).relative_to(app)
    return path


def bundle_inventory(app: Path) -> dict:
    """Hash regular files, permissions and internal symlinks without following links."""
    if app.is_symlink() or not app.is_dir():
        raise ValueError("application must be a physical bundle directory")
    app = app.resolve(strict=True)
    inventory = {}
    for directory, dirs, files in os.walk(app, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(directory) / name
            relative = path.relative_to(app).as_posix()
            mode = path.lstat().st_mode
            entry = {"mode": stat.S_IMODE(mode)}
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                if Path(target).is_absolute() or not path.resolve(strict=True).is_relative_to(app):
                    raise ValueError("bundle symlink escapes application: " + relative)
                entry.update(type="symlink", target=target)
            elif stat.S_ISDIR(mode):
                entry.update(type="directory")
            elif stat.S_ISREG(mode):
                entry.update(type="file", size_bytes=path.stat().st_size, sha256=sha256(path))
            else:
                raise ValueError("unsupported special file in application: " + relative)
            inventory[relative] = entry
    return inventory


def inventory_sha256(inventory: dict) -> str:
    return hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_app_report_matches(report: dict, expected: dict) -> None:
    """Bind subsequent packaging to the originally accepted signed app bytes."""
    for field in ("application_sha256", "bundle_inventory_sha256"):
        digest = expected.get(field) if isinstance(expected, dict) else None
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("invalid expected application report: " + field)
        if report.get(field) != digest:
            raise ValueError("application differs from initial verification: " + field)
    if report.get("frontend_input_evidence") != expected.get("frontend_input_evidence"):
        raise ValueError("frontend input evidence differs from initial verification")
    if report.get("developer_id_verification") != expected.get("developer_id_verification"):
        raise ValueError("Developer ID evidence differs from initial verification")
    if expected.get("notarization_verified") and not report.get("notarization_verified"):
        raise ValueError("notarization evidence cannot be omitted from subsequent verification")


def verify_code_report_matches(report: dict, expected: dict) -> None:
    """Bind pre/post-staple code identity after a fresh, complete verification.

    This is not a replacement for bundle verification and does not permit any
    resource changes. Each app still passes the complete seal, manifest, license
    and inventory checks before its report can reach this comparison. A fresh
    final inventory accounts for the legitimately added notarization ticket.
    """
    fields = ("application_sha256", "engine_manifest_sha256", "release_status_sha256",
              "application_license_evidence", "frontend_input_evidence", "developer_id_verification")
    def digest(value):
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None
    def text(value):
        return isinstance(value, str) and bool(value.strip())
    for label, candidate in (("current", report), ("expected", expected)):
        def invalid(field):
            raise ValueError("invalid " + label + " code continuity report: " + field)
        if not isinstance(candidate, dict) or type(candidate.get("schema_version")) is not int or candidate["schema_version"] != 1:
            invalid("schema_version")
        for field in fields[:3]:
            if not digest(candidate.get(field)):
                invalid(field)
        license_evidence = candidate.get("application_license_evidence")
        if (not isinstance(license_evidence, dict) or not digest(license_evidence.get("manifest_sha256"))
                or type(license_evidence.get("file_count")) is not int or license_evidence["file_count"] < 1
                or type(license_evidence.get("release_ready")) is not bool
                or not isinstance(license_evidence.get("issues"), list)
                or license_evidence["release_ready"] == bool(license_evidence["issues"])
                or any(not isinstance(issue, dict) or not text(issue.get("id")) or not text(issue.get("detail"))
                       for issue in license_evidence["issues"])):
            invalid("application_license_evidence")
        frontend = candidate.get("frontend_input_evidence")
        if (not isinstance(frontend, dict) or not digest(frontend.get("report_sha256"))
                or frontend.get("dist_verified") is not True or not text(frontend.get("scope"))
                or not isinstance(frontend.get("input_identity"), dict)):
            invalid("frontend_input_evidence")
        identity = frontend["input_identity"]
        overlay = identity.get("webp_overlay")
        if (not digest(identity.get("signature")) or not digest(identity.get("build_json_sha256"))
                or not isinstance(identity.get("assets"), list) or not identity["assets"]
                or not isinstance(overlay, dict) or not text(overlay.get("id"))
                or not digest(overlay.get("manifest_sha256")) or not digest(overlay.get("build_evidence_sha256"))):
            invalid("frontend_input_evidence.input_identity")
        signed = candidate.get("developer_id_verification")
        if (not isinstance(signed, dict) or not isinstance(signed.get("team_id"), str)
                or not re.fullmatch(r"[A-Z0-9]{10}", signed["team_id"])
                or "expected_identity_sha1" not in signed or not text(signed.get("scope"))):
            invalid("developer_id_verification")
        fingerprint = signed["expected_identity_sha1"]
        if fingerprint is not None and (not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9A-F]{40}", fingerprint)):
            invalid("developer_id_verification.expected_identity_sha1")
        def valid_signature(evidence, require_runtime=False):
            return (isinstance(evidence, dict) and evidence.get("team_id") == signed["team_id"]
                    and evidence.get("requirement_verified") is True
                    and text(evidence.get("timestamp")) and evidence["timestamp"].strip().lower() not in {"none", "not set"}
                    and type(evidence.get("hardened_runtime")) is bool
                    and (not require_runtime or evidence["hardened_runtime"])
                    and "identity_sha1" in evidence and evidence["identity_sha1"] == fingerprint
                    and isinstance(evidence.get("authorities"), list) and bool(evidence["authorities"])
                    and all(text(authority) for authority in evidence["authorities"])
                    and evidence["authorities"][0].startswith("Developer ID Application: "))
        nested = signed.get("nested_code")
        if (not valid_signature(signed.get("application"), True)
                or not isinstance(nested, list) or not nested
                or type(signed.get("nested_code_count")) is not int or signed["nested_code_count"] != len(nested)):
            invalid("developer_id_verification.code_signatures")
        paths = set()
        for entry in nested:
            if not valid_signature(entry) or not text(entry.get("path")):
                invalid("developer_id_verification.nested_code")
            path = entry["path"]
            if (not path.startswith("Contents/") or "\\" in path or ".." in Path(path).parts
                    or Path(path).as_posix() != path or path in paths):
                invalid("developer_id_verification.nested_code.path")
            paths.add(path)
    for field in fields:
        if report[field] != expected[field]:
            raise ValueError("code/signature identity differs from pre-notarization verification: " + field)


def validate_signing_options(team_id: str = None, identity: str = None,
                             require_notarized: bool = False) -> None:
    if team_id is not None and not re.fullmatch(r"[A-Z0-9]{10}", team_id):
        raise ValueError("expected Team ID must contain ten uppercase letters or digits")
    if identity is not None and not re.fullmatch(r"[0-9a-fA-F]{40}", identity):
        raise ValueError("expected signing identity must be a certificate SHA-1 fingerprint")
    if not team_id and (identity is not None or require_notarized):
        raise ValueError("Developer ID identity and notarization checks require --expected-team-id")


def verify_bundle_developer_id(app: Path, executable: Path, engines: Path,
                               inventory: dict, team_id: str, identity: str = None) -> dict:
    """Verify every physical code file, in addition to the outer resource seal.

    Manifest executable entries are included explicitly; scanning every regular
    bundle file also finds dylibs, frameworks and code outside the engine pack.
    This only reads signed bytes and never re-signs or rewrites a manifest.
    """
    manifest = json.loads((engines / "engine-manifest.json").read_text())
    executable_paths = {executable}
    for engine in manifest["engines"].values():
        executable_paths.update(safe_pack_path(engines, relative)
                                for relative in engine["executables"].values())
    code_paths = set(executable_paths)
    for relative, entry in inventory.items():
        if entry["type"] != "file":
            continue
        path = app / relative
        with path.open("rb") as file:
            is_macho = file.read(4) in MACHO_MAGICS
        if is_macho or path.suffix.lower() == ".dylib":
            code_paths.add(path)
    application = pack_macos.verify_developer_id_signature(
        app, team_id, require_runtime=True, expected_identity=identity)
    nested = []
    for path in sorted(code_paths - {executable}):
        evidence = pack_macos.verify_developer_id_signature(
            path, team_id, require_runtime=path in executable_paths, expected_identity=identity)
        nested.append({"path": path.relative_to(app).as_posix(), **evidence})
    return {"team_id": team_id, "expected_identity_sha1": identity.upper() if identity else None,
            "application": application, "nested_code": nested,
            "nested_code_count": len(nested),
            "scope": "Apple Developer ID Application chain, Team ID and secure timestamps; app and engine executable Hardened Runtime. No signing mutation."}


def run_assessment(args: list) -> dict:
    """Capture stderr as evidence; stapler/spctl commonly report there."""
    command = [str(value) for value in args]
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired as error:
        raise ValueError("notarization assessment timed out: " + command[0]) from error
    evidence = {"command": command, "exit_code": result.returncode,
                "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}
    if result.returncode:
        raise ValueError("notarization assessment failed: " + json.dumps(evidence, ensure_ascii=False))
    return evidence


def verify_notarization(path: Path, kind: str) -> dict:
    if kind not in {"app", "dmg"}:
        raise ValueError("unsupported notarization artifact kind")
    stapler = run_assessment(["/usr/bin/xcrun", "stapler", "validate", "-v", path])
    assessment = ["/usr/sbin/spctl", "--assess", "--type", "execute" if kind == "app" else "open"]
    if kind == "dmg":
        assessment += ["--context", "context:primary-signature"]
    gatekeeper = run_assessment(assessment + ["--verbose=4", path])
    output = gatekeeper["stdout"] + "\n" + gatekeeper["stderr"]
    # A successful process exit alone is insufficient when assessment policies
    # are disabled or a local rule accepts an otherwise unnotarized artifact.
    if (not re.search(r"^source=Notarized Developer ID\s*$", output, re.M)
            or not re.search(r": accepted\s*$", output, re.M)):
        raise ValueError("Gatekeeper did not identify an accepted Notarized Developer ID artifact")
    return {"stapled_ticket_validated": True, "gatekeeper_accepted": True,
            "stapler": stapler, "gatekeeper": gatekeeper,
            "scope": "Stapled ticket and current-host Gatekeeper assessment; not clean-host or public-release acceptance."}



def verify_app_license_evidence(root: Path, internal_alpha: bool = False,
                                expected_manifest_sha256: str = None) -> dict:
    if root.is_symlink() or not root.is_dir():
        raise ValueError("application license evidence must be a physical directory")
    root = root.resolve(strict=True)
    manifest_path = safe_pack_path(root, "manifest.json")
    digest = sha256(manifest_path)
    if expected_manifest_sha256 and digest != expected_manifest_sha256:
        raise ValueError("application license evidence differs from selected build inputs")
    manifest = json.loads(manifest_path.read_text())
    if (set(manifest) != {"schema_version", "platform", "files"}
            or type(manifest["schema_version"]) is not int or manifest["schema_version"] != 1
            or manifest["platform"] != "macos-arm64" or not isinstance(manifest["files"], list)):
        raise ValueError("invalid application license manifest")
    declared = set()
    for entry in manifest["files"]:
        if (not isinstance(entry, dict) or set(entry) != {"path", "sha256", "size_bytes"}
                or not isinstance(entry["path"], str) or entry["path"] == "manifest.json"
                or entry["path"].casefold() in {name.casefold() for name in declared}
                or type(entry["size_bytes"]) is not int or entry["size_bytes"] < 0
                or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])):
            raise ValueError("invalid application license manifest entry")
        path = safe_pack_path(root, entry["path"])
        if not path.is_file() or path.stat().st_size != entry["size_bytes"] or sha256(path) != entry["sha256"]:
            raise ValueError("application license file size/hash mismatch: " + entry["path"])
        declared.add(entry["path"])
    actual = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError("application license evidence cannot contain symlinks")
        if path.is_file() and path != manifest_path:
            actual.add(path.relative_to(root).as_posix())
    required = {"SBOM.cdx.json", "dependency-license-index.json", "release-readiness.json"}
    if actual != declared or not required.issubset(declared):
        raise ValueError("application license evidence has missing or undeclared files")
    readiness = json.loads((root / "release-readiness.json").read_text())
    if (type(readiness.get("schema_version")) is not int or readiness["schema_version"] != 1
            or readiness.get("platform") != "macos-arm64" or type(readiness.get("release_ready")) is not bool
            or not isinstance(readiness.get("issues"), list)
            or any(not isinstance(issue, dict) or not isinstance(issue.get("id"), str) or not issue["id"]
                   or not isinstance(issue.get("detail"), str) or not issue["detail"] for issue in readiness["issues"])
            or readiness["release_ready"] == bool(readiness["issues"])):
        raise ValueError("invalid application license readiness evidence")
    webp = verify_webp_evidence(root, readiness)
    if not readiness["release_ready"] and not internal_alpha:
        raise ValueError("application license evidence has unresolved requirements; only explicit --internal-alpha is allowed")
    return {"manifest_sha256": digest, "file_count": len(declared),
            "release_ready": readiness["release_ready"], "issues": readiness["issues"],
            **({"webp": webp} if webp is not None else {})}


def verify_frontend_input_report(licenses: Path, report_path: Path = None, required: bool = False) -> dict:
    """Bind the builder's public/dist comparison to the bundle's collected inputs.

    This checks a build receipt, not extraction of frontend resources from Mach-O.
    """
    if report_path is None:
        if required:
            raise ValueError("derived WebP application requires --frontend-input-report")
        return None
    if report_path.is_symlink() or not report_path.is_file():
        raise ValueError("frontend input report must be a physical file")
    encoded = report_path.read_bytes()
    report = json.loads(encoded)
    if (not isinstance(report, dict) or type(report.get("schema_version")) is not int
            or report["schema_version"] != 1 or report.get("dist_verified") is not True
            or not isinstance(report.get("scope"), str) or not report["scope"].strip()
            or not isinstance(report.get("input_identity"), dict)):
        raise ValueError("frontend input report must verify the exact dist inputs")
    build_path = safe_pack_path(licenses, "supersplat/build.json")
    overlay_path = safe_pack_path(licenses, "vendored/webp/manifest.json")
    build = json.loads(build_path.read_text())
    overlay = json.loads(overlay_path.read_text())
    identity = report["input_identity"]
    overlay_identity = {"id": overlay.get("id"), "manifest_sha256": sha256(overlay_path),
                        "build_evidence_sha256": overlay.get("build_evidence_sha256")}
    expected = {"signature": build.get("signature"), "webp_overlay": overlay_identity,
                "build_json_sha256": sha256(build_path), "assets": build.get("assets")}
    if (identity != expected or build.get("webp_overlay") != overlay_identity
            or not isinstance(expected["signature"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected["signature"])
            or not isinstance(expected["assets"], list) or not expected["assets"]):
        raise ValueError("frontend input report differs from bundled license/build evidence")
    return {"report_sha256": hashlib.sha256(encoded).hexdigest(), "input_identity": identity,
            "dist_verified": True, "scope": report["scope"]}

def verify_app(app: Path, internal_alpha: bool = False,
               expected_manifest_sha256: str = None, expected_status_sha256: str = None,
               expected_license_manifest_sha256: str = None, frontend_input_report: Path = None,
               expected_team_id: str = None, require_notarized: bool = False,
               expected_signing_identity: str = None) -> dict:
    validate_signing_options(expected_team_id, expected_signing_identity, require_notarized)
    before_inventory = bundle_inventory(app)
    app = app.resolve(strict=True)
    with critical_path(app, "Contents/Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if info.get("CFBundleIdentifier") != "com.metorigin.splat":
        raise ValueError("unexpected application identity")
    if version_tuple(info.get("LSMinimumSystemVersion", "0")) != (15, 0, 0):
        raise ValueError("application must declare macOS 15.0 deployment target")
    name = info.get("CFBundleExecutable", "")
    if not isinstance(name, str) or name in {"", ".", ".."} or Path(name).name != name:
        raise ValueError("invalid application executable")
    executable = critical_path(app, "Contents/MacOS/" + name)
    binary = inspect_macho(executable)
    if not all(dep.startswith(SYSTEM_PREFIXES) for dep in binary.dependencies):
        raise ValueError("application has unexpected non-system dynamic dependencies")
    resources = "Contents/Resources/resources/"
    engines = critical_path(app, resources + "engines")
    critical_path(app, resources + "engines/engine-manifest.json")
    pack = verify_pack(engines)
    if expected_manifest_sha256 and pack["manifest_sha256"] != expected_manifest_sha256:
        raise ValueError("bundled engines differ from the selected frozen engine pack")
    status_path = critical_path(app, resources + "release-status.json")
    status_sha256 = sha256(status_path)
    if expected_status_sha256 and status_sha256 != expected_status_sha256:
        raise ValueError("bundled release status differs from the selected frozen engine pack")
    status = json.loads(status_path.read_text())
    verify_release_status(status, pack["manifest_sha256"], internal_alpha)
    expected_blockers = []
    for engine in sorted(ENGINES):
        audit = json.loads((engines / engine / "provenance/audit.json").read_text())
        record = status["engines"][engine]
        if (record["release_ready"] != audit["release_ready"]
                or record["issue_count"] != len(audit["issues"])):
            raise ValueError("release status disagrees with hashed engine audit: " + engine)
        expected_blockers.extend(dict(issue, engine=engine) for issue in audit["issues"])
        if not audit["release_ready"] and not audit["issues"]:
            expected_blockers.append({"engine": engine, "kind": "redistribution_evidence_review_pending"})
    canonical = lambda records: sorted(json.dumps(record, sort_keys=True) for record in records)
    if canonical(status["blockers"]) != canonical(expected_blockers):
        raise ValueError("release blockers disagree with hashed engine audits")
    app_licenses = critical_path(app, resources + "app-licenses")
    license_report = verify_app_license_evidence(app_licenses, internal_alpha, expected_license_manifest_sha256)
    frontend_report = verify_frontend_input_report(app_licenses, frontend_input_report, "webp" in license_report)
    # Run after all signing. Re-signing embedded binaries after hashing fails above;
    # trusted engine hashes must never be silently regenerated by the app builder.
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
    developer_id = (verify_bundle_developer_id(app, executable, engines, before_inventory,
                                              expected_team_id, expected_signing_identity)
                    if expected_team_id else None)
    notarization = verify_notarization(app, "app") if require_notarized else None
    after_inventory = bundle_inventory(app)
    if before_inventory != after_inventory:
        raise ValueError("application changed during verification")
    if frontend_report and sha256(frontend_input_report) != frontend_report["report_sha256"]:
        raise ValueError("frontend input report changed during verification")
    return {
        "schema_version": 1,
        "validation_scope": "Bundle structure, final signatures and engine hashes; optional Developer ID/stapled notarization checks are recorded separately. Not clean-machine acceptance.",
        "app": str(app),
        "application_sha256": sha256(executable),
        "bundle_inventory_sha256": inventory_sha256(after_inventory),
        "minimum_os": binary.minimum_os,
        "architecture": binary.architecture,
        "engine_manifest_sha256": pack["manifest_sha256"],
        "release_status_sha256": status_sha256,
        "application_license_evidence": license_report,
        **({"frontend_input_evidence": frontend_report} if frontend_report is not None else {}),
        **({"developer_id_verification": developer_id} if developer_id is not None else {}),
        **({"notarization_evidence": notarization} if notarization is not None else {}),
        "engine_file_count": pack["file_count"],
        "engine_distribution_requirements_met": status["distributable"],
        "application_public_release_ready": False,
        "application_release_scope": "Signing and notarization checks do not clear application license issues, native acceptance or clean-host acceptance. Public-release readiness is not granted by this verifier.",
        "internal_alpha_requested": internal_alpha,
        "notarization_verified": notarization is not None,
        "application_notarization": {
            "stapled_ticket_required": require_notarized,
            "stapled_ticket_validated": notarization is not None,
            "gatekeeper_assessment_performed": notarization is not None,
            "scope": "Application's own stapled ticket and assessment only; a separately notarized DMG has separate evidence.",
        },
    }


def verify_dmg(dmg: Path, app: Path, report: dict, internal_alpha: bool = False,
               frontend_input_report: Path = None, expected_team_id: str = None,
               require_notarized: bool = False, expected_signing_identity: str = None,
               require_notarized_container: bool = False) -> dict:
    if require_notarized_container and (require_notarized or report.get("notarization_verified")
                                       or report.get("application_notarization", {}).get("stapled_ticket_required")):
        raise ValueError("container notarization cannot replace an explicit stapled-application requirement")
    signed_policy = report.get("developer_id_verification")
    if signed_policy:
        if expected_team_id and expected_team_id != signed_policy["team_id"]:
            raise ValueError("DMG Team ID differs from the verified application")
        expected_team_id = signed_policy["team_id"]
        selected_identity = signed_policy.get("expected_identity_sha1")
        if expected_signing_identity and selected_identity and expected_signing_identity.upper() != selected_identity:
            raise ValueError("DMG signing identity differs from the verified application")
        expected_signing_identity = expected_signing_identity or selected_identity
    require_notarized = require_notarized or bool(report.get("notarization_verified"))
    validate_signing_options(expected_team_id, expected_signing_identity,
                             require_notarized or require_notarized_container)
    dmg = dmg.resolve(strict=True)
    expected_inventory = bundle_inventory(app)
    if inventory_sha256(expected_inventory) != report["bundle_inventory_sha256"]:
        raise ValueError("source application changed after verification")
    before_hash = sha256(dmg)
    run(["/usr/bin/hdiutil", "verify", dmg])
    developer_id = (pack_macos.verify_developer_id_signature(
        dmg, expected_team_id, expected_identity=expected_signing_identity) if expected_team_id else None)
    notarization = verify_notarization(dmg, "dmg") if require_notarized or require_notarized_container else None
    with tempfile.TemporaryDirectory(prefix="metorigin-dmg-") as temporary:
        mount = Path(temporary) / "mount"
        mount.mkdir()
        # -readonly prevents inspection from changing the artifact being verified.
        attached = False
        try:
            run(["/usr/bin/hdiutil", "attach", "-readonly", "-noautoopen",
                 "-mountpoint", mount, dmg])
            attached = True
            embedded = mount / app.name
            if bundle_inventory(embedded) != expected_inventory:
                raise ValueError("DMG application differs from the verified source bundle")
            embedded_report = verify_app(embedded, internal_alpha,
                                         report["engine_manifest_sha256"], report["release_status_sha256"],
                                         report["application_license_evidence"]["manifest_sha256"], frontend_input_report,
                                         expected_team_id, require_notarized, expected_signing_identity)
            if embedded_report["bundle_inventory_sha256"] != report["bundle_inventory_sha256"]:
                raise ValueError("DMG application changed during verification")
            if embedded_report.get("frontend_input_evidence") != report.get("frontend_input_evidence"):
                raise ValueError("DMG frontend input evidence differs from the verified source")
            if signed_policy and embedded_report.get("developer_id_verification") != signed_policy:
                raise ValueError("DMG Developer ID evidence differs from the verified source")
            embedded_notarization = {
                "developer_id_verified": "developer_id_verification" in embedded_report,
                "stapled_ticket_required": require_notarized,
                "stapled_ticket_validated": embedded_report["notarization_verified"],
                "gatekeeper_assessment_performed": embedded_report["notarization_verified"],
                **({"evidence": embedded_report["notarization_evidence"]} if require_notarized else {}),
                "scope": "Embedded application evidence is separate from the DMG's own notarization. No app ticket is claimed unless explicitly validated.",
            }
        finally:
            if attached:
                run(["/usr/bin/hdiutil", "detach", mount])
    if sha256(dmg) != before_hash:
        raise ValueError("DMG changed during verification")
    if bundle_inventory(app) != expected_inventory:
        raise ValueError("source application changed during DMG verification")
    return {"path": str(dmg), "sha256": before_hash, "mounted_read_only": True,
            "application_matches_verified_bundle": True, "application_signatures_verified": True,
            **({"developer_id_verification": developer_id} if developer_id is not None else {}),
            **({"notarization_evidence": notarization} if notarization is not None else {}),
            "notarization_policy": (NOTARIZATION_STRICT if require_notarized else
                                    NOTARIZATION_CONTAINER if require_notarized_container else "not-required"),
            "embedded_application_notarization": embedded_notarization,
            "notarization_verified": notarization is not None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path, nargs="?")
    parser.add_argument("--check-app-license-evidence", type=Path)
    parser.add_argument("--internal-alpha", action="store_true")
    parser.add_argument("--expected-manifest-sha256")
    parser.add_argument("--expected-release-status-sha256")
    parser.add_argument("--expected-app-license-manifest-sha256")
    parser.add_argument("--expected-team-id", help="Require Apple Developer ID Application signatures from this Team ID")
    parser.add_argument("--expected-signing-identity", help="Also require this signing certificate SHA-1 fingerprint")
    notarization_options = parser.add_mutually_exclusive_group()
    notarization_options.add_argument("--require-notarized", action="store_true",
                                      help="Require the app's own valid stapled ticket and Gatekeeper assessment, plus the DMG's when supplied (requires Team ID)")
    notarization_options.add_argument("--require-notarized-container", action="store_true",
                                      help="Require a signed, stapled and Gatekeeper-accepted DMG with the exact Developer ID-signed app; no app-owned ticket is required (requires --dmg and Team ID)")
    parser.add_argument("--frontend-input-report", type=Path,
                        help="Builder receipt verifying exact prepared public and Vite dist inputs")
    parser.add_argument("--expected-app-report", type=Path,
                        help="Require the exact signed application from this earlier verification report")
    parser.add_argument("--expected-code-report", type=Path,
                        help="Require pre/post-staple code, signature and input identity continuity after full bundle verification")
    parser.add_argument("--dmg", type=Path, help="Mount this newly created DMG read-only and verify its exact app")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if bool(args.app) == bool(args.check_app_license_evidence):
        parser.error("supply an app bundle or --check-app-license-evidence, exclusively")
    if args.require_notarized_container and (not args.dmg or not args.expected_team_id):
        parser.error("--require-notarized-container requires --dmg and --expected-team-id")
    if args.check_app_license_evidence:
        if (args.dmg or args.expected_app_report or args.expected_code_report or args.frontend_input_report
                or args.expected_team_id or args.expected_signing_identity or args.require_notarized
                or args.require_notarized_container):
            parser.error("DMG, frontend, signing and notarization options require an app bundle")
        report = verify_app_license_evidence(args.check_app_license_evidence, args.internal_alpha,
                                            args.expected_app_license_manifest_sha256)
    else:
        report = verify_app(args.app, args.internal_alpha, args.expected_manifest_sha256,
                            args.expected_release_status_sha256, args.expected_app_license_manifest_sha256,
                            args.frontend_input_report, args.expected_team_id, args.require_notarized,
                            args.expected_signing_identity)
        if args.expected_code_report:
            verify_code_report_matches(report, json.loads(args.expected_code_report.read_text()))
        if args.expected_app_report:
            verify_app_report_matches(report, json.loads(args.expected_app_report.read_text()))
    if args.dmg:
        report["dmg"] = verify_dmg(args.dmg, args.app, report, args.internal_alpha, args.frontend_input_report,
                                   args.expected_team_id, args.require_notarized, args.expected_signing_identity,
                                   args.require_notarized_container)
        report["distribution_notarization_policy"] = report["dmg"]["notarization_policy"]
        report["distribution_notarization_verified"] = report["dmg"]["notarization_verified"]
    if args.report:
        write_json(args.report, report)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
