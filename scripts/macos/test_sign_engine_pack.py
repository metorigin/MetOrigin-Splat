"""Checks for pinned-input signing derivation without certificates or network."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from pack_macos import MachO, sha256, verify_developer_id_signature, write_json
from pack_spdx import write_release_status


SPEC = importlib.util.spec_from_file_location("sign_engine_pack", Path(__file__).with_name("sign-engine-pack.py"))
signing = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(signing)
TEAM = "ABCDEFGHIJ"
IDENTITY = "A" * 40
DISPLAY = """Executable=/synthetic/fixture
CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+2 location=embedded
Authority=Developer ID Application: Test Company (ABCDEFGHIJ)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 1, 2026 at 12:00:00
TeamIdentifier=ABCDEFGHIJ
"""


class DeveloperIDVerificationTests(unittest.TestCase):
    def verify(self, metadata=DISPLAY, **kwargs):
        completed = subprocess.CompletedProcess([], 0, stdout="", stderr=metadata)
        def require_inline_expression(argv, **options):
            expression = argv[argv.index("--test-requirement") + 1]
            if not expression.startswith("="):
                raise ValueError("codesign interprets requirement arguments without '=' as filenames")
            return ""
        with patch("pack_macos.run", side_effect=require_inline_expression) as execute, \
                patch("pack_macos.subprocess.run", return_value=completed):
            result = verify_developer_id_signature(Path("fixture"), TEAM, **kwargs)
        return result, execute

    def test_verifies_apple_chain_team_timestamp_and_runtime(self):
        result, execute = self.verify(require_runtime=True, expected_identity=IDENTITY)
        requirement = execute.call_args.args[0]
        self.assertIn("--test-requirement", requirement)
        self.assertTrue(requirement[-2].startswith("=anchor apple generic"))
        self.assertIn("anchor apple generic", requirement[-2])
        self.assertIn("certificate 1[field.1.2.840.113635.100.6.2.6]", requirement[-2])
        self.assertIn("certificate leaf[field.1.2.840.113635.100.6.1.13]", requirement[-2])
        self.assertIn(f'certificate leaf = H"{IDENTITY}"', requirement[-2])
        self.assertEqual(result["team_id"], TEAM)
        self.assertTrue(result["hardened_runtime"])
        self.assertTrue(result["requirement_verified"])

    def test_invalid_signature_policy_fails_closed(self):
        for metadata, expression in [
            (DISPLAY.replace("Timestamp=Nov 1, 2026 at 12:00:00\n", ""), "timestamp"),
            (DISPLAY.replace("TeamIdentifier=ABCDEFGHIJ", "TeamIdentifier=WRONGTEAM1"), "identity"),
            (DISPLAY.replace("Developer ID Application: Test", "Apple Development: Test"), "identity"),
            (DISPLAY + "Signature=adhoc\n", "identity"),
            (DISPLAY.replace("0x10000(runtime)", "0x0(none)"), "hardened runtime"),
        ]:
            with self.subTest(metadata=metadata), self.assertRaisesRegex(ValueError, expression):
                self.verify(metadata, require_runtime=True)

    def test_dylib_does_not_require_runtime_and_untrusted_chain_cannot_pass(self):
        result, _ = self.verify(DISPLAY.replace("0x10000(runtime)", "0x0(none)"))
        self.assertFalse(result["hardened_runtime"])
        with patch("pack_macos.run", side_effect=ValueError("requirement rejected")):
            with self.assertRaisesRegex(ValueError, "requirement rejected"):
                verify_developer_id_signature(Path("fixture"), TEAM)

    def test_team_and_fingerprint_are_not_interpolated_as_unvalidated_requirements(self):
        for team, identity in [('X" or true', None), (TEAM, 'A" or true')]:
            with self.assertRaises(ValueError):
                verify_developer_id_signature(Path("fixture"), team, expected_identity=identity)


class SignedPackDerivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="签名 fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "original" / "engines"
        self.output = self.root / "signed distribution"
        self.source.mkdir(parents=True)
        self.manifest = {"schema_version": 1, "pack_version": "test", "platform": "macos-arm64", "engines": {}}
        self.code_names = []
        for engine, commands in {"ffmpeg": ["ffmpeg", "ffprobe"], "colmap": ["colmap"], "brush": ["brush"]}.items():
            code = [engine + "/bin/" + command for command in commands]
            if engine == "colmap":
                code.append("colmap/lib/library.dylib")
            self.code_names.extend(code)
            for name in code:
                target = self.source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"\xcf\xfa\xed\xfe\0patched\0fixture")
                target.chmod(0o755)
            notice = self.source / engine / "licenses/LICENSE"
            notice.parent.mkdir(parents=True)
            notice.write_text("Original upstream notice")
            audit = {"release_ready": True, "issues": [], "components": [
                {"id": engine + "-1", "name": engine, "version": "1", "license_declared": "MIT"}]}
            write_json(self.source / engine / "provenance/audit.json", audit)
            write_json(self.source / engine / "provenance/relocation-map.json", [
                {"source": "original-build/" + name, "source_sha256": "b" * 64,
                 "packaged_path": name, "packaged_sha256": sha256(self.source / name),
                 "original_load_commands": {}} for name in code])
            rewrites = [{"path": "lib/library.dylib", "final_signed_sha256": sha256(self.source / "colmap/lib/library.dylib"),
                         "fields": [{"offset": 5, "byte_length": 7, "replacement_literal": "patched"}]}] if engine == "colmap" else []
            write_json(self.source / engine / "provenance/embedded-prefix-rewrites.json", {"schema_version": 1, "files": rewrites})
            write_json(self.source / engine / "provenance/sbom.spdx.json", {"source": "original SBOM"})
            self.manifest["engines"][engine] = {"version": "1", "source_url": "https://example.invalid/locked-source",
                "source_sha256": "b" * 64, "executables": {command: engine + "/bin/" + command for command in commands},
                "files": [], "license_files": [engine + "/licenses/LICENSE"]}
        self.save_manifest()
        write_release_status(self.source)
        self.manifest_hash = sha256(self.source / "engine-manifest.json")
        self.status_hash = sha256(self.source.parent / "release-status.json")
        self.signed_order = []

    def save_manifest(self):
        for engine, record in self.manifest["engines"].items():
            record["files"] = [{"path": path.relative_to(self.source).as_posix(), "sha256": sha256(path),
                                 "size_bytes": path.stat().st_size}
                                for path in sorted((self.source / engine).rglob("*")) if path.is_file()]
        write_json(self.source / "engine-manifest.json", self.manifest)

    def inspect(self, path):
        return MachO(str(path), "arm64", "15.0", [], [],
                     "@loader_path/library.dylib" if path.suffix == ".dylib" else None)

    def execute(self, argv, **kwargs):
        if "--sign" in argv:
            path = Path(argv[-1])
            self.signed_order.append((str(path), argv))
            path.write_bytes(path.read_bytes() + b"-new-developer-id-signature")
        return ""

    def derive(self, **kwargs):
        defaults = dict(source_pack=self.source, output=self.output,
                        expected_source_manifest_sha256=self.manifest_hash,
                        expected_source_release_status_sha256=self.status_hash, identity=IDENTITY, team_id=TEAM)
        defaults.update(kwargs)
        with patch("pack_macos.inspect_macho", side_effect=self.inspect), patch("pack_macos.run", return_value=""), \
                patch.object(signing, "run", side_effect=self.execute), \
                patch.object(signing, "verify_developer_id_signature", return_value={"team_id": TEAM, "hardened_runtime": True}):
            return signing.derive_signed_pack(**defaults)

    def test_preserves_source_and_rebinds_final_artifact_evidence(self):
        original_files = {path.relative_to(self.source).as_posix(): path.read_bytes()
                          for path in self.source.rglob("*") if path.is_file()}
        result = self.derive()
        self.assertEqual(result["signed_macho_count"], 5)
        self.assertNotEqual(result["manifest_sha256"], self.manifest_hash)
        self.assertEqual(original_files, {path.relative_to(self.source).as_posix(): path.read_bytes()
                                         for path in self.source.rglob("*") if path.is_file()})
        target = self.output / "engines"
        rewrite = json.loads((target / "colmap/provenance/embedded-prefix-rewrites.json").read_text())
        self.assertEqual(rewrite["files"][0]["final_signed_sha256"], sha256(target / "colmap/lib/library.dylib"))
        relocation = json.loads((target / "colmap/provenance/relocation-map.json").read_text())
        for item in relocation:
            self.assertEqual(item["packaged_sha256"], sha256(target / item["packaged_path"]))
        sbom = json.loads((target / "colmap/provenance/sbom.spdx.json").read_text())
        self.assertEqual(len(sbom["files"]), 2)
        for item in sbom["files"]:
            self.assertEqual(item["checksums"][0]["checksumValue"], sha256(target / "colmap" / item["fileName"]))
        source_status = json.loads((self.source.parent / "release-status.json").read_text())
        final_status = json.loads((self.output / "release-status.json").read_text())
        self.assertEqual(final_status["engines"], source_status["engines"])
        self.assertEqual(final_status["blockers"], source_status["blockers"])
        self.assertEqual(final_status["manifest_sha256"], result["manifest_sha256"])
        self.assertEqual((self.output / "source-evidence/engine-manifest.json").read_bytes(), original_files["engine-manifest.json"])
        self.assertTrue(json.loads((self.output / "engine-signing.json").read_text())["source_preserved_and_reverified"])
        self.assertIn("/lib/", str(self.signed_order[0][1][-1]))
        for _, argv in self.signed_order:
            self.assertNotIn("--deep", argv)
            self.assertIn("--timestamp", argv)
            self.assertEqual("--options" in argv, "/bin/" in str(argv[-1]))

    def test_tampered_source_or_manifest_is_never_rehashed_into_trusted_input(self):
        (self.source / "brush/bin/brush").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.derive()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.signed_order, [])

    def test_wrong_pinned_manifest_and_status_are_rejected(self):
        for field in ["expected_source_manifest_sha256", "expected_source_release_status_sha256"]:
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "pinned fingerprint"):
                self.derive(**{field: "0" * 64})
        self.assertEqual(self.signed_order, [])

    def test_symlink_and_existing_destination_are_rejected(self):
        (self.source / "undeclared-link").symlink_to(self.source / "brush")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.derive()
        (self.source / "undeclared-link").unlink()
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.derive()

    def test_modified_unsigned_file_during_signing_is_rejected(self):
        original_execute = self.execute
        def mutate(argv, **kwargs):
            if "--sign" in argv:
                path = Path(argv[-1])
                pack = path.parents[2]
                (pack / "brush/licenses/LICENSE").write_text("corrupted notice")
            return original_execute(argv, **kwargs)
        self.execute = mutate
        with self.assertRaisesRegex(ValueError, "unsigned file mutation"):
            self.derive()
        self.assertFalse(self.output.exists())

    def test_source_mutation_while_signing_prevents_publication(self):
        original_execute = self.execute
        def mutate(argv, **kwargs):
            result = original_execute(argv, **kwargs)
            if "--sign" in argv:
                (self.source / "brush/bin/brush").write_text("source changed concurrently")
            return result
        self.execute = mutate
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.derive()
        self.assertFalse(self.output.exists())

    def test_status_cannot_silently_clear_license_blockers(self):
        status_path = self.source.parent / "release-status.json"
        status = json.loads(status_path.read_text())
        status["engines"]["brush"]["issue_count"] = 1
        write_json(status_path, status)
        with self.assertRaisesRegex(ValueError, "license evidence"):
            self.derive(expected_source_release_status_sha256=sha256(status_path))


if __name__ == "__main__":
    unittest.main()
