"""Exercise output routing with real Bash/Node and mocked external build tools.

The temporary script copy replaces absolute Apple-tool invocations only. Nothing
executes engines, builds native code, signs an app or mounts a real disk image.
"""

import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


REPOSITORY = Path(__file__).resolve().parents[2]
BASH = "/bin/bash" if Path("/bin/bash").is_file() else shutil.which("bash")
NODE = shutil.which("node")

MOCK_TOOL = r'''
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

tool, *args = sys.argv[1:]
root = Path(os.environ["ARTIFACT_TEST_ROOT"])
with (root / "tool-events.jsonl").open("a", encoding="utf-8") as events:
    events.write(json.dumps({"tool": tool, "args": args,
                             "engine_pack": os.environ.get("METORIGIN_TEST_ENGINE_PACK"),
                             "engine_manifest": os.environ.get("METORIGIN_TEST_ENGINE_MANIFEST_SHA256")}) + "\n")
engine_config = json.loads((root / "packaging/shared/engine-paths.json").read_text(encoding="utf-8"))
source_distribution = root / engine_config["engines_root"] / engine_config["platforms"]["macos-arm64"]["paths"]["distributionRoot"]["path"]
selected_path = root / "selected-engine-pack.json"
distribution_root = (Path(json.loads(selected_path.read_text())["path"])
                     if os.environ.get("ARTIFACT_TEST_FORMAL") == "1" and selected_path.exists() else source_distribution)
artifact_config = json.loads((root / "packaging/shared/artifact-paths.json").read_text())
license_root = root / artifact_config["root"] / artifact_config["directories"]["licenses"] / "macos-arm64/current"

def argument(name):
    return args[args.index(name) + 1]

def report(payload):
    path = Path(argument("--report"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def image_payload(app):
    payload = (app / "Contents/test.txt").read_bytes()
    ticket = app / "Contents/mock-notarization-ticket"
    if ticket.exists():
        payload += b"\nMOCK-APP-TICKET:" + ticket.read_bytes()
    return payload

if tool == "uname":
    print("Darwin" if args == ["-s"] else "arm64")
elif tool == "node":
    if args == ["--version"]:
        print("v26.13.0")
    elif args and args[0] == "-p":
        print("11.12.0")
    elif args and Path(args[0]).name in {"artifact-paths.mjs", "cache-paths.mjs", "engine-paths.mjs", "resource-config.mjs", "artifact-retention.mjs"}:
        if Path(args[0]).name == "artifact-retention.mjs":
            if args[1] == "record" and os.environ.get("ARTIFACT_TEST_FAIL") == "retention-record":
                raise SystemExit(51)
            if args[1] == "apply" and os.environ.get("ARTIFACT_TEST_FAIL") == "retention-cleanup":
                raise SystemExit(52)
        os.execv(os.environ["ARTIFACT_TEST_NODE"], [os.environ["ARTIFACT_TEST_NODE"], *args])
    elif args and Path(args[0]).name in {"verify-supersplat-inputs.mjs", "verify-patch.mjs"}:
        report({"mock_frontend_inputs": True})
    else:
        raise SystemExit("Unexpected Node invocation: " + repr(args))
elif tool == "pnpm":
    if args == ["--version"]:
        print("11.12.0")
    elif "build" in args:
        config = json.loads(Path(argument("--config")).read_text(encoding="utf-8"))
        resources = {target.rstrip("/"): source for source, target in config["bundle"]["resources"].items()}
        assert config["bundle"]["targets"] == ["app"]
        assert Path(resources["resources/app-licenses"]) == license_root
        assert Path(resources["resources/engines"]) == distribution_root / "engines"
        assert Path(resources["resources/release-status.json"]) == distribution_root / "release-status.json"
        assert all(Path(source).is_absolute() for source in resources.values())
        for name in ["APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID",
                     "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
            assert name not in os.environ, "Tauri inherited signing/notary credentials: " + name
        (root / "used-resource-config.json").write_text(json.dumps(config), encoding="utf-8")
        profile = "debug" if "--debug" in args else "release"
        app = root / "target/aarch64-apple-darwin" / profile / "bundle/macos/MetOrigin Splat.app"
        (app / "Contents").mkdir(parents=True, exist_ok=True)
        (app / "Contents/test.txt").write_text("verified app " + profile, encoding="utf-8")
        ticket = app / "Contents/mock-notarization-ticket"
        if ticket.exists():
            ticket.unlink()
        packaged = app / "Contents/Resources/resources"
        packaged.mkdir(parents=True, exist_ok=True)
        shutil.copytree(distribution_root / "engines", packaged / "engines", dirs_exist_ok=True)
        shutil.copyfile(distribution_root / "release-status.json", packaged / "release-status.json")
    else:
        raise SystemExit("Unexpected pnpm invocation: " + repr(args))
elif tool == "cargo":
    engine_pack = Path(os.environ["METORIGIN_TEST_ENGINE_PACK"])
    assert engine_pack == distribution_root / "engines"
    assert os.environ["METORIGIN_TEST_ENGINE_MANIFEST_SHA256"] == digest(engine_pack / "engine-manifest.json")
    print("mock runtime preflight passed")
elif tool == "python3":
    if args[0] in {"-c", "-"}:
        os.execv(sys.executable, [sys.executable, *args])
    script = Path(args[0]).name
    if script == "verify-pack.py":
        pack = Path(args[1])
        expected = distribution_root if "--relocate" in args else source_distribution
        assert pack == expected / "engines"
        if not (pack / "engine-manifest.json").is_file():
            raise SystemExit(1)
    elif script == "sign-engine-pack.py":
        assert Path(argument("--source-pack")) == source_distribution / "engines"
        assert argument("--expected-source-manifest-sha256") == digest(source_distribution / "engines/engine-manifest.json")
        assert argument("--expected-source-release-status-sha256") == digest(source_distribution / "release-status.json")
        selected = Path(argument("--output"))
        selected.mkdir(exist_ok=False)
        shutil.copytree(source_distribution / "engines", selected / "engines")
        (selected / "engines/engine-manifest.json").write_text(json.dumps({"mock_developer_id_signed": True}))
        (selected / "release-status.json").write_text(json.dumps({"mock_derived_manifest": digest(selected / "engines/engine-manifest.json")}))
        (selected / "engine-signing.json").write_text(json.dumps({"team_id": argument("--team-id")}))
        selected_path.write_text(json.dumps({"path": str(selected)}))
    elif script == "notarize-artifact.py":
        target, submitted = Path(argument("--staple-target")), Path(argument("--submit-file"))
        kind = "app" if target.suffix == ".app" else "dmg"
        assert submitted.is_file()
        assert argument("--keychain-profile") == "mock-notary"
        assert "--password" not in args
        if os.environ.get("ARTIFACT_TEST_FAIL") == "notary-" + kind:
            raise SystemExit(41 if kind == "app" else 42)
        receipt = Path(argument("--report-dir"))
        receipt.mkdir()
        assert not (receipt.parent / "final.json").exists(), "Published final report before notarization completed"
        (receipt / "submission.json").write_text(json.dumps({
            "id": "00000000-0000-4000-8000-000000000001", "submit_file": str(submitted),
            "staple_target": str(target), "keychain_profile": argument("--keychain-profile"),
            "submitted_sha256": "0" * 64 if os.environ.get("ARTIFACT_TEST_FAIL") == "pending-receipt-mismatch" else digest(submitted)}))
        if "--submit-only" in args:
            assert kind == "dmg"
            (receipt / "result.json").write_text(json.dumps({"status": "Submitted", "pending": True,
                "accepted": False, "stapled": False, "notarization_verified": False, "submission_only": True}))
            raise SystemExit(0)
        (receipt / "accepted.json").write_text(json.dumps({"status": "Accepted", "kind": kind}))
        if os.environ.get("ARTIFACT_TEST_FAIL") == "staple-" + kind:
            raise SystemExit(43 if kind == "app" else 44)
        if kind == "app":
            assert submitted.suffix == ".zip"
            assert submitted.read_bytes() == image_payload(target)
            (target / "Contents/mock-notarization-ticket").write_text("Accepted and stapled app")
        else:
            assert submitted == target
            target.write_bytes(target.read_bytes() + b"\nMOCK-DMG-STAPLED")
        (receipt / "final.json").write_text(json.dumps({"status": "Accepted", "staple_validated": True}))
    elif script == "verify-app-icon.py":
        if "--app" in args:
            assert Path(argument("--app")).is_dir()
        print("{}")
    elif script == "verify-app.py":
        if "--check-app-license-evidence" in args:
            assert Path(argument("--check-app-license-evidence")) == license_root
            if not (license_root / "manifest.json").is_file():
                raise SystemExit(1)
            report({"mock_license_preflight": True})
        else:
            app = Path(args[1])
            assert (app / "Contents/test.txt").is_file()
            payload = {"schema_version": 1, "app": str(app), "application_signatures_verified": True,
                       "notarization_verified": False,
                       "application_sha256": digest(app / "Contents/test.txt"),
                       "bundle_inventory_sha256": hashlib.sha256(image_payload(app)).hexdigest(),
                       "engine_manifest_sha256": argument("--expected-manifest-sha256"),
                       "release_status_sha256": argument("--expected-release-status-sha256"),
                       "application_license_evidence": {"manifest_sha256": argument("--expected-app-license-manifest-sha256"),
                                                        "file_count": 1, "release_ready": True, "issues": []},
                       "frontend_input_evidence": {"report_sha256": digest(argument("--frontend-input-report")),
                           "dist_verified": True, "scope": "Synthetic orchestration fixture only",
                           "input_identity": {"signature": "b" * 64, "build_json_sha256": "c" * 64,
                               "assets": [{"path": "mock-asset", "sha256": "d" * 64}],
                               "webp_overlay": {"id": "mock-webp", "manifest_sha256": "e" * 64,
                                                "build_evidence_sha256": "f" * 64}}}}
            if "--expected-team-id" in args:
                identity = argument("--expected-signing-identity")
                signatures = json.loads((root / "mock-signatures.json").read_text())
                assert signatures[str(app)]["identity"] == identity
                assert "runtime" in signatures[str(app)]["args"]
                signature = {"team_id": argument("--expected-team-id"), "identity_sha1": identity,
                             "authorities": ["Developer ID Application: Synthetic fixture"],
                             "timestamp": "Synthetic test timestamp", "hardened_runtime": True,
                             "requirement_verified": True}
                payload["developer_id_verification"] = {"team_id": argument("--expected-team-id"),
                    "expected_identity_sha1": identity, "application": signature,
                    "nested_code": [{"path": "Contents/Resources/resources/engines/brush/bin/brush", **signature}],
                    "nested_code_count": 1, "scope": "Synthetic orchestration fixture only"}
                assert digest(app / "Contents/Resources/resources/engines/engine-manifest.json") == argument("--expected-manifest-sha256")
            notarized = "--require-notarized" in args
            container_notarized = "--require-notarized-container" in args
            assert not (notarized and container_notarized)
            if container_notarized:
                assert "--dmg" in args and "--expected-team-id" in args
            if notarized:
                assert (app / "Contents/mock-notarization-ticket").is_file()
                payload["notarization_verified"] = True
            if "--expected-code-report" in args:
                previous = json.loads(Path(argument("--expected-code-report")).read_text())
                for field in ["application_sha256", "engine_manifest_sha256", "release_status_sha256",
                              "application_license_evidence", "frontend_input_evidence", "developer_id_verification"]:
                    assert previous[field] == payload[field], "Stapling changed frozen code evidence: " + field
            if "--dmg" in args:
                if os.environ.get("ARTIFACT_TEST_FAIL") == "final-verification":
                    raise SystemExit(31)
                dmg = Path(argument("--dmg"))
                image = dmg.read_bytes()
                if notarized or container_notarized:
                    assert image.endswith(b"\nMOCK-DMG-STAPLED")
                    image = image.removesuffix(b"\nMOCK-DMG-STAPLED")
                assert image == image_payload(app)
                if "--expected-app-report" in args:
                    previous = json.loads(Path(argument("--expected-app-report")).read_text())
                    assert previous["application_sha256"] == payload["application_sha256"]
                    assert previous["bundle_inventory_sha256"] == payload["bundle_inventory_sha256"]
                if "--expected-team-id" in args:
                    assert signatures[str(dmg)]["identity"] == identity
                payload["dmg"] = {"path": str(dmg), "sha256": digest(dmg), "application_matches_verified_bundle": True,
                                  "notarization_verified": notarized or container_notarized}
                if container_notarized:
                    payload.update(distribution_notarization_policy="stapled-dmg-with-developer-id-application",
                                   distribution_notarization_verified=True)
                    payload["dmg"].update(notarization_policy="stapled-dmg-with-developer-id-application",
                        embedded_application_notarization={"developer_id_verified": True, "stapled_ticket_required": False,
                            "stapled_ticket_validated": False, "gatekeeper_assessment_performed": False})
            report(payload)
    else:
        raise SystemExit("Unexpected Python invocation: " + repr(args))
elif tool == "mock-shasum":
    path = Path(args[-1])
    print(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + str(path))
elif tool == "mock-codesign":
    target = Path(args[-1])
    assert target.exists()
    assert "--deep" not in args
    path = root / "mock-signatures.json"
    signatures = json.loads(path.read_text()) if path.exists() else {}
    signatures[str(target)] = {"identity": argument("--sign"), "args": args}
    path.write_text(json.dumps(signatures))
elif tool == "mock-ditto":
    if args[:3] == ["-c", "-k", "--keepParent"]:
        Path(args[-1]).write_bytes(image_payload(Path(args[-2])))
    else:
        shutil.copytree(args[0], args[1])
elif tool == "mock-hdiutil":
    assert args[0] == "create"
    app = Path(argument("-srcfolder")) / "MetOrigin Splat.app"
    with Path(args[-1]).open("xb") as output:
        output.write(image_payload(app))
else:
    raise SystemExit("Unexpected tool: " + tool)
'''


