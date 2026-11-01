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
engine_config = json.loads((root / "packaging/shared/engine-paths.json").read_text(encoding="utf-8"))
distribution_root = root / engine_config["engines_root"] / engine_config["platforms"]["macos-arm64"]["paths"]["distributionRoot"]["path"]
artifact_config = json.loads((root / "packaging/shared/artifact-paths.json").read_text())
license_root = root / artifact_config["root"] / artifact_config["directories"]["licenses"] / "macos-arm64/current"

def argument(name):
    return args[args.index(name) + 1]

def report(payload):
    path = Path(argument("--report"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")

if tool == "uname":
    print("Darwin" if args == ["-s"] else "arm64")
elif tool == "node":
    if args == ["--version"]:
        print("v26.13.0")
    elif args and args[0] == "-p":
        print("11.12.0")
    elif args and Path(args[0]).name in {"artifact-paths.mjs", "cache-paths.mjs", "engine-paths.mjs", "resource-config.mjs", "artifact-retention.mjs"}:
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
        (root / "used-resource-config.json").write_text(json.dumps(config), encoding="utf-8")
        profile = "debug" if "--debug" in args else "release"
        app = root / "target/aarch64-apple-darwin" / profile / "bundle/macos/MetOrigin Splat.app"
        (app / "Contents").mkdir(parents=True, exist_ok=True)
        (app / "Contents/test.txt").write_text("verified app " + profile, encoding="utf-8")
    else:
        raise SystemExit("Unexpected pnpm invocation: " + repr(args))
elif tool == "cargo":
    print("mock runtime preflight passed")
elif tool == "python3":
    script = Path(args[0]).name
    if script == "verify-pack.py":
        assert Path(args[1]) == distribution_root / "engines"
        if not (distribution_root / "engines/engine-manifest.json").is_file():
            raise SystemExit(1)
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
            payload = {"app": str(app), "application_signatures_verified": True}
            if "--dmg" in args:
                if os.environ.get("ARTIFACT_TEST_FAIL") == "final-verification":
                    raise SystemExit(31)
                dmg = Path(argument("--dmg"))
                assert dmg.read_bytes() == (app / "Contents/test.txt").read_bytes()
                assert Path(argument("--expected-app-report")).is_file()
                payload["dmg"] = {"path": str(dmg), "application_matches_verified_bundle": True}
            report(payload)
    else:
        raise SystemExit("Unexpected Python invocation: " + repr(args))
elif tool == "mock-shasum":
    path = Path(args[-1])
    print(hashlib.sha256(path.read_bytes()).hexdigest() + "  " + str(path))
elif tool == "mock-codesign":
    assert Path(args[-1]).is_dir()
elif tool == "mock-ditto":
    shutil.copytree(args[0], args[1])
elif tool == "mock-hdiutil":
    assert args[0] == "create"
    source = Path(argument("-srcfolder")) / "MetOrigin Splat.app/Contents/test.txt"
    with Path(args[-1]).open("xb") as output:
        output.write(source.read_bytes())
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
        result = subprocess.run([BASH, str(self.script), "--internal-alpha", *options],
                                cwd=self.root.parent, env=dict(self.environment, ARTIFACT_TEST_FAIL=failure),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

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


if __name__ == "__main__":
    unittest.main()
