"""Current collected proof, including hostile rebinding of outer metadata."""
import copy
from pathlib import Path
import shutil
import tempfile
import unittest

from test_webp_evidence import derived_fixture, read_json, rebind_metadata, write_json
from webp_evidence import OLD_WASM, PREFIX, verify_webp_evidence
from webp_evidence_3102 import BASE, COMPONENTS, PROFILE, UPSTREAM

ROOT = Path(__file__).resolve().parents[2]
OVERLAY = ROOT / "integrations/supersplat/webp-overlay-3.10.2"


def current_fixture(root):
    readiness = derived_fixture(root, OVERLAY, COMPONENTS)
    built = read_json(root, "supersplat/build.json")
    manifest = read_json(root, "vendored/webp/manifest.json")
    built.update(UPSTREAM)
    built["assets"] = [item for item in built["assets"] if not item["path"].endswith("webp.mjs")]
    built["assets"].append({"path": "index.js.map", "size_bytes": 100, "sha256": "a" * 64})
    write_json(root, "supersplat/build.json", built)
    write_json(root, "supersplat/static-payload-inventory.json", [item for item in built["assets"] if item["path"].startswith("static/")])
    module = next(item for item in manifest["files"] if item["path"] == "dist/index.mjs")
    write_json(root, "supersplat/source-map-package-evidence.json", {"upstream": UPSTREAM,
        "webp_overlay": built["webp_overlay"], "source_map_sha256": "a" * 64,
        "packages": ["node_modules/@playcanvas/splat-transform"],
        "derived_module": {"source": "../node_modules/@playcanvas/splat-transform/dist/index.mjs", "sha256": module["sha256"], "base": BASE}})
    shutil.copyfile(ROOT / "packaging/macos-arm64/licenses/app-vendored-evidence.json", root / "index.json")
    write_json(root, "build-inputs/app-vendored-evidence.json", read_json(root, "index.json"))
    (root / "index.json").unlink()
    return readiness


class CurrentWebpEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_dir = tempfile.TemporaryDirectory(prefix="webp-3102-template-")
        cls.template = Path(cls.template_dir.name)
        cls.readiness = current_fixture(cls.template)

    @classmethod
    def tearDownClass(cls):
        cls.template_dir.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="webp-3102-test-")
        self.root = Path(self.temp.name)
        shutil.copytree(self.template, self.root, dirs_exist_ok=True)
        self.readiness = copy.deepcopy(self.readiness)

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        return verify_webp_evidence(self.root, self.readiness)

    def test_accepts_reviewed_profile_without_an_unused_static_glue_file(self):
        result = self.verify()
        self.assertEqual(result["profile"], PROFILE)
        self.assertEqual(result["evidence_file_count"], 87)
        self.assertEqual(result["linked_member_count"], 94)

    def test_self_rehashed_build_cannot_change_source_or_acceptance_claims(self):
        build = read_json(self.root, "vendored/webp/build-evidence.json")
        build["verification"]["upstream_sog_html_webp_tests"]["passed"] = 0
        rebind_metadata(self.root, build)
        with self.assertRaisesRegex(ValueError, "unreviewed current WebP build"):
            self.verify()

    def test_current_profile_cannot_use_the_old_package_base(self):
        manifest = read_json(self.root, "vendored/webp/manifest.json")
        manifest["base"]["version"] = "3.4.2"
        write_json(self.root, "vendored/webp/manifest.json", manifest)
        normalized = read_json(self.root, "vendored/webp/evidence.json")
        normalized["base"] = manifest["base"]
        write_json(self.root, "vendored/webp/evidence.json", normalized)
        rebind_metadata(self.root)
        with self.assertRaisesRegex(ValueError, "unexpected current WebP package base"):
            self.verify()

    def test_changed_copied_source_is_rejected(self):
        path = PREFIX + "sources/splat-transform/src/lib/utils/webp-codec.ts"
        (self.root / path).write_text("changed")
        with self.assertRaisesRegex(ValueError, "current evidence bytes changed"):
            self.verify()

    def test_missing_notice_ownership_is_rejected(self):
        index = read_json(self.root, "dependency-license-index.json")
        write_json(self.root, "dependency-license-index.json", [item for item in index if item["component"] != COMPONENTS["splat-transform"][0]])
        with self.assertRaisesRegex(ValueError, "current notice absent"):
            self.verify()

    def test_source_map_cannot_claim_another_derived_module(self):
        source_map = read_json(self.root, "supersplat/source-map-package-evidence.json")
        source_map["derived_module"]["sha256"] = "b" * 64
        write_json(self.root, "supersplat/source-map-package-evidence.json", source_map)
        with self.assertRaisesRegex(ValueError, "current source-map derivative mismatch"):
            self.verify()

    def test_actual_codec_inventory_cannot_switch_to_the_old_wasm(self):
        for filename in ("supersplat/build.json", "supersplat/static-payload-inventory.json"):
            document = read_json(self.root, filename)
            assets = document["assets"] if isinstance(document, dict) else document
            for item in assets:
                if item["path"].endswith("webp.wasm"):
                    item["sha256"] = OLD_WASM
            write_json(self.root, filename, document)
        with self.assertRaisesRegex(ValueError, "prepared current codec inventory mismatch"):
            self.verify()

    def test_historical_provenance_cannot_be_relabelled(self):
        index = read_json(self.root, "build-inputs/app-vendored-evidence.json")
        index["webp"]["wasm_sha256"] = "c" * 64
        write_json(self.root, "build-inputs/app-vendored-evidence.json", index)
        with self.assertRaisesRegex(ValueError, "current/historical vendored binding mismatch"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
