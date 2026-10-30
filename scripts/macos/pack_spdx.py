"""SPDX 2.3 projection of the exact engine audit (source evidence stays adjacent)."""

from datetime import datetime, timezone
import hashlib
import json
import re
import uuid

from pack_macos import sha256, write_json


def spdx_expression(declared):
    # Cargo historically accepted '/' as OR. Preserve the exact declaration in
    # the audit/comments while emitting an SPDX expression here. Do not rewrite
    # the 'or' within identifiers such as LGPL-2.1-or-later.
    value = re.sub(r"\s+or\s+", " OR ", declared)
    return re.sub(r"\s*/\s*", " OR ", value)


def write_spdx(engine_root, engine, version):
    audit_path = engine_root / "provenance/audit.json"
    audit = json.loads(audit_path.read_text())
    components = audit.get("components", [dict(audit, id=engine)])
    packages = []
    identifiers = []
    for index, component in enumerate(components):
        identifier = f"SPDXRef-Package-{index}"
        identifiers.append(identifier)
        source = component.get("source", {})
        url = source.get("url", "NOASSERTION") if isinstance(source, dict) else (
            f"https://crates.io/api/v1/crates/{component['name']}/{component['version']}/download"
            if source.startswith("registry+") else source.removeprefix("git+") if source.startswith("git+") else "NOASSERTION")
        license_declared = component.get("license_effective", component.get("license_declared", "NOASSERTION"))
        original_declaration = license_declared
        license_declared = spdx_expression(license_declared)
        package = {"SPDXID": identifier, "name": component["name"], "versionInfo": component.get("version", version),
                   "downloadLocation": url, "filesAnalyzed": False,
                   "licenseConcluded": "NOASSERTION", "licenseDeclared": license_declared,
                   "copyrightText": "NOASSERTION",
                   "comment": "Exact component ID: " + component["id"] + "; upstream/effective declaration: " + original_declaration + "; provenance/audit.json retains source, recipe, notice and build evidence."}
        archive = component.get("source_archive", {})
        if archive.get("sha256"):
            package["checksums"] = [{"algorithm": "SHA256", "checksumValue": archive["sha256"]}]
        packages.append(package)
    identity = hashlib.sha256(audit_path.read_bytes()).hexdigest()
    doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, engine + ":" + identity))
    sbom = {"spdxVersion": "SPDX-2.3", "dataLicense": "CC0-1.0", "SPDXID": "SPDXRef-DOCUMENT",
            "name": f"MetOrigin-{engine}-macos-arm64-{version}",
            "documentNamespace": f"https://spdx.org/spdxdocs/metorigin-{engine}-{doc_id}",
            "creationInfo": {"creators": ["Tool: MetOrigin-pack_spdx.py-1"],
                             "created": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "comment": audit.get("scope", "Native engine source and license evidence")},
            "packages": packages,
            "relationships": [{"spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": identifier}
                              for identifier in identifiers],
            "documentComment": "Inventory of actual runtime/target-build inputs. An SPDX inventory is not release approval; see audit.json issues and the manifest-bound release-status.json."}
    write_json(engine_root / "provenance/sbom.spdx.json", sbom)


def write_release_status(pack):
    manifest = json.loads((pack / "engine-manifest.json").read_text())
    blockers = []
    engine_status = {}
    for engine in manifest["engines"]:
        audit = json.loads((pack / engine / "provenance/audit.json").read_text())
        issues = audit.get("issues", [])
        engine_status[engine] = {"release_ready": audit.get("release_ready", False), "issue_count": len(issues),
                                 "audit_path": engine + "/provenance/audit.json"}
        blockers.extend(dict(issue, engine=engine) for issue in issues)
        if not audit.get("release_ready") and not issues:
            blockers.append({"engine": engine, "kind": "redistribution_evidence_review_pending"})
    status = {"schema_version": 1, "manifest_sha256": sha256(pack / "engine-manifest.json"),
              "distributable": not blockers, "distribution_status": "blocked" if blockers else "evidence-complete",
              "allowed_use": "internal-alpha-validation" if blockers else "subject-to-app-signing-and-acceptance",
              "engines": engine_status, "blockers": blockers,
              "acceptance_scope": "Engine evidence only; clean-machine, application signing/notarization and app acceptance are separate."}
    write_json(pack.parent / "release-status.json", status)
    return status