@unittest.skipUnless(BASH and NODE, "Bash and Node are required for the packaging orchestration test")
class ArtifactOutputTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="artifact-output-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / "中文 工作区"
        self.root.mkdir()
        for relative in ["scripts/shared/artifact-retention.mjs", "scripts/shared/artifact-paths.mjs", "packaging/shared/artifact-paths.json",
                         "scripts/shared/cache-paths.mjs", "packaging/shared/cache-paths.json",
                         "scripts/shared/engine-paths.mjs", "packaging/shared/engine-paths.json",
                         "scripts/macos/resource-config.mjs", "apps/desktop/src-tauri/tauri.macos.full.conf.json"]:
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPOSITORY / relative, destination)
        self.script = self.root / "scripts/macos/build-macos-app.sh"
        self.script.parent.mkdir(parents=True, exist_ok=True)
        source = (REPOSITORY / "scripts/macos/build-macos-app.sh").read_text(encoding="utf-8")
        for name in ["shasum", "codesign", "ditto", "hdiutil"]:
            source = source.replace("/usr/bin/" + name, "mock-" + name)
        self.script.write_text(source, encoding="utf-8")

        inputs = {
            "Cargo.lock": "Cargo.lock", "Cargo.toml": "Cargo.toml",
            "apps/desktop/src-tauri/Cargo.toml": "desktop-Cargo.toml",
            "apps/desktop/package.json": "desktop-package.json",
            "pnpm-lock.yaml": "pnpm-lock.yaml", "pnpm-workspace.yaml": "pnpm-workspace.yaml",
            "integrations/supersplat/upstream.json": "supersplat-upstream.json",
            ".cache/metorigin/sources/supersplat/upstream/package-lock.json": "supersplat-package-lock.json",
        }
        self.licenses = self.root / "artifacts/licenses/macos-arm64/current"
        self.legacy_licenses = self.root / "target/macos-m4/app-license-evidence/licenses"
        for relative, snapshot in inputs.items():
            original = self.root / relative
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_text("fixture " + relative, encoding="utf-8")
            copied = self.licenses / "build-inputs" / snapshot
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, copied)
        self.distribution = self.root / ".engines/macos-arm64/distribution"
        for relative in [".engines/macos-arm64/distribution/engines/engine-manifest.json",
                         ".engines/macos-arm64/distribution/release-status.json",
                         "artifacts/licenses/macos-arm64/current/manifest.json"]:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}", encoding="utf-8")
        shutil.copytree(self.licenses, self.legacy_licenses)
        self.capture_input_hashes()
        self.old_report = self.root / "target/macos-m4/app-verification/latest.json"
        self.old_dmg = self.root / "target/aarch64-apple-darwin/release/bundle/dmg/historical.dmg"
        for path in [self.old_report, self.old_dmg]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"preserve historical artifact")

        tools = self.root / "mock-bin"
        tools.mkdir()
        mock = tools / "tool.py"
        mock.write_text(textwrap.dedent(MOCK_TOOL), encoding="utf-8")
        for tool in ["uname", "node", "pnpm", "cargo", "python3", "mock-shasum",
                     "mock-codesign", "mock-ditto", "mock-hdiutil"]:
            wrapper = tools / tool
            wrapper.write_text("#!/bin/sh\nexec " + " ".join(shlex.quote(value) for value in
                [sys.executable, str(mock), tool]) + ' "$@"\n', encoding="utf-8")
            wrapper.chmod(0o755)
        self.environment = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ.get("PATH", ""),
                                ARTIFACT_TEST_ROOT=str(self.root), ARTIFACT_TEST_NODE=NODE)
        self.packages = self.root / "artifacts/packages/macos-arm64"
        self.verification = self.root / "artifacts/verification/macos-arm64"

    def build(self, *options, expected=0, failure=""):
        try:
            result = subprocess.run([BASH, str(self.script), "--internal-alpha", *options],
                                    cwd=self.root.parent,
                                    env=dict(self.environment, ARTIFACT_TEST_FAIL=failure,
                                             ARTIFACT_TEST_FORMAL="1" if "--signing-identity" in options else "0"),
                                    capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired as error:
            events = self.root / "tool-events.jsonl"
            self.fail("Packaging mock exceeded 30s; last tool events: "
                      + (events.read_text()[-5000:] if events.exists() else "none") + str(error))
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def formal_options(self, notarize=True):
        options = ["--signing-identity", "A" * 40, "--team-id", "ABCDEFGHIJ"]
        if notarize:
            options += ["--notary-profile", "mock-notary"]
        return options

    def tool_events(self):
        path = self.root / "tool-events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def capture_input_hashes(self):
        self.input_hashes = {str(path.relative_to(self.root)): hashlib.sha256(path.read_bytes()).hexdigest()
                             for prefix in [self.distribution, self.licenses, self.legacy_licenses]
                             for path in prefix.rglob("*") if path.is_file()}

    def assert_inputs_and_history_preserved(self):
        for relative, digest in self.input_hashes.items():
            self.assertEqual(hashlib.sha256((self.root / relative).read_bytes()).hexdigest(), digest)
        for path in [self.old_report, self.old_dmg]:
            self.assertEqual(path.read_bytes(), b"preserve historical artifact")
        for stage in self.verification.glob("build.*/dmg-source"):
            self.fail("Temporary DMG staging directory was not cleaned: " + str(stage))
        self.assertEqual(list(self.verification.glob(".latest.*")), [], "Temporary latest report was not cleaned")

    def test_success_routes_unique_packages_and_retires_previous_run_without_moving_inputs(self):
        first = self.build()
        first_latest = (self.verification / "latest.json").read_bytes()
        report = json.loads(first_latest)
        first_dmg = Path(report["dmg"]["path"])
        self.assertEqual(first_dmg.parent, self.packages)
        self.assertTrue(first_dmg.name.startswith("MetOrigin-Splat-release-"))
        self.assertIn("Verified DMG: " + str(first_dmg), first.stdout)
        self.assertEqual(report["app"], str(self.root / "target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app"))
        first_report_directory = next(self.verification.glob("build.*"))
        self.build()
        second_report = json.loads((self.verification / "latest.json").read_text())
        self.assertNotEqual(second_report["dmg"]["path"], str(first_dmg))
        self.assertTrue(Path(second_report["dmg"]["path"]).is_file())
        self.assertFalse(first_dmg.exists())
        self.assertFalse(first_report_directory.exists())
        self.assertEqual(len(list(self.packages.glob("*.dmg"))), 1)
        self.assertEqual(len(list(self.verification.glob("build.*/final.json"))), 1)
        self.assert_inputs_and_history_preserved()

    def test_debug_app_only_keeps_cargo_app_path_and_skips_dmg(self):
        self.build("--debug", "--app-only")
        report = json.loads((self.verification / "latest.json").read_text())
        self.assertEqual(report["app"], str(self.root / "target/aarch64-apple-darwin/debug/bundle/macos/MetOrigin Splat.app"))
        self.assertNotIn("dmg", report)
        self.assertFalse(self.packages.exists())
        self.build("--debug")
        debug_report = json.loads((self.verification / "latest.json").read_text())
        debug_dmg = Path(debug_report["dmg"]["path"])
        self.assertEqual(debug_dmg.parent, self.packages)
        self.assertTrue(debug_dmg.name.startswith("MetOrigin-Splat-debug-"))
        self.assertEqual(debug_report["app"], report["app"])
        self.assert_inputs_and_history_preserved()

    def test_final_verification_failure_retains_last_successful_report(self):
        self.build()
        latest = (self.verification / "latest.json").read_bytes()
        self.build(expected=31, failure="final-verification")
        self.assertEqual((self.verification / "latest.json").read_bytes(), latest)
        self.assertEqual(len(list(self.verification.glob("build.*"))), 2)
        self.assertEqual(len(list(self.verification.glob("build.*/final.json"))), 1)
        self.assert_inputs_and_history_preserved()

    def test_retention_record_failure_preserves_the_previous_published_success(self):
        self.build()
        latest_path = self.verification / "latest.json"
        registry_path = self.verification / "retention-index.json"
        latest, registry = latest_path.read_bytes(), registry_path.read_bytes()
        previous = json.loads(latest)
        old_package = Path(previous["dmg"]["path"])
        old_bytes = old_package.read_bytes()
        old_report = self.verification / json.loads(registry)["runs"][0]["report"].split("/")[-2] / "final.json"
        report_bytes = old_report.read_bytes()
        (self.root / "tool-events.jsonl").write_text("")
        failed = self.build(expected=51, failure="retention-record")
        self.assertEqual(latest_path.read_bytes(), latest)
        self.assertEqual(registry_path.read_bytes(), registry)
        self.assertEqual(old_package.read_bytes(), old_bytes)
        self.assertEqual(old_report.read_bytes(), report_bytes)
        self.assertNotIn("Verified DMG:", failed.stdout)
        self.assertFalse(any(event["tool"] == "node" and event["args"][0].endswith("artifact-retention.mjs")
                             and event["args"][1] == "apply" for event in self.tool_events()))
        self.assert_inputs_and_history_preserved()

    def test_post_publication_cleanup_failure_keeps_the_new_registered_success(self):
        self.build()
        previous = json.loads((self.verification / "latest.json").read_text())
        previous_package = Path(previous["dmg"]["path"])
        previous_bytes = previous_package.read_bytes()
        (self.root / "tool-events.jsonl").write_text("")
        result = self.build(failure="retention-cleanup")
        latest = json.loads((self.verification / "latest.json").read_text())
        new_package = Path(latest["dmg"]["path"])
        self.assertNotEqual(new_package, previous_package)
        self.assertTrue(new_package.is_file())
        self.assertEqual(previous_package.read_bytes(), previous_bytes)
        registry = json.loads((self.verification / "retention-index.json").read_text())
        registered_packages = {str(self.root / package["path"])
                               for run in registry["runs"] for package in run["packages"]}
        self.assertIn(str(new_package), registered_packages)
        self.assertIn(str(previous_package), registered_packages)
        self.assertIn("Warning: artifact cleanup failed", result.stderr)
        self.assertIn("Verified DMG: " + str(new_package), result.stdout)
        events = self.tool_events()
        phases = [event["args"][1] for event in events if event["tool"] == "node"
                  and event["args"][0].endswith("artifact-retention.mjs")]
        self.assertEqual(phases, ["record", "apply"])
        # The real record command inventories the run. An independent dry-run
        # validation now detects any write into that run after registration.
        validation = subprocess.run([NODE, str(self.root / "scripts/shared/artifact-retention.mjs"),
                                     "apply", "--platform", "macos-arm64"], cwd=self.root,
                                    capture_output=True, text=True, timeout=15)
        self.assertEqual(validation.returncode, 0, validation.stdout + validation.stderr)
        self.assert_inputs_and_history_preserved()

    def test_migrated_lock_is_required_even_when_legacy_cache_matches(self):
        lock = self.root / ".cache/metorigin/sources/supersplat/upstream/package-lock.json"
        legacy = self.root / "target/supersplat-source/upstream/package-lock.json"
        legacy.parent.mkdir(parents=True)
        shutil.copyfile(lock, legacy)
        self.verification.mkdir(parents=True)
        latest = self.verification / "latest.json"
        latest.write_bytes(b"last successful report")
        for state, exit_code in [("changed", 1), ("missing", 2)]:
            with self.subTest(state=state):
                if state == "changed":
                    lock.write_text("different current lock", encoding="utf-8")
                else:
                    lock.unlink()
                self.build(expected=exit_code)
                self.assertEqual(latest.read_bytes(), b"last successful report")
                self.assertFalse((self.root / "target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app").exists())
                self.assertEqual(list(self.verification.glob("build.*/final.json")), [])
        self.assert_inputs_and_history_preserved()

    def test_migrated_license_directory_is_required_even_when_legacy_evidence_exists(self):
        self.build()
        latest = (self.verification / "latest.json").read_bytes()
        app_bytes = (self.root / "target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app/Contents/test.txt").read_bytes()
        saved = self.licenses.with_name("temporary-saved-current")
        self.licenses.rename(saved)
        try:
            self.assertTrue((self.legacy_licenses / "manifest.json").is_file())
            self.build(expected=1)
            self.assertEqual((self.verification / "latest.json").read_bytes(), latest)
            self.assertEqual(len(list(self.verification.glob("build.*/final.json"))), 1)
            self.assertEqual((self.root / "target/aarch64-apple-darwin/release/bundle/macos/MetOrigin Splat.app/Contents/test.txt").read_bytes(), app_bytes)
        finally:
            saved.rename(self.licenses)
        self.assert_inputs_and_history_preserved()

    def test_configured_artifact_root_controls_both_preflight_and_bundled_licenses(self):
        config_path = self.root / "packaging/shared/artifact-paths.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["root"] = "release outputs"
        config["directories"]["licenses"] = "notices"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        updated = self.root / "release outputs/notices/macos-arm64/current"
        updated.parent.mkdir(parents=True)
        self.licenses.rename(updated)
        self.licenses = updated
        self.packages = self.root / "release outputs/packages/macos-arm64"
        self.verification = self.root / "release outputs/verification/macos-arm64"
        self.capture_input_hashes()
        self.build()
        config = json.loads((self.root / "used-resource-config.json").read_text(encoding="utf-8"))
        source = next(source for source, target in config["bundle"]["resources"].items()
                      if target.rstrip("/") == "resources/app-licenses")
        self.assertEqual(Path(source), self.licenses)
        self.assertFalse((self.root / "artifacts/licenses/macos-arm64/current").exists())
        self.assertEqual(Path(json.loads((self.verification / "latest.json").read_text())["dmg"]["path"]).parent, self.packages)
        self.assert_inputs_and_history_preserved()

    def test_engine_layout_controls_preflight_and_bundle_without_legacy_fallback(self):
        config_path = self.root / "packaging/shared/engine-paths.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["engines_root"] = "native engines"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        updated = self.root / "native engines/macos-arm64/distribution"
        updated.parent.mkdir(parents=True)
        self.distribution.rename(updated)
        self.distribution = updated
        legacy = self.root / "target/distribution/macos-arm64"
        legacy.parent.mkdir(parents=True)
        shutil.copytree(updated, legacy)
        self.capture_input_hashes()
        self.build()
        latest = (self.verification / "latest.json").read_bytes()
        saved = updated.with_name("saved-pack")
        updated.rename(saved)
        try:
            self.build(expected=1)
            self.assertEqual((self.verification / "latest.json").read_bytes(), latest)
        finally:
            saved.rename(updated)
        self.assertTrue((legacy / "engines/engine-manifest.json").is_file())
        self.assert_inputs_and_history_preserved()

    def test_formal_dmg_flow_uses_derived_pack_and_submits_only_the_outermost_container(self):
        for name in ["APPLE_SIGNING_IDENTITY", "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_ID",
                     "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]:
            self.environment[name] = "synthetic-shell-value"
        self.build(*self.formal_options())
        latest = json.loads((self.verification / "latest.json").read_text())
        self.assertFalse(latest["notarization_verified"])
        self.assertTrue(latest["distribution_notarization_verified"])
        self.assertTrue(latest["dmg"]["notarization_verified"])
        selected = Path(json.loads((self.root / "selected-engine-pack.json").read_text())["path"])
        self.assertNotEqual(selected, self.distribution)
        config = json.loads((self.root / "used-resource-config.json").read_text())
        resources = {target.rstrip("/"): source for source, target in config["bundle"]["resources"].items()}
        self.assertEqual(Path(resources["resources/engines"]), selected / "engines")
        self.assertEqual(Path(resources["resources/release-status.json"]), selected / "release-status.json")
        events = self.tool_events()
        cargo = [event for event in events if event["tool"] == "cargo"]
        self.assertEqual(len(cargo), 2)
        for event in cargo:
            self.assertEqual(event["engine_pack"], str(selected / "engines"))
            self.assertEqual(event["engine_manifest"], hashlib.sha256((selected / "engines/engine-manifest.json").read_bytes()).hexdigest())
        signatures = [event for event in events if event["tool"] == "mock-codesign"]
        self.assertEqual(len(signatures), 2)
        for event in signatures:
            self.assertEqual(event["args"][event["args"].index("--sign") + 1], "A" * 40)
            self.assertIn("--timestamp", event["args"])
            self.assertNotIn("--timestamp=none", event["args"])
            self.assertNotIn("--deep", event["args"])
        self.assertIn("runtime", signatures[0]["args"])
        notary = [(index, event) for index, event in enumerate(events)
                  if event["tool"] == "python3" and event["args"][0].endswith("notarize-artifact.py")]
        self.assertEqual(len(notary), 1)
        self.assertTrue(notary[0][1]["args"][notary[0][1]["args"].index("--submit-file") + 1].endswith(".dmg"))
        self.assertFalse(any("--require-notarized" in event["args"] for event in events))
        final_verification = [event for event in events if event["tool"] == "python3"
                              and event["args"][0].endswith("verify-app.py")
                              and "--require-notarized-container" in event["args"]]
        self.assertEqual(len(final_verification), 1)
        self.assertIn("--expected-app-report", final_verification[0]["args"])
        self.assertFalse((Path(latest["app"]) / "Contents/mock-notarization-ticket").exists())
        recorded = [index for index, event in enumerate(events) if event["tool"] == "node"
                    and event["args"][0].endswith("artifact-retention.mjs") and "record" in event["args"]]
        self.assertEqual(len(recorded), 1)
        self.assertGreater(recorded[0], notary[-1][0])
        work = Path(latest["dmg"]["path"]).name.split("-build.")[-1].removesuffix(".dmg")
        receipt = self.verification / ("build." + work) / "notary-dmg/final.json"
        self.assertTrue(json.loads(receipt.read_text())["staple_validated"])
        self.assertFalse((receipt.parent.parent / "notary-app").exists())
        self.assert_inputs_and_history_preserved()

    def test_standalone_formal_app_keeps_strict_zip_notarization_and_its_own_ticket(self):
        self.build(*self.formal_options(), "--app-only")
        latest = json.loads((self.verification / "latest.json").read_text())
        self.assertTrue(latest["notarization_verified"])
        self.assertNotIn("dmg", latest)
        self.assertTrue((Path(latest["app"]) / "Contents/mock-notarization-ticket").exists())
        events = self.tool_events()
        notary = [event for event in events if event["tool"] == "python3"
                  and event["args"][0].endswith("notarize-artifact.py")]
        self.assertEqual(len(notary), 1)
        self.assertTrue(notary[0]["args"][notary[0]["args"].index("--submit-file") + 1].endswith(".zip"))
        verified = [event for event in events if event["tool"] == "python3"
                    and event["args"][0].endswith("verify-app.py") and "--require-notarized" in event["args"]]
        self.assertEqual(len(verified), 1)
        self.assertIn("--expected-code-report", verified[0]["args"])
        self.assertFalse(any("--require-notarized-container" in event["args"] for event in events))
        self.assertFalse(self.packages.exists())
        self.assert_inputs_and_history_preserved()

    def test_notary_failure_never_publishes_or_records_a_new_success(self):
        self.build()
        latest = (self.verification / "latest.json").read_bytes()
        registry = (self.verification / "retention-index.json").read_bytes()
        successful_package = Path(json.loads(latest)["dmg"]["path"])
        for phase, code in [("notary-app", 41), ("notary-dmg", 42), ("staple-app", 43), ("staple-dmg", 44)]:
            with self.subTest(phase=phase):
                (self.root / "tool-events.jsonl").write_text("")
                options = [*self.formal_options(), *(["--app-only"] if phase.endswith("-app") else [])]
                self.build(*options, expected=code, failure=phase)
                self.assertEqual((self.verification / "latest.json").read_bytes(), latest)
                self.assertEqual((self.verification / "retention-index.json").read_bytes(), registry)
                self.assertTrue(successful_package.is_file())
                self.assertFalse(any(event["tool"] == "node" and "record" in event["args"]
                                     and event["args"][0].endswith("artifact-retention.mjs")
                                     for event in self.tool_events()))
        self.assert_inputs_and_history_preserved()

    def test_submit_only_writes_explicit_pending_receipt_without_latest_or_retention(self):
        self.build()
        latest = (self.verification / "latest.json").read_bytes()
        registry = (self.verification / "retention-index.json").read_bytes()
        (self.root / "tool-events.jsonl").write_text("")
        result = self.build(*self.formal_options(), "--notary-submit-only")
        self.assertEqual((self.verification / "latest.json").read_bytes(), latest)
        self.assertEqual((self.verification / "retention-index.json").read_bytes(), registry)
        pending_paths = list(self.verification.glob("build.*/pending-dmg.json"))
        self.assertEqual(len(pending_paths), 1)
        pending_path = pending_paths[0]
        pending = json.loads(pending_path.read_text())
        self.assertTrue(pending["pending"])
        self.assertTrue(pending["submission_only"])
        self.assertFalse(pending["accepted"])
        self.assertFalse(pending["notarization_verified"])
        self.assertEqual(pending["status"], "submitted-awaiting-apple")
        self.assertFalse((pending_path.parent / "final.json").exists())
        self.assertFalse((pending_path.parent / "notary-dmg/accepted.json").exists())
        self.assertEqual(pending["dmg"]["sha256"], hashlib.sha256(Path(pending["dmg"]["path"]).read_bytes()).hexdigest())
        self.assertIn("Notarization submission ID: " + pending["submission_id"], result.stdout)
        self.assertIn("Pending notarization report: " + str(pending_path), result.stdout)
        self.assertNotIn("Verified DMG:", result.stdout)
        self.assertNotIn("Verified app packaging evidence:", result.stdout)
        events = self.tool_events()
        notary = [event for event in events if event["tool"] == "python3"
                  and event["args"][0].endswith("notarize-artifact.py")]
        self.assertEqual(len(notary), 1)
        self.assertIn("--submit-only", notary[0]["args"])
        self.assertFalse(any(event["tool"] == "node" and "record" in event["args"]
                             and event["args"][0].endswith("artifact-retention.mjs") for event in events))
        self.assertFalse(any("--require-notarized-container" in event["args"] for event in events))
        self.assert_inputs_and_history_preserved()

    def test_submit_only_rejects_receipt_not_bound_to_the_signed_dmg(self):
        self.verification.mkdir(parents=True)
        latest = self.verification / "latest.json"
        latest.write_bytes(b"previous successful report")
        self.build(*self.formal_options(), "--notary-submit-only", expected=1, failure="pending-receipt-mismatch")
        self.assertEqual(latest.read_bytes(), b"previous successful report")
        self.assertEqual(list(self.verification.glob("build.*/pending-dmg.json")), [])
        self.assertEqual(list(self.verification.glob("build.*/final.json")), [])
        self.assertFalse((self.verification / "retention-index.json").exists())
        self.assert_inputs_and_history_preserved()

    def test_incomplete_identity_or_debug_formal_build_is_rejected_before_tools_run(self):
        for options in [("--signing-identity", "A" * 40), ("--team-id", "ABCDEFGHIJ"),
                        ("--notary-profile", "mock-notary"), (*self.formal_options(), "--debug"),
                        ("--signing-identity",), ("--team-id", "--debug"), ("--notary-submit-only",),
                        (*self.formal_options(notarize=False), "--notary-submit-only"),
                        (*self.formal_options(), "--app-only", "--notary-submit-only")]:
            with self.subTest(options=options):
                self.build(*options, expected=2)
                events = self.tool_events()
                self.assertFalse(any(event["tool"] in {"pnpm", "cargo", "python3"} for event in events))
        self.assertFalse(self.packages.exists())


if __name__ == "__main__":
    unittest.main()
