import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pack_macos

spec = importlib.util.spec_from_file_location("verify_app", Path(__file__).with_name("verify-app.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def ready_status(digest="a" * 64):
    return {
        "schema_version": 1, "manifest_sha256": digest, "distributable": True,
        "distribution_status": "evidence-complete",
        "allowed_use": "subject-to-app-signing-and-acceptance", "blockers": [],
        "engines": {name: {"release_ready": True, "issue_count": 0,
                           "audit_path": name + "/provenance/audit.json"}
                    for name in ("ffmpeg", "colmap", "brush")},
        "acceptance_scope": "Engine evidence only; app acceptance is separate.",
    }


class BuildScriptTests(unittest.TestCase):
    def test_runtime_gates_pin_inputs_and_stop_packaging_on_either_failure(self):
        source = Path(__file__).with_name("build-macos-app.sh").read_text()
        start = source.index('METORIGIN_TEST_ENGINE_PACK="$pack_root/engines"')
        gate = source[start:source.index("\npnpm --dir", start)]
        self.assertLess(start, source.index("pnpm --dir apps/desktop tauri build"))
        for failure_package in ("", "splat-hardware", "splat-desktop"):
            with self.subTest(failure_package=failure_package):
                with tempfile.TemporaryDirectory(prefix="runtime-gate-中文 ") as temporary:
                    exit_code = 23 if failure_package else 0
                    environment = dict(os.environ, work=temporary, pack_root=temporary,
                                       before_manifest="b" * 64, test_failure_package=failure_package)
                    script = '''set -euo pipefail
cargo() {
  printf 'pack=%s\\nmanifest=%s\\n' "$METORIGIN_TEST_ENGINE_PACK" "$METORIGIN_TEST_ENGINE_MANIFEST_SHA256"
  printf '<%s>' "$@"
  printf '\\n'
  if [[ "$6" == "$test_failure_package" ]]; then return 23; fi
  return 0
}
''' + gate + "\nprintf 'packaging-reached\\n'\n"
                    result = subprocess.run(["/bin/bash", "-c", script], env=environment,
                                            capture_output=True, text=True)
                    self.assertEqual(result.returncode, exit_code, result.stderr)
                    self.assertEqual("packaging-reached" in result.stdout, exit_code == 0)
                    recorded = (Path(temporary) / "runtime-engine-locator.log").read_text()
                    self.assertIn("pack=" + temporary + "/engines\n", recorded)
                    self.assertIn("manifest=" + "b" * 64 + "\n", recorded)
                    self.assertIn(
                        "<test><--locked><--target><aarch64-apple-darwin><-p><splat-hardware><--lib>"
                        "<locator::tests::frozen_macos_engine_pack_resolves_without_execution>"
                        "<--><--ignored><--exact><--nocapture>", recorded)
                    application_log = Path(temporary) / "runtime-application-preflight.log"
                    self.assertEqual(application_log.exists(), failure_package != "splat-hardware")
                    if application_log.exists():
                        application = application_log.read_text()
                        self.assertIn("pack=" + temporary + "/engines\n", application)
                        self.assertIn("manifest=" + "b" * 64 + "\n", application)
                        self.assertIn(
                            "<test><--locked><--target><aarch64-apple-darwin><-p><splat-desktop><--lib>"
                            "<commands::system::tests::frozen_macos_engine_pack_passes_application_version_checks>"
                            "<--><--ignored><--exact><--nocapture>", application)


class ReleaseStatusTests(unittest.TestCase):
    def blocked(self):
        status = ready_status()
        status.update(distributable=False, distribution_status="blocked", allowed_use="internal-alpha-validation")
        status["engines"]["brush"].update(release_ready=False, issue_count=1)
        status["blockers"] = [{"engine": "brush", "kind": "missing_notice", "component": "example"}]
        return status

    def test_internal_alpha_requires_an_explicit_option(self):
        with self.assertRaises(ValueError):
            module.verify_release_status(self.blocked(), "a" * 64, False)
        module.verify_release_status(self.blocked(), "a" * 64, True)

    def test_unknown_schema_and_stale_manifest_never_bypass(self):
        for field, value in [("schema_version", 2), ("schema_version", True), ("manifest_sha256", "b" * 64)]:
            status = ready_status()
            status[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                module.verify_release_status(status, "a" * 64, True)

    def test_completed_distribution_requirements_pass(self):
        module.verify_release_status(ready_status(), "a" * 64, False)

    def test_alpha_option_never_bypasses_malformed_status(self):
        for field, value in [("engines", {}), ("distributable", 0), ("blockers", []),
                             ("allowed_use", "subject-to-app-signing-and-acceptance"),
                             ("acceptance_scope", ""), ("blockers", [{"engine": "brush", "kind": ""}])]:
            status = self.blocked()
            status[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                module.verify_release_status(status, "a" * 64, True)
        for field, value in [("audit_path", "../audit.json"), ("issue_count", True), ("release_ready", 0)]:
            status = self.blocked()
            status["engines"]["brush"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                module.verify_release_status(status, "a" * 64, True)

    def test_distributable_boolean_cannot_override_known_blockers(self):
        status = ready_status()
        status["blockers"] = [{"engine": "brush", "kind": "missing_notice"}]
        with self.assertRaises(ValueError):
            module.verify_release_status(status, "a" * 64, True)
        status = self.blocked()
        status["distributable"] = True
        with self.assertRaises(ValueError):
            module.verify_release_status(status, "a" * 64, False)


class BundleVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="metorigin-app-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.app = self.root / "中文 空格" / "MetOrigin Splat.app"
        self.resources = self.app / "Contents/Resources/resources"
        self.engines = self.resources / "engines"
        executable = self.app / "Contents/MacOS/MetOrigin Splat"
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"application signed bytes")
        executable.chmod(0o755)
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "com.metorigin.splat", "CFBundleExecutable": "MetOrigin Splat",
            "LSMinimumSystemVersion": "15.0",
        }))
        manifest = {"schema_version": 1, "pack_version": "test", "platform": "macos-arm64", "engines": {}}
        for engine, programs in {"ffmpeg": ["ffmpeg", "ffprobe"], "colmap": ["colmap"], "brush": ["brush"]}.items():
            files = {engine + "/licenses/LICENSE": b"test license",
                     engine + "/provenance/audit.json": json.dumps({"release_ready": True, "issues": []}).encode()}
            files.update({engine + "/bin/" + name: b"engine signed bytes" for name in programs})
            entries = []
            for relative, contents in files.items():
                path = self.engines / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(contents)
                path.chmod(0o755 if "/bin/" in relative else 0o644)
                entries.append({"path": relative, "size_bytes": len(contents), "sha256": module.sha256(path)})
            manifest["engines"][engine] = {
                "version": "test", "source_url": "https://example.invalid/source", "source_sha256": "a" * 64,
                "executables": {name: engine + "/bin/" + name for name in programs}, "files": entries,
                "license_files": [engine + "/licenses/LICENSE"],
            }
        self.manifest = self.engines / "engine-manifest.json"
        self.manifest.write_text(json.dumps(manifest))
        self.status_path = self.resources / "release-status.json"
        self.status_path.write_text(json.dumps(ready_status(module.sha256(self.manifest))))
        self.app_licenses = self.resources / "app-licenses"
        self.app_licenses.mkdir()
        for filename, contents in {
            "SBOM.cdx.json": {"bomFormat": "CycloneDX"}, "dependency-license-index.json": [],
            "release-readiness.json": {"schema_version": 1, "platform": "macos-arm64", "release_ready": True, "issues": []},
            "LICENSE": "Original dependency notice",
        }.items():
            (self.app_licenses / filename).write_text(json.dumps(contents))
        self.refresh_license_manifest()
        binary = pack_macos.MachO("test", "arm64", "15.0", ["/usr/lib/libSystem.B.dylib"], [], None)
        for target, attribute in [(module, "inspect_macho"), (pack_macos, "inspect_macho")]:
            mocked = patch.object(target, attribute, return_value=binary)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.commands = patch.object(module, "run", return_value="")
        self.run = self.commands.start()
        self.addCleanup(self.commands.stop)

    def refresh_license_manifest(self):
        files = [{"path": path.relative_to(self.app_licenses).as_posix(), "size_bytes": path.stat().st_size, "sha256": module.sha256(path)}
                 for path in sorted(self.app_licenses.rglob("*")) if path.is_file() and path != self.app_licenses / "manifest.json"]
        (self.app_licenses / "manifest.json").write_text(json.dumps({"schema_version": 1, "platform": "macos-arm64", "files": files}))

    def frontend_receipt(self):
        overlay_path = self.app_licenses / "vendored/webp/manifest.json"
        overlay_path.parent.mkdir(parents=True)
        overlay = {"id": "derived-test", "build_evidence_sha256": "b" * 64}
        overlay_path.write_text(json.dumps(overlay))
        identity = {"id": overlay["id"], "build_evidence_sha256": overlay["build_evidence_sha256"],
                    "manifest_sha256": module.sha256(overlay_path)}
        build = {"signature": "a" * 64, "webp_overlay": identity,
                 "assets": [{"path": "index.js", "sha256": "c" * 64, "size_bytes": 4}]}
        build_path = self.app_licenses / "supersplat/build.json"
        build_path.parent.mkdir()
        build_path.write_text(json.dumps(build))
        report = {"schema_version": 1, "dist_verified": True, "scope": "Prepared public and exact dist inputs; no binary extraction claim.",
                  "input_identity": {"signature": build["signature"], "webp_overlay": identity,
                                     "build_json_sha256": module.sha256(build_path), "assets": build["assets"]}}
        report_path = self.root / "frontend-inputs.json"
        report_path.write_text(json.dumps(report))
        self.refresh_license_manifest()
        return report_path

    def test_derived_application_requires_frontend_receipt_but_standalone_check_does_not(self):
        # Semantic WebP validation has its own real-evidence tests. Isolate the
        # application's obligation to require the independent dist-build receipt.
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}):
            module.verify_app_license_evidence(self.app_licenses)
            with self.assertRaisesRegex(ValueError, "requires --frontend-input-report"):
                module.verify_app(self.app, internal_alpha=True)
            self.run.assert_not_called()

    def test_frontend_receipt_binds_exact_inputs_and_requires_dist(self):
        path = self.frontend_receipt()
        original = json.loads(path.read_text())
        valid = module.verify_frontend_input_report(self.app_licenses, path, True)
        self.assertEqual(valid["report_sha256"], module.sha256(path))
        for change in ("dist", "build", "signature", "assets", "overlay", "schema"):
            data = json.loads(json.dumps(original))
            if change == "dist": data["dist_verified"] = False
            elif change == "build": data["input_identity"]["build_json_sha256"] = "d" * 64
            elif change == "signature": data["input_identity"]["signature"] = "d" * 64
            elif change == "assets": data["input_identity"]["assets"] = []
            elif change == "overlay": data["input_identity"]["webp_overlay"]["manifest_sha256"] = "d" * 64
            else: data["schema_version"] = True
            path.write_text(json.dumps(data))
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.verify_frontend_input_report(self.app_licenses, path, True)

    def test_frontend_receipt_is_bound_through_app_and_dmg_reports(self):
        path = self.frontend_receipt()
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}):
            report = module.verify_app(self.app, frontend_input_report=path)
            self.assertEqual(report["frontend_input_evidence"]["report_sha256"], module.sha256(path))
            dmg = self.root / "derived.dmg"
            dmg.write_bytes(b"test disk image")
            self.run.side_effect = self.fake_mount
            self.assertTrue(module.verify_dmg(dmg, self.app, report, frontend_input_report=path)["application_matches_verified_bundle"])
            changed = json.loads(path.read_text())
            changed["scope"] += " changed receipt"
            path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError, "DMG frontend input evidence differs"):
                module.verify_dmg(dmg, self.app, report, frontend_input_report=path)

    def test_frontend_receipt_mutation_during_signature_check_fails(self):
        path = self.frontend_receipt()
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}):
            self.run.side_effect = lambda _args: path.write_text(path.read_text() + "\n")
            with self.assertRaisesRegex(ValueError, "frontend input report changed"):
                module.verify_app(self.app, frontend_input_report=path)

    def test_application_license_evidence_is_mandatory_and_hashed(self):
        (self.app_licenses / "LICENSE").write_text("modified notice")
        with self.assertRaisesRegex(ValueError, "application license file size/hash mismatch"):
            module.verify_app(self.app, internal_alpha=True)

    def test_application_license_unresolved_evidence_requires_alpha_option(self):
        path = self.app_licenses / "release-readiness.json"
        data = json.loads(path.read_text())
        data.update(release_ready=False, issues=[{"id": "missing-notice", "detail": "Original notice unavailable"}])
        path.write_text(json.dumps(data))
        self.refresh_license_manifest()
        with self.assertRaisesRegex(ValueError, "application license evidence has unresolved"):
            module.verify_app(self.app)
        report = module.verify_app(self.app, internal_alpha=True)
        self.assertFalse(report["application_license_evidence"]["release_ready"])
        self.assertEqual(report["application_license_evidence"]["issues"], data["issues"])

    def test_application_license_readiness_cannot_override_issues(self):
        path = self.app_licenses / "release-readiness.json"
        data = json.loads(path.read_text())
        data["issues"] = [{"id": "missing-notice", "detail": "Original notice unavailable"}]
        path.write_text(json.dumps(data))
        self.refresh_license_manifest()
        with self.assertRaisesRegex(ValueError, "invalid application license readiness"):
            module.verify_app(self.app, internal_alpha=True)

    def test_application_license_files_cannot_be_added_or_replaced_with_symlinks(self):
        extra = self.app_licenses / "extra"
        extra.write_text("undeclared")
        with self.assertRaisesRegex(ValueError, "missing or undeclared"):
            module.verify_app(self.app)
        extra.unlink()
        license_path = self.app_licenses / "LICENSE"
        copied = self.resources / "license-outside-evidence"
        license_path.rename(copied)
        license_path.symlink_to(copied)
        with self.assertRaises(ValueError):
            module.verify_app(self.app)

    def test_valid_bundle_hashes_and_signatures_are_reported(self):
        report = module.verify_app(self.app, expected_manifest_sha256=module.sha256(self.manifest))
        self.assertTrue(report["engine_distribution_requirements_met"])
        self.assertFalse(report["notarization_verified"])
        self.assertFalse(report["application_public_release_ready"])
        self.assertEqual(report["bundle_inventory_sha256"], module.inventory_sha256(module.bundle_inventory(self.app)))
        self.run.assert_called_once_with(["/usr/bin/codesign", "--verify", "--deep", "--strict", self.app])

    def test_post_signing_engine_mutation_cannot_rewrite_manifest(self):
        old_manifest = self.manifest.read_bytes()
        (self.engines / "brush/bin/brush").write_bytes(b"engine re-signed bytes")
        with self.assertRaisesRegex(ValueError, "file size/hash mismatch"):
            module.verify_app(self.app)
        self.assertEqual(self.manifest.read_bytes(), old_manifest)
        self.run.assert_not_called()

    def test_stale_embedded_manifest_or_status_fails(self):
        for kwargs in [{"expected_manifest_sha256": "0" * 64}, {"expected_status_sha256": "0" * 64}]:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "selected frozen engine pack"):
                module.verify_app(self.app, **kwargs)

    def test_external_engine_directory_symlink_fails_before_pack_tools(self):
        outside = self.root / "outside-engines"
        self.engines.rename(outside)
        self.engines.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink escapes"):
            module.verify_app(self.app)
        self.run.assert_not_called()

    def test_critical_path_symlink_inside_bundle_is_rejected(self):
        status_copy = self.resources / "status-copy.json"
        self.status_path.rename(status_copy)
        self.status_path.symlink_to(status_copy.name)
        with self.assertRaisesRegex(ValueError, "critical bundle path is a symlink"):
            module.verify_app(self.app)

    def test_internal_framework_symlinks_are_allowed_but_hash_tracked(self):
        framework = self.app / "Contents/Frameworks/Example.framework"
        (framework / "Versions/A").mkdir(parents=True)
        (framework / "Versions/A/resource").write_text("resource")
        (framework / "Versions/Current").symlink_to("A", target_is_directory=True)
        before = module.bundle_inventory(self.app)
        (framework / "Versions/A/resource").write_text("changed")
        self.assertNotEqual(module.bundle_inventory(self.app), before)
        self.assertEqual(before["Contents/Frameworks/Example.framework/Versions/Current"]["target"], "A")

    def test_status_blockers_must_equal_hashed_audits(self):
        audit_path = self.engines / "brush/provenance/audit.json"
        audit_path.write_text(json.dumps({"release_ready": False, "issues": [{"kind": "missing_notice", "component": "original"}]}))
        manifest = json.loads(self.manifest.read_text())
        entry = next(e for e in manifest["engines"]["brush"]["files"] if e["path"].endswith("audit.json"))
        entry.update(size_bytes=audit_path.stat().st_size, sha256=module.sha256(audit_path))
        self.manifest.write_text(json.dumps(manifest))
        status = ReleaseStatusTests().blocked()
        status["manifest_sha256"] = module.sha256(self.manifest)
        self.status_path.write_text(json.dumps(status))
        with self.assertRaisesRegex(ValueError, "blockers disagree"):
            module.verify_app(self.app, internal_alpha=True)

    def test_signature_failure_is_not_reported_as_success(self):
        self.run.side_effect = ValueError("invalid final signature")
        with self.assertRaisesRegex(ValueError, "invalid final signature"):
            module.verify_app(self.app)

    def test_mutation_during_signature_verification_fails(self):
        self.run.side_effect = lambda _args: (self.app / "Contents/new-file").write_text("changed")
        with self.assertRaisesRegex(ValueError, "changed during verification"):
            module.verify_app(self.app)

    def fake_mount(self, args, mutate=False):
        if args[1] == "attach":
            mount = args[args.index("-mountpoint") + 1]
            shutil.copytree(self.app, mount / self.app.name)
            if mutate:
                (mount / self.app.name / "Contents/extra").write_text("stale or modified bundle")
        return ""

    def test_dmg_mount_verifies_exact_application_and_detaches(self):
        report = module.verify_app(self.app)
        dmg = self.root / "fresh.dmg"
        dmg.write_bytes(b"test disk image")
        self.run.side_effect = self.fake_mount
        result = module.verify_dmg(dmg, self.app, report)
        self.assertTrue(result["application_matches_verified_bundle"])
        commands = [call.args[0] for call in self.run.call_args_list]
        self.assertIn("-readonly", next(command for command in commands if command[1] == "attach"))
        self.assertEqual(commands[-1][1], "detach")

    def test_dmg_difference_fails_and_still_detaches(self):
        report = module.verify_app(self.app)
        dmg = self.root / "stale.dmg"
        dmg.write_bytes(b"test disk image")
        self.run.side_effect = lambda args: self.fake_mount(args, mutate=True)
        with self.assertRaisesRegex(ValueError, "differs from the verified source"):
            module.verify_dmg(dmg, self.app, report)
        self.assertEqual(self.run.call_args_list[-1].args[0][1], "detach")

    def test_dmg_cannot_accept_changed_source_after_app_verification(self):
        report = module.verify_app(self.app)
        dmg = self.root / "fresh.dmg"
        dmg.write_bytes(b"test disk image")
        (self.app / "Contents/new").write_text("changed")
        self.run.reset_mock()
        with self.assertRaisesRegex(ValueError, "changed after verification"):
            module.verify_dmg(dmg, self.app, report)
        self.run.assert_not_called()

    def test_packaging_must_match_initial_signed_application_report(self):
        report = module.verify_app(self.app)
        module.verify_app_report_matches(report, report)
        for field in ("application_sha256", "bundle_inventory_sha256"):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "differs from initial verification"):
                    module.verify_app_report_matches(dict(report, **{field: "0" * 64}), report)
                with self.assertRaisesRegex(ValueError, "invalid expected application report"):
                    module.verify_app_report_matches(report, dict(report, **{field: None}))

    def test_dmg_cannot_accept_source_mutation_while_mounted(self):
        report = module.verify_app(self.app)
        dmg = self.root / "fresh.dmg"
        dmg.write_bytes(b"test disk image")

        def mount_then_change_source(args):
            result = self.fake_mount(args)
            if args[1] == "detach":
                (self.app / "Contents/new").write_text("source changed during mount")
            return result

        self.run.side_effect = mount_then_change_source
        with self.assertRaisesRegex(ValueError, "source application changed during DMG verification"):
            module.verify_dmg(dmg, self.app, report)
        self.assertEqual(self.run.call_args_list[-1].args[0][1], "detach")


if __name__ == "__main__":
    unittest.main()
