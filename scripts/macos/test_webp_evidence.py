"""Small collected-evidence fixtures, using the checked-in original notice bytes."""
import copy
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from webp_evidence import (FINDING, OLD_WASM, PREFIX, RUNTIME_COMPONENTS, archive_member,
                           digest, notice_component, reference, selected_evidence_files,
                           verify_webp_evidence)


ROOT = Path(__file__).resolve().parents[2]
OVERLAY = ROOT / "integrations/supersplat/webp-overlay"


def write_json(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n")


def read_json(root, name):
    return json.loads((root / name).read_text())


def derived_fixture(root, overlay=OVERLAY, component_inventory=RUNTIME_COMPONENTS):
    """Create only copied receipts/notices and metadata; no payload/build work."""
    (root / "vendored/webp").mkdir(parents=True)
    for name in ("manifest.json", "build-evidence.json"):
        shutil.copyfile(overlay / name, root / "vendored/webp" / name)
    manifest = read_json(root, "vendored/webp/manifest.json")
    build = read_json(root, "vendored/webp/build-evidence.json")
    selected = selected_evidence_files(build)
    for path in selected:
        target = root / PREFIX / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(overlay / "evidence" / path, target)
    identity = {"id": manifest["id"], "manifest_sha256": digest((root / "vendored/webp/manifest.json").read_bytes()),
                "build_evidence_sha256": digest((root / "vendored/webp/build-evidence.json").read_bytes())}
    notices = []
    for original in build["runtime_evidence"]["original_notices_and_linked_sources"]:
        component = notice_component(original["path"])
        if component:
            notices.append({**reference(original), "path": PREFIX + original["path"],
                            "component": component_inventory[component][0], "runtime_component": component})
    normalized = {"schema_version": 1, "status": "verified-derived-replacement", "overlay": identity,
                  "base": manifest["base"], "files": [{**item, "path": PREFIX + path} for path, item in selected.items()],
                  "notices": notices, "runtime": {"linked_members": sorted(map(archive_member, build["runtime_evidence"]["linked_members"])),
                  "sources": build["sources"]}, "historical_prebuilt": {"wasm_sha256": OLD_WASM, "status": "provenance-unresolved"},
                  "scope": "Source/build evidence only; final application acceptance is separate."}
    components = [{"bom-ref": ref, "name": name, "version": version} for ref, name, version in component_inventory.values()]
    components[0]["properties"] = [{"name": "metorigin:distribution-kind", "value": "derived-fixed-webp-overlay"},
                                   {"name": "metorigin:webp-overlay-id", "value": identity["id"]},
                                   {"name": "metorigin:webp-overlay-manifest-sha256", "value": identity["manifest_sha256"]}]
    wasm = next(item for item in manifest["files"] if item["path"] == "lib/webp.wasm")
    components.append({"bom-ref": "webp-wasm:sha256:" + wasm["sha256"], "name": "SuperSplat derived WebP WASM",
                       "hashes": [{"alg": "SHA-256", "content": wasm["sha256"]}]})
    index = copy.deepcopy(notices)
    index.extend({**notice, "component": component_inventory["sharpyuv"][0]} for notice in notices if notice["runtime_component"] == "libwebp")
    assets = [{**reference(item), "path": "static/" + item["path"].replace("lib/", "lib/webp/")} for item in manifest["files"] if item["path"].startswith("lib/")]
    write_json(root, "vendored/webp/evidence.json", normalized)
    write_json(root, "SBOM.cdx.json", {"bomFormat": "CycloneDX", "components": components})
    write_json(root, "dependency-license-index.json", index)
    write_json(root, "supersplat/build.json", {"signature": "f" * 64, "webp_overlay": identity, "assets": assets})
    write_json(root, "supersplat/static-payload-inventory.json", assets)
    readiness = {"schema_version": 1, "release_ready": True, "issues": [], "resolved_findings": [
        {"id": FINDING, "evidence": "vendored/webp/evidence.json", "resolution": "replaced-with-fixed-source-build"}]}
    write_json(root, "release-readiness.json", readiness)
    return readiness


def rebind_metadata(root, build=None):
    """Model an attacker regenerating all enclosing metadata after an edit."""
    if build is not None:
        write_json(root, "vendored/webp/build-evidence.json", build)
    manifest = read_json(root, "vendored/webp/manifest.json")
    manifest["build_evidence_sha256"] = digest((root / "vendored/webp/build-evidence.json").read_bytes())
    write_json(root, "vendored/webp/manifest.json", manifest)
    normalized = read_json(root, "vendored/webp/evidence.json")
    identity = {"id": manifest["id"], "manifest_sha256": digest((root / "vendored/webp/manifest.json").read_bytes()),
                "build_evidence_sha256": manifest["build_evidence_sha256"]}
    normalized["overlay"] = identity
    write_json(root, "vendored/webp/evidence.json", normalized)
    built = read_json(root, "supersplat/build.json")
    built["webp_overlay"] = identity
    write_json(root, "supersplat/build.json", built)
    bom = read_json(root, "SBOM.cdx.json")
    for component in bom["components"]:
        for prop in component.get("properties", []):
            if prop["name"] == "metorigin:webp-overlay-manifest-sha256":
                prop["value"] = identity["manifest_sha256"]
    write_json(root, "SBOM.cdx.json", bom)
    # The application verifier's outer inventory has also been recomputed.
    files = [{"path": path.relative_to(root).as_posix(), "size_bytes": path.stat().st_size,
              "sha256": digest(path.read_bytes())} for path in root.rglob("*") if path.is_file() and path != root / "manifest.json"]
    write_json(root, "manifest.json", {"schema_version": 1, "platform": "macos-arm64", "files": files})


class WebpEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_dir = tempfile.TemporaryDirectory(prefix="webp-license-template-")
        cls.template = Path(cls.template_dir.name)
        cls.readiness = derived_fixture(cls.template)

    @classmethod
    def tearDownClass(cls):
        cls.template_dir.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="webp-license-test-")
        self.root = Path(self.temp.name)
        shutil.copytree(self.template, self.root, dirs_exist_ok=True)
        self.ready = copy.deepcopy(self.readiness)

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        return verify_webp_evidence(self.root, self.ready)

    def test_real_fixed_evidence_is_accepted(self):
        result = self.verify()
        self.assertEqual((result["evidence_file_count"], result["runtime_notice_count"], result["linked_member_count"]), (106, 48, 94))
        self.assertEqual(result["historical_prebuilt_provenance"], "unresolved")

    def test_normalized_references_remain_confined_to_reviewed_stage_logs(self):
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        first = next(step for step in build["successful_steps"] if step["path"] == "receipts/install-sdk.json")
        stage = first["command"]["cwd"][:-len("/sources/emsdk")]
        for path in ("${REPO_ROOT}/unrelated/logs/untrusted.log", stage + "/logs/../untrusted.log",
                     stage + "/build-environment.json", "${HOME}/untrusted.log"):
            changed = copy.deepcopy(build)
            changed["configuration"]["environment"]["path"] = path
            with self.assertRaises(ValueError):
                selected_evidence_files(changed)
        build["path_normalization"]["original_build_evidence_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "unreviewed normalized evidence path"):
            selected_evidence_files(build)

    def test_generic_inventory_remains_compatible(self):
        shutil.rmtree(self.root / "vendored")
        shutil.rmtree(self.root / "supersplat")
        write_json(self.root, "SBOM.cdx.json", {"bomFormat": "CycloneDX"})
        self.ready["resolved_findings"] = []
        self.assertIsNone(self.verify())

    def test_historical_inventory_requires_unresolved_finding(self):
        shutil.rmtree(self.root / "vendored/webp")
        write_json(self.root, "SBOM.cdx.json", {"components": [{"bom-ref": "webp-wasm:sha256:" + OLD_WASM, "name": "SuperSplat WebP WASM"}]})
        write_json(self.root, "supersplat/build.json", {"version": "3.0.1"})
        self.ready["resolved_findings"] = []
        self.ready["issues"] = [{"id": FINDING, "detail": "Original prebuilt provenance unresolved"}]
        self.assertIsNone(self.verify())
        self.ready["issues"] = []
        with self.assertRaisesRegex(ValueError, "issue removed without derived proof"):
            self.verify()

    def test_fabricated_resolution_without_evidence_is_rejected(self):
        shutil.rmtree(self.root / "vendored/webp")
        shutil.rmtree(self.root / "supersplat")
        write_json(self.root, "SBOM.cdx.json", {"bomFormat": "CycloneDX"})
        with self.assertRaisesRegex(ValueError, "resolved provenance has no derived proof"):
            self.verify()

    def test_partial_derived_proof_cannot_downgrade_to_unresolved_alpha(self):
        (self.root / "vendored/webp/evidence.json").unlink()
        self.ready["resolved_findings"] = []
        self.ready["issues"] = [{"id": FINDING, "detail": "Original prebuilt provenance unresolved"}]
        with self.assertRaisesRegex(ValueError, "cannot downgrade to historical"):
            self.verify()
        shutil.rmtree(self.root / "vendored/webp")
        with self.assertRaisesRegex(ValueError, "cannot downgrade to historical"):
            self.verify()
        write_json(self.root, "SBOM.cdx.json", {"components": [{"bom-ref": "webp-wasm:sha256:" + OLD_WASM, "name": "SuperSplat WebP WASM"}]})
        with self.assertRaisesRegex(ValueError, "cannot downgrade to historical"):
            self.verify()

    def test_derived_proof_cannot_drop_its_resolution(self):
        self.ready["resolved_findings"] = []
        with self.assertRaisesRegex(ValueError, "requires its resolved finding"):
            self.verify()

    def test_missing_runtime_notice_after_regenerated_inventory_is_rejected(self):
        path = "licenses/emscripten/system/lib/libc/musl/src/stdlib/qsort.c"
        (self.root / PREFIX / path).unlink()
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        build["runtime_evidence"]["original_notices_and_linked_sources"] = [r for r in build["runtime_evidence"]["original_notices_and_linked_sources"] if r["path"] != path]
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        for key in ("files", "notices"):
            normalized[key] = [r for r in normalized[key] if r["path"] != PREFIX + path]
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "missing/changed original runtime notice"):
            self.verify()

    def test_omitted_arm_header_with_updated_source_mapping_is_rejected(self):
        path = "licenses/emscripten/system/lib/libc/musl/src/math/exp_data.h"
        source = "sources/emsdk/upstream/emscripten/system/lib/libc/musl/src/math/exp_data.h"
        (self.root / PREFIX / path).unlink()
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        build["runtime_evidence"]["original_notices_and_linked_sources"] = [r for r in build["runtime_evidence"]["original_notices_and_linked_sources"] if r["path"] != path]
        for mapping in build["runtime_evidence"]["source_mapping"]:
            mapping["source_paths"] = [item for item in mapping["source_paths"] if item != source]
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        for key in ("files", "notices"):
            normalized[key] = [r for r in normalized[key] if r["path"] != PREFIX + path]
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "runtime source mapping differs|missing/changed original runtime notice"):
            self.verify()

    def test_substituted_original_notice_after_rehash_is_rejected(self):
        path = "licenses/libwebp/COPYING"
        target = self.root / PREFIX / path
        target.write_text("This is an invented permissive grant.\n")
        ref = {"sha256": digest(target.read_bytes()), "size_bytes": target.stat().st_size}
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        next(r for r in build["runtime_evidence"]["original_notices_and_linked_sources"] if r["path"] == path).update(ref)
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        for key in ("files", "notices"):
            next(r for r in normalized[key] if r["path"] == PREFIX + path).update(ref)
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "missing/changed original runtime notice"):
            self.verify()

    def test_failed_cleanup_cannot_pass_by_rehashing(self):
        path = "v2/cleanup-acceptance.json"
        cleanup = read_json(self.root, PREFIX + path)
        cleanup["cases"][0]["observed"]["outstanding_callers"] = 1
        write_json(self.root, PREFIX + path, cleanup)
        target = self.root / PREFIX / path
        ref = {"sha256": digest(target.read_bytes()), "size_bytes": target.stat().st_size}
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        build["verification"]["cleanup"].update(ref)
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        next(r for r in normalized["files"] if r["path"] == PREFIX + path).update(ref)
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "failed cleanup case"):
            self.verify()

    def test_source_and_link_mapping_cannot_be_rewritten(self):
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        build["runtime_evidence"]["source_mapping"].pop()
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "runtime source coverage mismatch"):
            self.verify()

    def test_source_mapping_cannot_substitute_another_noticed_source(self):
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        mapping = next(item for item in build["runtime_evidence"]["source_mapping"] if item["archive_member"].endswith("libc.a(expf.o)"))
        mapping["source_paths"] = ["sources/emsdk/upstream/emscripten/system/lib/libc/musl/src/math/log10.c"]
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "runtime source mapping differs"):
            self.verify()

    def test_shared_sharpyuv_notices_are_required(self):
        index = read_json(self.root, "dependency-license-index.json")
        write_json(self.root, "dependency-license-index.json", [item for item in index if item["component"] != RUNTIME_COMPONENTS["sharpyuv"][0]])
        with self.assertRaisesRegex(ValueError, "shared sharpyuv notice missing"):
            self.verify()

    def test_derived_npm_annotation_is_required(self):
        bom = read_json(self.root, "SBOM.cdx.json")
        bom["components"][0].pop("properties")
        write_json(self.root, "SBOM.cdx.json", bom)
        with self.assertRaisesRegex(ValueError, "labeled as original bytes"):
            self.verify()

    def test_symlinked_notice_is_rejected(self):
        target = self.root / PREFIX / "licenses/libwebp/COPYING"
        data = target.read_bytes()
        target.unlink()
        (self.root / "replacement.txt").write_bytes(data)
        target.symlink_to(self.root / "replacement.txt")
        with self.assertRaisesRegex(ValueError, "nonphysical file"):
            self.verify()

    def test_paired_static_codec_cannot_be_stale(self):
        built = read_json(self.root, "supersplat/build.json")
        built["assets"][0]["sha256"] = "0" * 64
        write_json(self.root, "supersplat/build.json", built)
        with self.assertRaisesRegex(ValueError, "prepared codec inventory mismatch"):
            self.verify()

    def test_malformed_reference_is_value_error(self):
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        normalized["files"][0]["size_bytes"] = True
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        with self.assertRaisesRegex(ValueError, "malformed evidence file reference"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
