import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
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
        # The build now clears Tauri's ambient Apple credentials explicitly;
        # stop before that env invocation, while executing both real gates.
        gate = source[start:source.index("\nenv -u APPLE_SIGNING_IDENTITY ", start)]
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


class NotarizationTests(unittest.TestCase):
    def test_container_cli_requires_dmg_and_team_and_cannot_override_strict_mode(self):
        for options in [["--require-notarized-container"],
                        ["--require-notarized-container", "--dmg", "/tmp/app.dmg"],
                        ["--require-notarized-container", "--expected-team-id", "ABCDEFGHIJ"],
                        ["--require-notarized-container", "--require-notarized", "--dmg", "/tmp/app.dmg",
                         "--expected-team-id", "ABCDEFGHIJ"]]:
            with self.subTest(options=options), patch("sys.argv", ["verify-app.py", "/tmp/app.app"] + options), \
                    patch.object(module, "verify_app") as app_check, patch("sys.stderr"):
                with self.assertRaises(SystemExit) as stopped:
                    module.main()
                self.assertEqual(stopped.exception.code, 2)
                app_check.assert_not_called()

    def test_checks_require_team_identity_and_reject_invalid_identifiers(self):
        for options in [(None, None, True), (None, "a" * 40, False),
                        ("invalid", None, False), ("ABCDEFGHIJ", "not-a-fingerprint", False)]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                module.validate_signing_options(*options)
        module.validate_signing_options("ABCDEFGHIJ", "a" * 40, True)

    def test_stapled_ticket_and_gatekeeper_notarized_source_are_both_required(self):
        accepted = SimpleNamespace(returncode=0, stdout="", stderr="/tmp/test.app: accepted\nsource=Notarized Developer ID\n")
        valid_ticket = SimpleNamespace(returncode=0, stdout="The validate action worked!", stderr="")
        with patch.object(module.subprocess, "run", side_effect=[valid_ticket, accepted]) as command:
            result = module.verify_notarization(Path("/tmp/test.app"), "app")
        self.assertTrue(result["stapled_ticket_validated"])
        self.assertTrue(result["gatekeeper_accepted"])
        self.assertIn("--type", command.call_args.args[0])
        self.assertIn("execute", command.call_args.args[0])
        for output in ["assessments disabled", "/tmp/test.app: accepted\nsource=Developer ID",
                       "/tmp/test.app: rejected\nsource=Notarized Developer ID"]:
            weak = SimpleNamespace(returncode=0, stdout=output, stderr="")
            with self.subTest(output=output), patch.object(module.subprocess, "run", side_effect=[valid_ticket, weak]):
                with self.assertRaisesRegex(ValueError, "Gatekeeper did not identify"):
                    module.verify_notarization(Path("/tmp/test.app"), "app")

    def test_dmg_gatekeeper_assessment_uses_primary_signature_context(self):
        def assessment(command):
            return {"command": [str(part) for part in command], "exit_code": 0, "stdout": "",
                    "stderr": "/tmp/test.dmg: accepted\nsource=Notarized Developer ID"}
        with patch.object(module, "run_assessment", side_effect=assessment) as check:
            module.verify_notarization(Path("/tmp/test.dmg"), "dmg")
        gatekeeper = check.call_args.args[0]
        self.assertEqual(gatekeeper[gatekeeper.index("--type") + 1], "open")
        self.assertEqual(gatekeeper[gatekeeper.index("--context") + 1], "context:primary-signature")

    def test_missing_ticket_or_gatekeeper_failure_never_reports_success(self):
        for responses in [[SimpleNamespace(returncode=65, stdout="", stderr="ticket missing")],
                          [SimpleNamespace(returncode=0, stdout="valid ticket", stderr=""),
                           SimpleNamespace(returncode=3, stdout="", stderr="rejected")]]:
            with self.subTest(responses=responses), patch.object(module.subprocess, "run", side_effect=responses):
                with self.assertRaisesRegex(ValueError, "assessment failed"):
                    module.verify_notarization(Path("/tmp/test.app"), "app")
        with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired("spctl", 120)):
            with self.assertRaisesRegex(ValueError, "timed out"):
                module.verify_notarization(Path("/tmp/test.app"), "app")


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

    @staticmethod
    def signed_evidence(path, team_id, require_runtime=False, expected_identity=None):
        return {"team_id": team_id, "authorities": ["Developer ID Application: Test (" + team_id + ")"],
                "timestamp": "Nov 1, 2026 at 12:00:00", "hardened_runtime": require_runtime,
                "requirement_verified": True, "identity_sha1": expected_identity.upper() if expected_identity else None}

    def test_developer_id_checks_outer_runtime_and_every_embedded_code_file(self):
        framework = self.app / "Contents/Frameworks/Example.framework/Versions/A/Example"
        framework.parent.mkdir(parents=True)
        framework.write_bytes(b"\xcf\xfa\xed\xfeadditional framework code")
        before = module.bundle_inventory(self.app)
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence) as verify:
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", expected_signing_identity="a" * 40)
        self.assertEqual(module.bundle_inventory(self.app), before)
        self.assertFalse(report["application_public_release_ready"])
        self.assertFalse(report["notarization_verified"])
        self.assertEqual(report["developer_id_verification"]["nested_code_count"], 5)
        self.assertEqual(verify.call_args_list[0].args, (self.app, "ABCDEFGHIJ"))
        self.assertTrue(verify.call_args_list[0].kwargs["require_runtime"])
        verified_paths = {call.args[0] for call in verify.call_args_list}
        self.assertIn(framework, verified_paths)
        for path in ["ffmpeg/bin/ffmpeg", "ffmpeg/bin/ffprobe", "colmap/bin/colmap", "brush/bin/brush"]:
            self.assertIn(self.engines / path, verified_paths)
            call = next(call for call in verify.call_args_list if call.args[0] == self.engines / path)
            self.assertTrue(call.kwargs["require_runtime"])
        framework_call = next(call for call in verify.call_args_list if call.args[0] == framework)
        self.assertFalse(framework_call.kwargs["require_runtime"])
        self.assertTrue(all(call.kwargs["expected_identity"] == "a" * 40 for call in verify.call_args_list))

    def test_developer_id_rejects_nested_signature_failure_before_notarization(self):
        def verify(path, *args, **kwargs):
            if path == self.engines / "brush/bin/brush":
                raise ValueError("nested code signed by another team")
            return self.signed_evidence(path, *args, **kwargs)
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=verify), \
                patch.object(module, "verify_notarization") as notarize:
            with self.assertRaisesRegex(ValueError, "another team"):
                module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)
        notarize.assert_not_called()

    def test_formal_signature_never_bypasses_unresolved_application_licenses(self):
        path = self.app_licenses / "release-readiness.json"
        data = json.loads(path.read_text())
        data.update(release_ready=False, issues=[{"id": "notice", "detail": "Original notice pending"}])
        path.write_text(json.dumps(data))
        self.refresh_license_manifest()
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence):
            with self.assertRaisesRegex(ValueError, "license evidence has unresolved"):
                module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)
            report = module.verify_app(self.app, internal_alpha=True, expected_team_id="ABCDEFGHIJ")
        self.assertFalse(report["application_license_evidence"]["release_ready"])
        self.assertFalse(report["application_public_release_ready"])

    def test_notarization_requires_explicit_checks_and_detects_mutation(self):
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence), \
                patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True}) as check:
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)
        check.assert_called_once_with(self.app, "app")
        self.assertTrue(report["notarization_verified"])
        self.assertFalse(report["application_public_release_ready"])
        def mutate(path, kind):
            (path / "Contents/mutated-during-assessment").write_text("changed")
            return {"stapled_ticket_validated": True}
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence), \
                patch.object(module, "verify_notarization", side_effect=mutate):
            with self.assertRaisesRegex(ValueError, "changed during verification"):
                module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)

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

    def test_final_stapled_app_and_dmg_remain_exact_without_inventory_exemptions(self):
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence), \
                patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True}) as notarize:
            before_staple = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ")
            # A final inventory is established after stapling. Existing report
            # comparison still rejects every byte change, including a ticket.
            (self.app / "Contents/CodeResources").write_bytes(b"test notarization ticket")
            final = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)
            with self.assertRaisesRegex(ValueError, "differs from initial verification"):
                module.verify_app_report_matches(final, before_staple)
            dmg = self.root / "notarized.dmg"
            dmg.write_bytes(b"signed and stapled disk image")
            self.run.side_effect = self.fake_mount
            result = module.verify_dmg(dmg, self.app, final)
        self.assertTrue(result["notarization_verified"])
        self.assertEqual(result["notarization_policy"], module.NOTARIZATION_STRICT)
        self.assertTrue(result["embedded_application_notarization"]["stapled_ticket_required"])
        self.assertTrue(result["embedded_application_notarization"]["stapled_ticket_validated"])
        self.assertTrue(result["application_matches_verified_bundle"])
        self.assertEqual([call.args[1] for call in notarize.call_args_list], ["app", "dmg", "app"])

    def test_notarized_container_keeps_exact_signed_app_without_app_ticket_requirement(self):
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence) as signature:
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", expected_signing_identity="a" * 40)
            before = module.bundle_inventory(self.app)
            dmg = self.root / "outermost-notarized.dmg"
            dmg.write_bytes(b"signed and stapled container")
            self.run.side_effect = self.fake_mount
            with patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True,
                                                                           "gatekeeper_accepted": True}) as notarize:
                result = module.verify_dmg(dmg, self.app, report, require_notarized_container=True)
        notarize.assert_called_once_with(dmg, "dmg")
        self.assertFalse(report["notarization_verified"])
        self.assertFalse(report["application_notarization"]["stapled_ticket_validated"])
        self.assertEqual(result["notarization_policy"], module.NOTARIZATION_CONTAINER)
        self.assertTrue(result["notarization_verified"])
        embedded = result["embedded_application_notarization"]
        self.assertTrue(embedded["developer_id_verified"])
        self.assertFalse(embedded["stapled_ticket_required"])
        self.assertFalse(embedded["stapled_ticket_validated"])
        self.assertFalse(embedded["gatekeeper_assessment_performed"])
        self.assertEqual(module.bundle_inventory(self.app), before)
        self.assertFalse(report["application_public_release_ready"])
        # Main bundle, signed container and all four mounted engine executable
        # signatures are still explicitly checked under the expected identity.
        self.assertIn(dmg, {call.args[0] for call in signature.call_args_list})
        mounted_engines = [call for call in signature.call_args_list
                           if call.args[0].name in {"ffmpeg", "ffprobe", "colmap", "brush"}
                           and not call.args[0].is_relative_to(self.app)]
        self.assertEqual(len(mounted_engines), 4)
        self.assertTrue(all(call.kwargs["require_runtime"] for call in mounted_engines))

    def test_container_notarization_still_requires_dmg_ticket_and_nested_signatures(self):
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence):
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ")
            dmg = self.root / "outermost.dmg"
            dmg.write_bytes(b"signed disk image")
            self.run.side_effect = self.fake_mount
            with patch.object(module, "verify_notarization", side_effect=ValueError("DMG ticket missing")):
                with self.assertRaisesRegex(ValueError, "DMG ticket missing"):
                    module.verify_dmg(dmg, self.app, report, require_notarized_container=True)
            def signature(path, *args, **kwargs):
                if path.name == "brush" and not path.is_relative_to(self.app):
                    raise ValueError("embedded executable belongs to another team")
                return self.signed_evidence(path, *args, **kwargs)
            with patch.object(pack_macos, "verify_developer_id_signature", side_effect=signature), \
                    patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True}):
                with self.assertRaisesRegex(ValueError, "another team"):
                    module.verify_dmg(dmg, self.app, report, require_notarized_container=True)
            self.assertEqual(self.run.call_args_list[-1].args[0][1], "detach")

    def test_container_policy_does_not_weaken_strict_app_ticket_checks(self):
        def container_only(path, kind):
            if kind == "app":
                raise ValueError("app own ticket missing")
            return {"stapled_ticket_validated": True, "gatekeeper_accepted": True}
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence):
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ")
            dmg = self.root / "container.dmg"
            dmg.write_bytes(b"signed and stapled disk image")
            self.run.side_effect = self.fake_mount
            with patch.object(module, "verify_notarization", side_effect=container_only):
                with self.assertRaisesRegex(ValueError, "app own ticket missing"):
                    module.verify_dmg(dmg, self.app, report, require_notarized=True)
                self.assertTrue(module.verify_dmg(dmg, self.app, report,
                                                  require_notarized_container=True)["notarization_verified"])
            with patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True}):
                strict = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", require_notarized=True)
            with self.assertRaisesRegex(ValueError, "cannot replace an explicit stapled-application"):
                module.verify_dmg(dmg, self.app, strict, require_notarized_container=True)

    def test_container_cli_reports_distribution_and_app_ticket_evidence_separately(self):
        dmg = self.root / "container-cli.dmg"
        dmg.write_bytes(b"signed and stapled container")
        self.run.side_effect = self.fake_mount
        output = self.root / "container-report.json"
        arguments = ["verify-app.py", str(self.app), "--expected-team-id", "ABCDEFGHIJ",
                     "--dmg", str(dmg), "--require-notarized-container", "--report", str(output)]
        with patch("sys.argv", arguments), patch("builtins.print"), \
                patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence), \
                patch.object(module, "verify_notarization", return_value={"stapled_ticket_validated": True,
                                                                          "gatekeeper_accepted": True}):
            module.main()
        report = json.loads(output.read_text())
        self.assertEqual(report["distribution_notarization_policy"], module.NOTARIZATION_CONTAINER)
        self.assertTrue(report["distribution_notarization_verified"])
        self.assertFalse(report["notarization_verified"])
        self.assertFalse(report["application_notarization"]["stapled_ticket_required"])
        self.assertFalse(report["application_public_release_ready"])

    def test_post_staple_code_identity_requires_valid_complete_formal_reports(self):
        receipt = self.frontend_receipt()
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}), \
                patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence):
            baseline = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", expected_signing_identity="a" * 40,
                                         frontend_input_report=receipt)
            (self.app / "Contents/CodeResources").write_bytes(b"test notarization ticket")
            final = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", expected_signing_identity="a" * 40,
                                      frontend_input_report=receipt)
        self.assertNotEqual(final["bundle_inventory_sha256"], baseline["bundle_inventory_sha256"])
        module.verify_code_report_matches(final, baseline)
        for field in ("application_sha256", "engine_manifest_sha256", "release_status_sha256",
                      "application_license_evidence", "frontend_input_evidence", "developer_id_verification"):
            invalid = json.loads(json.dumps(baseline))
            invalid[field] = None
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "invalid .* code continuity report"):
                module.verify_code_report_matches(invalid, invalid)
            with self.subTest(expected_field=field), self.assertRaisesRegex(ValueError, "invalid expected code continuity report"):
                module.verify_code_report_matches(final, invalid)
        for section, field, value in [("application_license_evidence", "manifest_sha256", "bad"),
                                       ("frontend_input_evidence", "input_identity", {}),
                                       ("developer_id_verification", "application", {}),
                                       ("developer_id_verification", "nested_code", []),
                                       ("developer_id_verification", "team_id", "bad")]:
            invalid = json.loads(json.dumps(baseline))
            invalid[section][field] = value
            with self.subTest(section=section, field=field), self.assertRaisesRegex(ValueError, "invalid .* code continuity report"):
                module.verify_code_report_matches(invalid, invalid)

    def test_code_identity_continuity_rejects_replacement_code_and_changed_inputs(self):
        receipt = self.frontend_receipt()
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}), \
                patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence):
            baseline = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", frontend_input_report=receipt)
            # Simulate another validly signed build replacing the same output
            # directory while the initial artifact is in the notary queue.
            (self.app / "Contents/MacOS/MetOrigin Splat").write_bytes(b"different validly signed application")
            replacement = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", frontend_input_report=receipt)
        with self.assertRaisesRegex(ValueError, "identity differs.*application_sha256"):
            module.verify_code_report_matches(replacement, baseline)
        for field in ("engine_manifest_sha256", "release_status_sha256", "application_license_evidence",
                      "frontend_input_evidence", "developer_id_verification"):
            changed = json.loads(json.dumps(baseline))
            if field in {"engine_manifest_sha256", "release_status_sha256"}:
                changed[field] = "0" * 64
            elif field == "application_license_evidence":
                changed[field]["manifest_sha256"] = "0" * 64
            elif field == "frontend_input_evidence":
                changed[field]["report_sha256"] = "0" * 64
            else:
                changed[field]["application"]["authorities"][0] = "Developer ID Application: Other certificate (ABCDEFGHIJ)"
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "identity differs.*" + field):
                module.verify_code_report_matches(changed, baseline)

    def test_code_report_cli_never_exempts_changed_bundle_resources(self):
        receipt = self.frontend_receipt()
        with patch.object(module, "verify_webp_evidence", return_value={"status": "verified-derived-replacement"}), \
                patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence) as signature:
            baseline = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", frontend_input_report=receipt)
            report_path = self.root / "before-notarization.json"
            report_path.write_text(json.dumps(baseline))
            (self.app_licenses / "LICENSE").write_text("tampered resource after notarization submission")
            signature.reset_mock()
            arguments = ["verify-app.py", str(self.app), "--expected-team-id", "ABCDEFGHIJ",
                         "--frontend-input-report", str(receipt), "--expected-code-report", str(report_path)]
            with patch("sys.argv", arguments), self.assertRaisesRegex(ValueError, "license file size/hash mismatch"):
                module.main()
            signature.assert_not_called()

    def test_dmg_cannot_downgrade_or_change_application_signing_policy(self):
        with patch.object(pack_macos, "verify_developer_id_signature", side_effect=self.signed_evidence) as verify:
            report = module.verify_app(self.app, expected_team_id="ABCDEFGHIJ", expected_signing_identity="a" * 40)
            dmg = self.root / "signed.dmg"
            dmg.write_bytes(b"signed disk image")
            self.run.side_effect = self.fake_mount
            result = module.verify_dmg(dmg, self.app, report)
            self.assertEqual(result["developer_id_verification"]["team_id"], "ABCDEFGHIJ")
            self.assertIn(dmg, {call.args[0] for call in verify.call_args_list})
            for kwargs in [{"expected_team_id": "0123456789"}, {"expected_signing_identity": "b" * 40}]:
                with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, "differs from the verified application"):
                    module.verify_dmg(dmg, self.app, report, **kwargs)
        stripped = dict(report)
        stripped.pop("developer_id_verification")
        with self.assertRaisesRegex(ValueError, "Developer ID evidence differs"):
            module.verify_app_report_matches(stripped, report)

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
