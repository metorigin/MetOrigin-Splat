"""Regression checks for unsafe paths, missing closure, OS mismatch and tampering."""

import json
import importlib.util
import hashlib
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pack_macos import (MachO, disable_embedded_prefixes, inspect_macho, parse_load_commands, resolve_dependency,
                        safe_pack_path, sha256, verify_pack, version_tuple)
from pack_brush_licenses import is_notice_file, reuse_verified_notices, target_packages
from pack_spdx import spdx_expression


LOAD_COMMANDS = """binary:
Load command 0
          cmd LC_BUILD_VERSION
      cmdsize 32
     platform 1
        minos 15.0
          sdk 27.0
Load command 1
          cmd LC_ID_DYLIB
      cmdsize 80
         name @rpath/libself.dylib (offset 24)
Load command 2
          cmd LC_LOAD_DYLIB
      cmdsize 80
         name @rpath/libreal.dylib (offset 24)
Load command 3
          cmd LC_RPATH
      cmdsize 80
         path /a path/with spaces/lib (offset 12)
"""


def runtime_prefix_spec(path, prefix, fields):
    return {
        "schema_version": 2,
        "prefix": {"byte_length": len(prefix), "sha256": hashlib.sha256(prefix).hexdigest()},
        "files": [{
            "name": path.name,
            "source_sha256": sha256(path),
            "fields": [{"offset": offset, "byte_length": len(literal),
                        "sha256": hashlib.sha256(literal).hexdigest(), "prefix_offsets": positions}
                       for offset, literal, positions in fields],
        }],
    }


