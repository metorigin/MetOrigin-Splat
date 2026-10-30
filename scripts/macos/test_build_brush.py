#!/usr/bin/env python3
"""Build-recipe contract tests with fake tools; these are not engine smoke tests."""

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("build-brush.sh").resolve()
COMMIT = "1388f74c6fe0236f68ee4915564bf00e9d2e3747"


class BrushBuildRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="brush recipe 中文 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source checkout"
        self.source.mkdir()
        (self.source / "Cargo.lock").write_text("version = 4\n")
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.output = self.root / "build output"
        self.env = dict(os.environ)
        self.env.update(PATH=f"{self.bin}:/usr/bin:/bin", CARGO_HOME=str(self.root / "cargo home"))
        self.env.pop("RUSTFLAGS", None)
        self.env.pop("CARGO_ENCODED_RUSTFLAGS", None)
        self.env.pop("CARGO_TARGET_DIR", None)
        self.tool("git", f'''case "$*" in
  *--is-inside-work-tree*) echo true ;;
  *"rev-parse HEAD"*) echo "${{TEST_COMMIT:-{COMMIT}}}" ;;
  *status*) printf '%s' "${{TEST_DIRTY:-}}" ;;
esac''')
        self.tool("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.tool("rustc", 'echo "rustc 1.95.0 (fixture)"')
        self.tool("xcrun", 'echo fixture-sdk')
        self.tool("xcodebuild", 'echo fixture-xcode')
        self.tool("lipo", 'echo "${TEST_ARCH:-arm64}"')
        self.tool("otool", 'echo fixture-load-commands')
        self.tool("python3", f'exec {shlex.quote(sys.executable)} "$@"')
        self.tool("cargo", '''if [[ "$1" == --version ]]; then echo 'cargo 1.95.0 (fixture)'; exit; fi
printf '%s\\n' "$@" > "$CARGO_TARGET_DIR.args"
[[ $CARGO_PROFILE_RELEASE_STRIP == none ]] || exit 18
[[ ${TEST_BUILD_FAIL:-0} == 0 ]] || exit 17
mkdir -p "$CARGO_TARGET_DIR/aarch64-apple-darwin/release"
cat > "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/brush-cli" <<'EOF'
#!/bin/bash
case "$1" in
--version) echo 'brush-cli 1.0.0';;
--help) echo '--total-train-iters --max-resolution --max-splats --max-scene-batch-cache-size --lod-levels --export-path --export-name';;
esac
EOF
chmod +x "$CARGO_TARGET_DIR/aarch64-apple-darwin/release/brush-cli"
''')

    def tool(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\nset -e\n" + body + "\n")
        path.chmod(0o755)

    def run_recipe(self, profile="--stock"):
        selection = [profile] if profile else []
        return subprocess.run(["/bin/bash", str(SCRIPT), *selection, str(self.source), str(self.output)],
                              env=self.env, capture_output=True, text=True)

    def test_default_features_locked_and_space_paths(self):
        result = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = (self.output / "target.args").read_text().splitlines()
        self.assertEqual(args, ["build", "--locked", "--release", "-p", "brush-cli", "--target", "aarch64-apple-darwin"])
        self.assertTrue((self.output / "evidence" / "binary.sha256").exists())
        evidence = json.loads((self.output / "evidence" / "build-info.json").read_text())
        self.assertEqual(evidence["source_commit"], COMMIT)
        self.assertEqual(evidence["release_strip"], "none")
        self.assertEqual(len(evidence["binary_sha256"]), 64)
        self.assertFalse(evidence["metal_training_validated"])
        self.assertIn("Metal training remains to be validated", result.stdout)

    def test_default_build_selects_distribution_profile(self):
        self.tool("python3", f'''if [[ "$1" == *prepare-brush-source.py ]]; then
  printf '%s\\n' "$@" >&2
  exit 43
fi
exec {shlex.quote(sys.executable)} "$@"''')
        for flag, profile in [(None, "metorigin-macos.6"),
                              ("--distribution-patch", "metorigin-macos.6"),
                              ("--lpips-policy-patch", "metorigin-macos.5")]:
            with self.subTest(flag=flag):
                result = self.run_recipe(profile=flag)
                self.assertEqual(result.returncode, 43)
                self.assertIn("--profile\n" + profile, result.stderr)
                self.assertFalse((self.output / "evidence" / "build-info.json").exists())

    def test_wrong_source_revision_is_rejected(self):
        self.env["TEST_COMMIT"] = "0" * 40
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Source must be pinned", result.stderr)
        self.assertFalse(self.output.exists())

    def test_dirty_source_is_rejected(self):
        self.env["TEST_DIRTY"] = " M Cargo.lock"
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be clean", result.stderr)

    def test_build_failure_does_not_collect_success_evidence(self):
        self.env["TEST_BUILD_FAIL"] = "1"
        result = self.run_recipe()
        self.assertEqual(result.returncode, 17)
        self.assertFalse((self.output / "evidence" / "binary.sha256").exists())

    def test_wrong_binary_architecture_is_rejected(self):
        self.env["TEST_ARCH"] = "x86_64"
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("arm64-only", result.stderr)

    def test_failed_retry_removes_old_success_evidence(self):
        self.assertEqual(self.run_recipe().returncode, 0)
        self.env["TEST_BUILD_FAIL"] = "1"
        self.assertEqual(self.run_recipe().returncode, 17)
        self.assertFalse((self.output / "evidence" / "binary.sha256").exists())

    def test_custom_rust_flags_are_rejected(self):
        self.env["RUSTFLAGS"] = "-C target-cpu=native"
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unset custom RUSTFLAGS", result.stderr)

    def test_output_inside_source_is_rejected(self):
        self.output = self.source / "new build directory"
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not overlap", result.stderr)
        self.assertFalse(self.output.exists())

    def test_output_ancestor_of_source_is_rejected(self):
        self.output = self.root
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not overlap", result.stderr)

    def test_cache_and_target_inside_source_are_rejected(self):
        for name in ("CARGO_HOME", "CARGO_TARGET_DIR"):
            with self.subTest(name=name):
                self.env[name] = str(self.source / "cache")
                result = self.run_recipe()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("must not overlap", result.stderr)
                self.assertFalse(self.output.exists())
                self.env.pop(name)

    def test_output_symlink_into_source_is_rejected(self):
        alias = self.root / "source alias"
        alias.symlink_to(self.source, target_is_directory=True)
        self.output = alias / "new output"
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not overlap", result.stderr)
        self.assertFalse((self.source / "new output").exists())

    def test_evidence_symlink_into_source_is_rejected(self):
        self.output.mkdir()
        (self.output / "evidence").symlink_to(self.source, target_is_directory=True)
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not be a symlink", result.stderr)
        self.assertFalse((self.source / "build.log").exists())


if __name__ == "__main__":
    unittest.main()
