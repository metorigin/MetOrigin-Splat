"""Engine layout, source selection and historical evidence access contracts."""

import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/shared"))
from engine_paths import map_legacy_path, resolve_engine_paths
from pack_licenses import collect_licenses, dependency_source_paths

spec = importlib.util.spec_from_file_location("pack_engine_paths_fixture", Path(__file__).with_name("pack-engines.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)


class EnginePathsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="engine paths 中文 ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        destination = self.root / "packaging/shared"
        destination.mkdir(parents=True)
        for name in ("engine-paths.json", "cache-paths.json", "artifact-paths.json"):
            shutil.copyfile(ROOT / "packaging/shared" / name, destination / name)
        self.config_path = destination / "engine-paths.json"
        self.config = json.loads(self.config_path.read_text())

    def save(self):
        self.config_path.write_text(json.dumps(self.config))

    def test_reader_uses_all_three_configured_bases_without_creating_outputs(self):
        result = resolve_engine_paths(self.root)
        self.assertEqual(result["distributionEngines"], self.root / ".engines/macos-arm64/distribution/engines")
        self.assertEqual(result["releaseStatus"], result["distributionRoot"] / "release-status.json")
        self.assertEqual(result["ffmpegSource"], self.root / ".cache/metorigin/sources/engines/macos-arm64/ffmpeg-8.1.2")
        self.assertTrue(result["legacy.m0.brush-evidence"].is_relative_to(self.root / "artifacts/verification/macos-arm64"))
        self.assertFalse((self.root / ".cache").exists())
        self.assertFalse((self.root / ".engines").exists())
        self.assertFalse((self.root / "artifacts").exists())

    @unittest.skipUnless(shutil.which("node"), "Node is required for the cross-language configuration contract")
    def test_python_paths_equal_the_node_reader_for_the_same_checkout(self):
        result = subprocess.run([shutil.which("node"), str(ROOT / "scripts/shared/engine-paths.mjs"),
                                 "--repo-root", str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({key: str(value) for key, value in resolve_engine_paths(self.root).items()}, json.loads(result.stdout))

    def test_roots_are_configuration_driven_and_runtime_roots_must_belong_to_engines(self):
        self.config["engines_root"] = "local engines"
        self.save()
        cache_path = self.root / "packaging/shared/cache-paths.json"
        cache = json.loads(cache_path.read_text()); cache["root"] = "local cache"
        cache_path.write_text(json.dumps(cache))
        result = resolve_engine_paths(self.root)
        self.assertTrue(result["developmentRoot"].is_relative_to(self.root / "local engines"))
        self.assertTrue(result["ffmpegSource"].is_relative_to(self.root / "local cache"))
        self.config["platforms"]["macos-arm64"]["paths"]["developmentRoot"]["base"] = "cache"
        self.save()
        with self.assertRaises(ValueError): resolve_engine_paths(self.root)

    def test_invalid_schemas_and_escaping_paths_fail_before_creating_directories(self):
        for value in (0, 2, True, "1"):
            self.config["schema_version"] = value; self.save()
            with self.assertRaises(ValueError): resolve_engine_paths(self.root)
        self.config["schema_version"] = 1
        for value in ("../outside", "/outside", "C:\\outside", "cache/../other", "."):
            self.config["engines_root"] = value; self.save()
            with self.assertRaises(ValueError): resolve_engine_paths(self.root)
        self.config["engines_root"] = ".engines"
        self.config["platforms"]["macos-arm64"]["paths"]["ffmpegSource"]["base"] = "unknown"
        self.save()
        with self.assertRaises(ValueError): resolve_engine_paths(self.root)
        self.assertFalse((self.root / ".engines").exists())
        self.assertFalse((self.root / ".cache").exists())

    def test_legacy_mapping_is_lexical_local_and_prefers_the_longest_prefix(self):
        selected = self.config["platforms"]["macos-arm64"]
        selected["paths"]["narrow"] = {"base": "cache", "path": "narrow target"}
        selected["legacy_mappings"]["target/macos-m0/colmap-build/_deps/poselib-src"] = {"key": "narrow"}
        self.save()
        original = self.root / "target/macos-m0/colmap-build/_deps/poselib-src/LICENSE"
        self.assertEqual(map_legacy_path(original, self.root), self.root / ".cache/metorigin/narrow target/LICENSE")
        external = self.root.parent / "another checkout/target/macos-m0/colmap-build/file"
        self.assertEqual(map_legacy_path(external, self.root), external)
        unchanged = self.root / "unrelated/file"
        self.assertEqual(map_legacy_path(unchanged, self.root), unchanged)
        self.assertFalse((self.root / "target").exists())

    def test_historical_prefix_and_development_install_map_to_original_evidence_not_new_runtime(self):
        paths = resolve_engine_paths(self.root)
        old_prefix = self.root / "target/macos-m0/colmap-deps/lib/original.dylib"
        self.assertEqual(map_legacy_path(old_prefix, self.root),
                         paths["colmapAlphaDependencyEvidence"] / "lib/original.dylib")
        self.assertNotEqual(map_legacy_path(old_prefix, self.root),
                            paths["colmapDependencyPrefix"] / "lib/original.dylib")
        old_binary = self.root / "target/macos-m0/colmap-install/bin/colmap"
        self.assertEqual(map_legacy_path(old_binary, self.root),
                         paths["colmapOriginalDevelopmentEvidence"] / "bin/colmap")
        self.assertNotEqual(paths["colmapOriginalDevelopmentEvidence"], paths["colmapInstall"])
        self.assertFalse((self.root / "target").exists())

    def test_legacy_evidence_reader_maps_dependency_license_and_sibling_stamp_without_rewriting_cache(self):
        old_source = self.root / "target/macos-m0/colmap-build/_deps/poselib-src"
        text = f"FETCHCONTENT_SOURCE_DIR_POSELIB:PATH={old_source}\n"
        build = resolve_engine_paths(self.root)["colmapAlphaBuildEvidence"]
        source, stamp = dependency_source_paths(self.root, build, "poselib", text)
        source.mkdir(parents=True)
        (source / "LICENSE").write_text("exact historical source notice")
        stamp.parent.mkdir(parents=True)
        stamp.write_text("url(s)=https://example.invalid/fixed.tar.gz\nhash=SHA256=" + "a" * 64)
        self.assertEqual(source, resolve_engine_paths(self.root)["colmapDevelopmentBuildEvidence"] / "_deps/poselib-src")
        self.assertEqual((source / "LICENSE").read_text(), "exact historical source notice")
        self.assertIn("fixed.tar.gz", stamp.read_text())
        self.assertEqual(text, f"FETCHCONTENT_SOURCE_DIR_POSELIB:PATH={old_source}\n")
        self.assertFalse((self.root / "target").exists())

    def test_pack_defaults_follow_repo_root_and_the_artifact_profile(self):
        artifact = self.root / "immutable Brush .6"
        artifact.mkdir()
        (artifact / "build-info.json").write_text(json.dumps({"patch_id": "metorigin-macos.6"}))
        _, args = pack.parse_arguments(["--repo-root", str(self.root), "--brush-artifact", str(artifact)])
        repo, inputs = pack.resolve_pack_inputs(args)
        expected = resolve_engine_paths(self.root)
        self.assertEqual(repo, self.root)
        self.assertEqual(inputs["output"], expected["distributionEngines"])
        self.assertEqual(inputs["brush_source"], expected["brushSource.6"])
        self.assertEqual(inputs["colmap_build"], expected["colmapAlphaBuildEvidence"])
        self.assertEqual(inputs["ffmpeg_build"], expected["ffmpegBuildEvidence"])
        self.assertEqual(inputs["conda_prefix"], expected["colmapAlphaDependencyEvidence"])
        self.assertNotEqual(inputs["conda_prefix"], expected["colmapDependencyPrefix"])
        self.assertEqual(args.pack_version, "0.1.0-alpha.1")
        self.assertFalse((self.root / ".engines").exists())
        self.assertFalse((self.root / "target").exists())

    def test_explicit_pack_paths_override_defaults_and_unknown_profile_requires_explicit_source(self):
        artifact = self.root / "custom artifact"; artifact.mkdir()
        (artifact / "build-info.json").write_text('{"patch_id":"unrecognized"}')
        command = ["--repo-root", str(self.root), "--brush-artifact", str(artifact)]
        _, args = pack.parse_arguments(command)
        with self.assertRaisesRegex(ValueError, "--brush-source"): pack.resolve_pack_inputs(args)
        paths = {"brush-source": self.root / "selected source", "ffmpeg-install": self.root / "selected ffmpeg",
                 "colmap-build": self.root / "selected build", "output": self.root / "candidate",
                 "conda-prefix": self.root / "explicit current development prefix"}
        for option, value in paths.items():command.extend(["--" + option, str(value)])
        _, args = pack.parse_arguments(command)
        _, inputs = pack.resolve_pack_inputs(args)
        for key, value in paths.items(): self.assertEqual(inputs[key.replace("-", "_")], value)

    def test_default_license_ownership_uses_original_prefix_and_explicit_current_audit_is_independent(self):
        paths = resolve_engine_paths(self.root)
        build = paths["colmapDevelopmentBuildEvidence"]
        build.mkdir(parents=True)
        (build / "build-info.json").write_text(json.dumps({"version": "4.1.0", "source_commit": "a" * 40}))
        (build / "build.ninja").write_text("build src/colmap/exe/colmap: CXX_EXECUTABLE_LINKER\n")
        (build / "CMakeCache.txt").write_text("CGAL_ENABLED:BOOL=OFF\n")
        source = paths["colmapSource"]; source.mkdir(parents=True)
        (source / "COPYING.txt").write_text("fixture COLMAP notice")
        scripts = self.root / "scripts/macos"; scripts.mkdir(parents=True)
        for name in ["build-colmap.sh", "colmap-m0-deps.explicit.txt"]:
            shutil.copyfile(ROOT / "scripts/macos" / name, scripts / name)
        libraries = {}
        for key, package in [("colmapAlphaDependencyEvidence", "original-fixture"),
                             ("colmapDependencyPrefix", "relocated-fixture")]:
            prefix = paths[key]
            (prefix / "conda-meta").mkdir(parents=True)
            library = prefix / "lib/libfixture.dylib"
            library.parent.mkdir(); library.write_bytes(package.encode())
            libraries[key] = library
            (prefix / "conda-meta" / f"{package}-1.0-0.json").write_text(json.dumps({
                "name": package, "version": "1.0", "build": "0", "files": ["lib/libfixture.dylib"],
                "license": "MIT"}))
        # Recipe delivery has its own executable-tree tests; isolate this
        # original-vs-current ownership decision from copying the recipe closure.
        with patch("pack_licenses.deliver_rebuild_repository", return_value={}):
            original = collect_licenses(self.root, [libraries["colmapAlphaDependencyEvidence"]],
                                        self.root / "original-audit")
            current = collect_licenses(self.root, [libraries["colmapDependencyPrefix"]],
                                       self.root / "current-audit", conda_prefix=paths["colmapDependencyPrefix"])
        original_names = {component["name"] for component in original["components"]}
        current_names = {component["name"] for component in current["components"]}
        self.assertIn("original-fixture", original_names)
        self.assertNotIn("relocated-fixture", original_names)
        self.assertIn("relocated-fixture", current_names)
        self.assertNotIn("original-fixture", current_names)


class NativeEngineDefaultTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="native engine defaults 中文 ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        for relative in ("scripts/shared/engine_paths.py", "packaging/shared/engine-paths.json",
                         "packaging/shared/cache-paths.json", "packaging/shared/artifact-paths.json",
                         "scripts/macos/build-ffmpeg.sh", "scripts/macos/build-colmap.sh", "scripts/macos/build-brush.sh"):
            destination = self.root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, destination)
        self.paths = resolve_engine_paths(self.root)
        self.bin = self.root / "tools"; self.bin.mkdir()
        self.log = self.root / "tool-arguments.json"
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", NATIVE_RECIPE_LOG=str(self.log))
        for key in ("CARGO_HOME", "CARGO_TARGET_DIR", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"):
            self.env.pop(key, None)
        self.tool("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.tool("git", '''case "$*" in
  *--is-inside-work-tree*) echo true;;
  *"rev-parse HEAD"*) echo "$NATIVE_RECIPE_COMMIT";;
  *status*) ;;
esac''')
        self.tool("xcrun", 'case "$*" in *--find*) echo /usr/bin/true;; *) echo /fake/sdk;; esac')
        for name in ("make", "ninja", "otool", "lipo", "sw_vers", "xcodebuild"):
            self.tool(name, "exit 0")
        self.tool("rustc", 'echo "rustc 1.95.0 (fixture)"')
        self.tool("python3", f'''if [[ "$1" == *prepare-brush-source.py ]]; then exit 0; fi
exec {shlex.quote(sys.executable)} "$@"''')
        self.tool("cmake", f'''if [[ "$1" == --version ]]; then echo fixture; exit 0; fi
exec {shlex.quote(sys.executable)} -c 'import json,os,sys; json.dump(sys.argv[1:],open(os.environ["NATIVE_RECIPE_LOG"],"w"))' "$@"''')
        self.tool("cargo", f'''if [[ "$1" == --version ]]; then echo 'cargo 1.95.0 (fixture)'; exit 0; fi
{shlex.quote(sys.executable)} -c 'import json,os; json.dump({{"home":os.environ["CARGO_HOME"],"target":os.environ["CARGO_TARGET_DIR"],"cwd":os.getcwd()}},open(os.environ["NATIVE_RECIPE_LOG"],"w"))'
exit 43''')

    def tool(self, name, body):
        file = self.bin / name
        file.write_text("#!/bin/bash\nset -e\n" + body + "\n")
        file.chmod(0o755)

    def source(self, key):
        source = self.paths[key]
        (source / ".git").mkdir(parents=True)
        return source

    def test_ffmpeg_no_output_overrides_use_fresh_build_install_and_leave_imported_evidence(self):
        source = self.source("ffmpegSource")
        configure = source / "configure"
        configure.write_text(f'''#!/bin/bash
exec {shlex.quote(sys.executable)} -c 'import json,os,sys; json.dump(sys.argv[1:],open(os.environ["NATIVE_RECIPE_LOG"],"w"))' "$@"
''')
        configure.chmod(0o755)
        imported = self.paths["ffmpegBuildEvidence"] / "build-info.json"
        imported.parent.mkdir(parents=True); imported.write_text("preserve imported receipt")
        result = subprocess.run(["/bin/bash", str(self.root / "scripts/macos/build-ffmpeg.sh"), "--configure-only"],
                                env=dict(self.env, NATIVE_RECIPE_COMMIT="38b88335f99e76ed89ff3c93f877fdefce736c13"), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--prefix=" + str(self.paths["ffmpegBuildInstall"]), json.loads(self.log.read_text()))
        self.assertTrue((self.paths["ffmpegBuild"] / "build-environment.txt").exists())
        self.assertEqual(imported.read_text(), "preserve imported receipt")
        self.assertFalse((self.root / "target").exists())

    def test_colmap_profiles_have_distinct_fresh_outputs_and_optional_deps_prefix_remains_explicit(self):
        self.source("colmapSource")
        for flags, build_key, install_key in [([], "colmapBuild", "colmapBuildInstall"),
                                              (["--alpha-profile"], "colmapAlphaBuild", "colmapAlphaBuildInstall")]:
            with self.subTest(flags=flags):
                result = subprocess.run(["/bin/bash", str(self.root / "scripts/macos/build-colmap.sh"), "--configure-only", *flags],
                                        env=dict(self.env, NATIVE_RECIPE_COMMIT="fa8e3b3ff591552855f8ad2806723c80f963f69c"), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                args = json.loads(self.log.read_text())
                self.assertIn(str(self.paths[build_key]), args)
                self.assertIn("-DCMAKE_INSTALL_PREFIX=" + str(self.paths[install_key]), args)
                self.assertFalse(any(arg.startswith("-DCMAKE_PREFIX_PATH=") for arg in args))
        self.assertFalse(self.paths["colmapDevelopmentBuildEvidence"].exists())
        self.assertFalse(self.paths["colmapAlphaBuildEvidence"].exists())
        self.assertFalse((self.root / "target").exists())

    def test_brush_profile_defaults_share_download_cache_but_use_fresh_target_and_honor_environment(self):
        source = self.root / "explicit Brush source"; source.mkdir(); (source / "Cargo.lock").write_text("version = 4\n")
        for flag, profile in [(None, "6"), ("--lpips-policy-patch", "5"), ("--training-contract-patch", "3"), ("--stock", "stock")]:
            with self.subTest(flag=flag):
                args = ["/bin/bash", str(self.root / "scripts/macos/build-brush.sh")]
                if flag: args.append(flag)
                args.append(str(source))
                result = subprocess.run(args, env=dict(self.env, NATIVE_RECIPE_COMMIT="1388f74c6fe0236f68ee4915564bf00e9d2e3747"), capture_output=True, text=True)
                self.assertEqual(result.returncode, 43, result.stdout + result.stderr)
                record = json.loads(self.log.read_text())
                self.assertEqual(record["home"], str(self.paths["cargoHome"]))
                self.assertEqual(record["target"], str(self.paths["brushBuild." + profile] / "target"))
                self.assertEqual(record["cwd"], str(source))
        chosen_home, chosen_target = self.root / "chosen Cargo home", self.root / "chosen Cargo target"
        result = subprocess.run(["/bin/bash", str(self.root / "scripts/macos/build-brush.sh"), "--stock", str(source)],
                                env=dict(self.env, NATIVE_RECIPE_COMMIT="1388f74c6fe0236f68ee4915564bf00e9d2e3747", CARGO_HOME=str(chosen_home), CARGO_TARGET_DIR=str(chosen_target)), capture_output=True, text=True)
        self.assertEqual(result.returncode, 43, result.stderr)
        record = json.loads(self.log.read_text())
        self.assertEqual(record["home"], str(chosen_home))
        self.assertEqual(record["target"], str(chosen_target))
        self.assertFalse((self.root / "target").exists())


if __name__ == "__main__":
    unittest.main()
