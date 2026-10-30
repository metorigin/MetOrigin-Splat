"""Build recipe contract tests; these deliberately do not claim engine validation."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from verify_colmap_help import REQUIRED_FLAGS, validate_help

SCRIPT = Path(__file__).with_name("build-colmap.sh")
COMMIT = "fa8e3b3ff591552855f8ad2806723c80f963f69c"


class ColmapBuildRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="colmap recipe 测试 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.source = self.root / "source"
        (self.source / ".git").mkdir(parents=True)
        self.build = self.root / "build output"
        self.install = self.root / "install output"
        self.log = self.root / "configure-args.json"
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", RECIPE_LOG=str(self.log))
        self.stub("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.stub("git", f'case "$3" in rev-parse) echo {COMMIT};; status) ;; esac')
        self.stub("xcrun", 'case "$*" in *--find*) echo /usr/bin/true;; *--show-sdk-path*) echo /fake/sdk;; *) echo 15.0;; esac')
        self.stub("cmake", '''if [ "$1" != --version ]; then
    /usr/bin/python3 -c 'import json,os,sys; json.dump(sys.argv[1:],open(os.environ["RECIPE_LOG"],"w"))' "$@"
fi''')
        for tool in ("ninja", "shasum", "otool", "lipo", "sw_vers"):
            self.stub(tool, "exit 0")

    def stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def run_recipe(self, *extra):
        return subprocess.run(
            ["/bin/bash", str(SCRIPT), "--source", str(self.source),
             "--build-dir", str(self.build), "--install-dir", str(self.install),
             "--configure-only", *extra],
            env=self.env, capture_output=True, text=True, check=False,
        )

    def test_cpu_flags_and_space_paths_are_structural_arguments(self):
        result = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text())
        for flag in ("CUDA", "GUI", "OPENGL", "ONNX", "CASPAR", "TESTS"):
            self.assertIn(f"-D{flag}_ENABLED=OFF", args)
        self.assertIn("-DCMAKE_OSX_ARCHITECTURES=arm64", args)
        self.assertIn("-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0", args)
        self.assertIn(str(self.source), args)
        self.assertIn(f"-DCMAKE_INSTALL_PREFIX={self.install}", args)

    def test_wrong_commit_is_rejected_before_configure(self):
        self.stub("git", 'case "$3" in rev-parse) echo deadbeef;; esac')
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pinned COLMAP", result.stderr)
        self.assertFalse(self.log.exists())

    def test_alpha_profile_removes_unused_restricted_components(self):
        result = self.run_recipe("--alpha-profile")
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text())
        for flag in ("LSD", "CGAL", "MVS", "DOWNLOAD"):
            self.assertIn(f"-D{flag}_ENABLED=OFF", args)

    def test_dirty_source_is_preserved_and_rejected(self):
        self.stub("git", f'case "$3" in rev-parse) echo {COMMIT};; status) echo " M CMakeLists.txt";; esac')
        result = self.run_recipe()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contains changes", result.stderr)
        self.assertFalse(self.log.exists())

    def test_non_arm64_host_is_rejected(self):
        self.stub("uname", 'case "$1" in -s) echo Darwin;; -m) echo x86_64;; esac')
        self.assertIn("Apple Silicon", self.run_recipe().stderr)
        self.assertFalse(self.log.exists())

    def test_missing_option_value_has_actionable_failure(self):
        result = self.run_recipe("--jobs")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing value", result.stderr)

    def test_zero_jobs_is_rejected(self):
        self.assertIn("positive integer", self.run_recipe("--jobs", "0").stderr)

    def test_build_inside_source_is_rejected(self):
        result = self.run_recipe("--build-dir", str(self.source / "build"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.source / "build").exists())

    def test_symlink_into_source_is_rejected_before_creating_directories(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        result = self.run_recipe("--build-dir", str(alias / "new-build"))
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.source / "new-build").exists())

    def test_failed_configure_is_not_reported_as_success(self):
        self.stub("cmake", 'if [ "$1" != --version ]; then exit 17; fi')
        self.assertEqual(self.run_recipe().returncode, 17)

    def test_failed_rebuild_clears_stale_success_evidence(self):
        (self.build / "help").mkdir(parents=True)
        stale = ("build-success.txt", "build-info.json", "colmap.sha256", "colmap-load-commands.txt",
                 "colmap-dylibs.txt", "help/feature_extractor.txt")
        for name in stale:
            (self.build / name).write_text("old success")
        self.stub("cmake", 'if [ "$1" != --version ]; then exit 17; fi')
        self.assertEqual(self.run_recipe().returncode, 17)
        for name in stale:
            self.assertFalse((self.build / name).exists(), name)


class ColmapHelpContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "colmap.txt").write_text(
            "COLMAP 4.1.0 (Commit fa8e3b3f on 2026-06-26 without CUDA)\n"
        )
        for command, flags in REQUIRED_FLAGS.items():
            (self.root / f"{command}.txt").write_text(
                "\n".join(f"  --{flag} arg" for flag in sorted(flags))
            )

    def test_accepts_pinned_cpu_contract(self):
        validate_help(self.root)

    def test_rejects_cuda_build(self):
        (self.root / "colmap.txt").write_text(
            "COLMAP 4.1.0 (Commit fa8e3b3f on 2026-06-26 with CUDA)\n"
        )
        with self.assertRaisesRegex(ValueError, "without CUDA"):
            validate_help(self.root)

    def test_requires_global_mapper_cpu_flag_even_when_help_exits_zero(self):
        path = self.root / "global_mapper.txt"
        path.write_text(path.read_text().replace("  --GlobalMapper.gp_use_gpu arg", ""))
        with self.assertRaisesRegex(ValueError, "GlobalMapper.gp_use_gpu"):
            validate_help(self.root)

    def test_documented_flag_in_prose_is_not_an_available_option(self):
        path = self.root / "feature_extractor.txt"
        path.write_text(path.read_text().replace(
            "  --FeatureExtraction.use_gpu arg", "See --FeatureExtraction.use_gpu in another version"
        ))
        with self.assertRaisesRegex(ValueError, "FeatureExtraction.use_gpu"):
            validate_help(self.root)


if __name__ == "__main__":
    unittest.main()