class MachOTests(unittest.TestCase):
    def test_embedded_runtime_defaults_are_disabled_without_changing_offsets(self):
        with tempfile.TemporaryDirectory() as temporary:
            prefix = Path(temporary) / "original-development-prefix"
            path = Path(temporary) / "binary"
            diagnostic = b"compiler --prefix=" + str(prefix).encode() + b"\0after"
            original = b"before\0" + str(prefix).encode() + b"/lib/plugins\0" + diagnostic
            path.write_bytes(original)
            literal = str(prefix).encode() + b"/lib/plugins"
            spec = runtime_prefix_spec(path, str(prefix).encode(), [(7, literal, [0])])
            records = disable_embedded_prefixes(path, spec)
            self.assertEqual(len(path.read_bytes()), len(original))
            self.assertNotIn(str(prefix).encode(), path.read_bytes()[7:7 + len(literal)])
            self.assertTrue(path.read_bytes().endswith(b"/lib/plugins\0" + diagnostic))
            self.assertEqual(len(records["fields"]), 1)
            with self.assertRaisesRegex(ValueError, "exact source binary"):
                disable_embedded_prefixes(path, spec)

    def test_runtime_prefix_offsets_preserve_xml_and_multiple_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binary"
            prefix = b"/private/synthetic-build-prefix"
            first = b"<config>"
            middle = b"/etc/fonts:"
            literal = first + prefix + middle + prefix + b"/share/fonts</config>"
            diagnostic = b"compiler --prefix=" + prefix + b"\0after"
            original = b"before\0" + literal + b"\0" + diagnostic
            path.write_bytes(original)
            positions = [len(first), len(first) + len(prefix) + len(middle)]
            spec = runtime_prefix_spec(path, prefix, [(7, literal, positions)])
            records = disable_embedded_prefixes(path, spec)
            replacement = b"/__metorigin_disabled__/" + b"x" * (len(prefix) - len(b"/__metorigin_disabled__/"))
            expected = first + replacement + middle + replacement + b"/share/fonts</config>"
            self.assertEqual(path.read_bytes(), b"before\0" + expected + b"\0" + diagnostic)
            self.assertEqual(records["fields"][0]["replacement_literal"], expected.decode())
            self.assertNotIn("original_literal", records["fields"][0])
            self.assertNotIn(prefix.decode(), json.dumps(spec))

            path.write_bytes(original)
            spec["files"][0]["fields"][0]["prefix_offsets"] = positions[:1]
            with self.assertRaisesRegex(ValueError, "incomplete"):
                disable_embedded_prefixes(path, spec)
            self.assertEqual(path.read_bytes(), original)

    def test_runtime_prefix_hashes_and_bounds_fail_without_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binary"
            prefix = b"/private/synthetic-build-prefix"
            literal = prefix + b"/etc/fonts"
            original = b"before\0" + literal + b"\0after"
            path.write_bytes(original)
            valid = runtime_prefix_spec(path, prefix, [(7, literal, [0])])
            cases = [
                ("source hash", lambda s: s["files"][0].update(source_sha256="0" * 64)),
                ("field hash", lambda s: s["files"][0]["fields"][0].update(sha256="0" * 64)),
                ("prefix hash", lambda s: s["prefix"].update(sha256="0" * 64)),
                ("field outside source", lambda s: s["files"][0]["fields"][0].update(offset=len(original))),
                ("field at zero", lambda s: s["files"][0]["fields"][0].update(offset=0)),
                ("negative length", lambda s: s["files"][0]["fields"][0].update(byte_length=-1)),
                ("missing prefix offset", lambda s: s["files"][0]["fields"][0].update(prefix_offsets=[])),
                ("negative prefix offset", lambda s: s["files"][0]["fields"][0].update(prefix_offsets=[-1])),
                ("prefix outside field", lambda s: s["files"][0]["fields"][0].update(prefix_offsets=[len(literal)])),
                ("overlapping prefix spans", lambda s: s["files"][0]["fields"][0].update(prefix_offsets=[0, 1])),
                ("invalid schema", lambda s: s.update(schema_version=1)),
            ]
            for name, corrupt in cases:
                with self.subTest(name=name):
                    specification = copy.deepcopy(valid)
                    corrupt(specification)
                    with self.assertRaises(ValueError):
                        disable_embedded_prefixes(path, specification)
                    self.assertEqual(path.read_bytes(), original)

    def test_runtime_prefix_fields_require_nul_boundaries_and_no_interior_nul(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binary"
            prefix = b"/private/synthetic-build-prefix"
            for before, suffix, after in [(b"before!", b"/etc/fonts", b"\0after"),
                                           (b"before\0", b"/etc/fonts", b"!after"),
                                           (b"before\0", b"/etc/\0fonts", b"\0after")]:
                with self.subTest(before=before, suffix=suffix, after=after):
                    literal = prefix + suffix
                    original = before + literal + after
                    path.write_bytes(original)
                    specification = runtime_prefix_spec(path, prefix, [(len(before), literal, [0])])
                    with self.assertRaisesRegex(ValueError, "NUL-terminated"):
                        disable_embedded_prefixes(path, specification)
                    self.assertEqual(path.read_bytes(), original)

    def test_invalid_later_runtime_field_leaves_earlier_fields_unmodified(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binary"
            prefix = b"/private/synthetic-build-prefix"
            first, second = prefix + b"/etc/fonts", b"file://" + prefix + b"/etc/catalog"
            original = b"before\0" + first + b"\0" + second + b"\0after"
            path.write_bytes(original)
            specification = runtime_prefix_spec(path, prefix, [(7, first, [0]), (8 + len(first), second, [7])])
            specification["files"][0]["fields"][1]["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "NUL-terminated"):
                disable_embedded_prefixes(path, specification)
            self.assertEqual(path.read_bytes(), original)

    def test_license_operators_preserve_spdx_identifiers_and_parentheses(self):
        self.assertEqual(spdx_expression("LGPL-2.1-or-later or MIT/Apache-2.0"), "LGPL-2.1-or-later OR MIT OR Apache-2.0")
        packages = target_packages("├── sample v1.0.0 (Apache-2.0 OR MIT) AND Unicode-3.0\n└── macro v2.0.0 (proc-macro) MIT\nroot v1.0.0 (/a path/with spaces) Apache-2.0")
        self.assertEqual(packages[("sample", "1.0.0")], "(Apache-2.0 OR MIT) AND Unicode-3.0")
        self.assertEqual(packages[("macro", "2.0.0")], "MIT")
        self.assertEqual(packages[("root", "1.0.0")], "Apache-2.0")

    def test_parse_does_not_treat_dylib_identity_as_dependency(self):
        minimum, deps, rpaths, identity = parse_load_commands(LOAD_COMMANDS)
        self.assertEqual(minimum, "15.0")
        self.assertEqual(deps, ["@rpath/libreal.dylib"])
        self.assertEqual(rpaths, ["/a path/with spaces/lib"])
        self.assertEqual(identity, "@rpath/libself.dylib")

    def test_minimum_os_is_not_sdk_or_library_version(self):
        self.assertEqual(version_tuple("15.0"), version_tuple("15.0.0"))
        with patch("pack_macos.run", side_effect=["arm64", LOAD_COMMANDS.replace("minos 15.0", "minos 15.1")]):
            with self.assertRaisesRegex(ValueError, "exceeds"):
                inspect_macho(Path("file"))

    def test_non_macos_and_unknown_minimum_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "non-macOS"):
            parse_load_commands(LOAD_COMMANDS.replace("platform 1", "platform 2"))
        with self.assertRaisesRegex(ValueError, "one macOS"):
            parse_load_commands(LOAD_COMMANDS.replace("minos 15.0", "unknown 15.0"))

    def test_universal_or_x86_binary_rejected(self):
        with patch("pack_macos.run", return_value="x86_64 arm64"):
            with self.assertRaisesRegex(ValueError, "arm64-only"):
                inspect_macho(Path("fat"))

    def test_unresolved_and_escaping_runtime_dependency_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            allowed = root / "prefix"
            allowed.mkdir()
            outside = root / "outside.dylib"
            outside.write_text("file")
            with self.assertRaisesRegex(ValueError, "escapes"):
                resolve_dependency(str(outside), allowed / "a", allowed / "a", [], [allowed])
            with self.assertRaisesRegex(ValueError, "unresolved dependency"):
                resolve_dependency("@rpath/absent.dylib", allowed / "a", allowed / "a", [], [allowed])


class ReusedNoticeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.previous = root / "previous"
        self.evidence = root / "next"
        self.old_notice = self.previous / "brush/licenses/upstream/LICENSE"
        self.old_notice.parent.mkdir(parents=True)
        self.old_notice.write_text("Exact upstream notice and copyright")
        manifest = self.evidence / "brush/provenance/cargo/manifests/example.toml"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('license = "MIT"')
        self.archive = self.evidence / "brush/provenance/cargo/sources/example.crate"
        self.archive.parent.mkdir(parents=True)
        self.archive.write_bytes(b"locked original source")
        component = {"id": "example-1.0.0", "source": "registry+example", "license_declared": "MIT",
                     "manifest": "provenance/cargo/manifests/example.toml", "manifest_sha256": sha256(manifest),
                     "source_archive": {"path": "provenance/cargo/sources/example.crate", "sha256": sha256(self.archive)},
                     "licenses": []}
        self.audit_path = self.evidence / "brush/provenance/audit.json"
        self.audit_path.write_text(json.dumps({"components": [component], "issues": [
            {"kind": "license_text_missing", "component": component["id"]}]}))
        component["licenses"] = [{"path": "licenses/upstream/LICENSE", "sha256": sha256(self.old_notice),
                                  "url": "https://example.invalid/immutable-commit/LICENSE"}]
        old_audit = self.previous / "brush/provenance/audit.json"
        old_audit.parent.mkdir(parents=True)
        old_audit.write_text(json.dumps({"components": [component]}))
        files = [{"path": path.relative_to(self.previous).as_posix(), "size_bytes": path.stat().st_size,
                  "sha256": sha256(path)} for path in (old_audit, self.old_notice)]
        frozen = self.previous / "engine-manifest.json"
        frozen.write_text(json.dumps({"engines": {"brush": {"files": files}}}))
        self.frozen_hash = sha256(frozen)

    def test_copying_source_implementation_is_not_a_legal_notice(self):
        source = self.evidence / "copying.rs"
        source.write_text("use objc2::Message; // NSCopying implementation")
        self.assertFalse(is_notice_file(source))
        self.assertTrue(is_notice_file(self.old_notice))

    def test_exact_package_notices_preserve_attribution_and_source(self):
        report = reuse_verified_notices(self.previous, self.frozen_hash, self.evidence)
        self.assertEqual(report["issues"], [])
        notice = report["components"][0]["licenses"][0]
        self.assertEqual(notice["reused_from_manifest_sha256"], self.frozen_hash)
        self.assertEqual((self.evidence / "brush" / notice["path"]).read_text(), self.old_notice.read_text())
        self.assertIn("immutable-commit", notice["url"])

    def test_notice_or_current_source_tampering_fails(self):
        self.old_notice.write_text("different notice")
        with self.assertRaisesRegex(ValueError, "frozen manifest"):
            reuse_verified_notices(self.previous, self.frozen_hash, self.evidence)
        self.old_notice.write_text("Exact upstream notice and copyright")
        self.archive.write_bytes(b"modified source")
        with self.assertRaisesRegex(ValueError, "current package evidence changed"):
            reuse_verified_notices(self.previous, self.frozen_hash, self.evidence)

    def test_changed_component_identity_cannot_borrow_old_notice(self):
        audit = json.loads(self.audit_path.read_text())
        audit["components"][0]["license_declared"] = "Apache-2.0"
        self.audit_path.write_text(json.dumps(audit))
        with self.assertRaisesRegex(ValueError, "changed package"):
            reuse_verified_notices(self.previous, self.frozen_hash, self.evidence)
        with self.assertRaisesRegex(ValueError, "manifest identity changed"):
            reuse_verified_notices(self.previous, "0" * 64, self.evidence)


class BrushAuditFinalizationTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("pack_engines", Path(__file__).with_name("pack-engines.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for relative, text in {
            "provenance/cargo/target-tree.txt": "brush-cli v1.0.0 (/test) Apache-2.0",
            "provenance/cargo/manifests/brush.toml": 'name = "brush-cli"',
            "provenance/source.tar": "complete actual patched source",
            "licenses/LICENSE": "original notice",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        digest = sha256(self.root / "provenance/cargo/target-tree.txt")
        self.metadata = {"cargo_lock_sha256": "a" * 64, "target_graph_sha256": digest}
        self.source = {"sha256": sha256(self.root / "provenance/source.tar")}
        self.audit = {"cargo_lock_sha256": "a" * 64, "target_graph_sha256": digest, "issues": [],
            "components": [{"id": "brush-cli-1.0.0", "name": "brush-cli", "version": "1.0.0",
                "source": "workspace", "license_declared": "Apache-2.0",
                "manifest": "provenance/cargo/manifests/brush.toml",
                "manifest_sha256": sha256(self.root / "provenance/cargo/manifests/brush.toml"),
                "source_archive": {"path": "provenance/source.tar"},
                "licenses": [{"path": "licenses/LICENSE", "sha256": sha256(self.root / "licenses/LICENSE")}]}]}
        self.write_audit()

    def write_audit(self):
        (self.root / "provenance/audit.json").write_text(json.dumps(self.audit))

    def test_complete_evidence_binds_delivered_source_and_artifact_graph(self):
        audit = self.module.finalize_brush_audit(self.root, self.metadata, self.source)
        self.assertTrue(audit["release_ready"])
        self.assertEqual(audit["components"][0]["source_archive"]["sha256"], self.source["sha256"])

    def test_remaining_notice_issue_never_becomes_ready(self):
        self.audit["issues"] = [{"kind": "license_text_missing", "component": "brush-cli-1.0.0"}]
        self.write_audit()
        self.assertFalse(self.module.finalize_brush_audit(self.root, self.metadata, self.source)["release_ready"])

    def test_wrong_graph_or_tampered_source_fails_closed(self):
        self.audit["components"] = []
        self.write_audit()
        with self.assertRaisesRegex(ValueError, "actual target graph"):
            self.module.finalize_brush_audit(self.root, self.metadata, self.source)

    def test_wrong_artifact_graph_or_tampered_source_fails_closed(self):
        self.metadata["target_graph_sha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "immutable artifact"):
            self.module.finalize_brush_audit(self.root, self.metadata, self.source)
        del self.metadata["target_graph_sha256"]
        (self.root / "provenance/source.tar").write_text("modified source")
        with self.assertRaisesRegex(ValueError, "evidence changed"):
            self.module.finalize_brush_audit(self.root, self.metadata, self.source)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pack 验证 ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.manifest = {"schema_version": 1, "pack_version": "test", "platform": "macos-arm64", "engines": {}}
        for engine, commands in {"ffmpeg": ["ffmpeg", "ffprobe"], "colmap": ["colmap"], "brush": ["brush"]}.items():
            files = []
            for name in [*commands, "LICENSE"]:
                path = self.root / engine / name
                path.parent.mkdir(exist_ok=True)
                path.write_text(name)
                path.chmod(0o755)
                files.append({"path": str(path.relative_to(self.root)), "sha256": sha256(path), "size_bytes": path.stat().st_size})
            self.manifest["engines"][engine] = {"version": "1", "source_url": "https://example.invalid/source", "source_sha256": "a" * 64,
                "executables": {name: engine + "/" + name for name in commands}, "files": files, "license_files": [engine + "/LICENSE"]}
        self.save()

    def save(self):
        (self.root / "engine-manifest.json").write_text(json.dumps(self.manifest))

    def test_file_tampering_fails_before_execution(self):
        (self.root / "ffmpeg/ffmpeg").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            verify_pack(self.root)

    def test_case_fold_duplicate_rejected(self):
        record = self.manifest["engines"]["ffmpeg"]
        record["files"].append(dict(record["files"][0], path="ffmpeg/FFMPEG"))
        self.save()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            verify_pack(self.root)

    def test_undeclared_file_rejected(self):
        (self.root / "extra").write_text("not hashed")
        with patch("pack_macos.inspect_macho", return_value=MachO("file", "arm64", "15.0", [], [], None)):
            with self.assertRaisesRegex(ValueError, "undeclared"):
                verify_pack(self.root)

    def test_symlinks_and_dot_paths_rejected(self):
        (self.root / "alias").symlink_to(self.root / "ffmpeg")
        for name in ["../outside", "/absolute", "ffmpeg/./LICENSE", "ffmpeg//LICENSE", "alias/LICENSE"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                safe_pack_path(self.root, name)


if __name__ == "__main__":
    unittest.main()
