"""Execute delivered recipe entry points without engines, downloads or compilation."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from pack_licenses import (REBUILD_REPOSITORY_FILES, collect_ffmpeg_licenses,
                           collect_licenses, deliver_rebuild_repository)


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pack_rebuild_materials", Path(__file__).with_name("pack-engines.py"))
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)
BASH = "/bin/bash" if Path("/bin/bash").is_file() else shutil.which("bash")


class RebuildMaterialsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rebuild materials 中文 ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.repo = self.root / "recipe checkout"
        for name in REBUILD_REPOSITORY_FILES:
            destination = self.repo / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, destination)
        self.stage = self.root / "fresh pack"
        self.environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        self.environment.pop("PYTHONPATH", None)
        self.environment.pop("PYTHONHOME", None)

    def write(self, relative, value):
        file = self.repo / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value, encoding="utf-8")
        return file

    def python(self, script, *args):
        result = subprocess.run([sys.executable, str(script), *args], cwd=self.root,
                                env=self.environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def assert_executable_tree(self, engine):
        provenance = self.stage / engine / "provenance"
        repository = provenance / "packaging/repository"
        receipt = json.loads((provenance / "packaging/rebuild-materials.json").read_text())
        self.assertEqual(receipt["repository"], "provenance/packaging/repository")
        for name in REBUILD_REPOSITORY_FILES:
            self.assertEqual((repository / name).read_bytes(), (self.repo / name).read_bytes(), name)
        self.python(repository / "scripts/macos/pack-engines.py", "--help")
        self.python(repository / "scripts/macos/pack_licenses.py", "--help")
        resolved = self.python(repository / "scripts/shared/engine_paths.py", "--key", "ffmpegBuild")
        self.assertTrue(Path(resolved.stdout.strip()).is_relative_to(repository))
        self.assertFalse((repository / ".cache").exists())
        if BASH:
            for name in ("build-ffmpeg.sh", "build-colmap.sh", "build-brush.sh"):
                result = subprocess.run([BASH, str(repository / "scripts/macos" / name), "--help"],
                                        cwd=self.root, env=self.environment, capture_output=True,
                                        text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Usage:", result.stdout)
        # Rebuild tree is closed under the Brush patch/policy imports too.
        self.python("-c", "import hashlib,importlib.util,pathlib,sys; "
                    "p=pathlib.Path(sys.argv[1]); "
                    "s=importlib.util.spec_from_file_location('brush',p); "
                    "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                    "assert all(hashlib.sha256(p.read_bytes()).hexdigest()==h "
                    "for p,h in m.PROFILES.values())",
                    str(repository / "scripts/macos/prepare-brush-source.py"))
        self.assertIn("evidence snapshots", (provenance / "packaging/README.md").read_text())
        return repository

    def test_ffmpeg_collector_delivers_runnable_tree_and_keeps_flat_build_snapshot(self):
        self.write("work/ffmpeg-build/build-info.json", json.dumps({
            "version": "8.1.2", "license": "LGPL-2.1-or-later", "source_commit": "a" * 40}))
        self.write("work/ffmpeg-build/build-environment.txt", "original fixture environment\n")
        self.write("work/ffmpeg-build/config.h", "original fixture configuration\n")
        self.write("work/ffmpeg-install/share/licenses/ffmpeg/LICENSE", "fixture LGPL notice\n")
        report = collect_ffmpeg_licenses(self.repo, self.stage,
            ffmpeg_build=self.repo / "work/ffmpeg-build", ffmpeg_source=self.repo / "work/source",
            ffmpeg_install=self.repo / "work/ffmpeg-install")
        self.assertIn("rebuild_materials", report)
        self.assertEqual((self.stage / "ffmpeg/provenance/build/build-ffmpeg.sh").read_bytes(),
                         (self.repo / "scripts/macos/build-ffmpeg.sh").read_bytes())
        self.assert_executable_tree("ffmpeg")

    def test_colmap_collector_delivers_runnable_tree_and_preserves_recorded_build_text(self):
        build = self.repo / "work/colmap-build"
        self.write("work/colmap-build/build-info.json", json.dumps({"version": "4.1.0", "source_commit": "b" * 40}))
        self.write("work/colmap-build/build.ninja", "build src/colmap/exe/colmap: CXX_EXECUTABLE_LINKER\n")
        original = "CGAL_ENABLED:BOOL=OFF\nLSD_ENABLED:BOOL=OFF\n"
        self.write("work/colmap-build/CMakeCache.txt", original)
        self.write("work/colmap-source/COPYING.txt", "fixture COLMAP notice\n")
        report = collect_licenses(self.repo, [], self.stage, colmap_build=build,
            colmap_source=self.repo / "work/colmap-source", conda_prefix=self.repo / "work/prefix",
            conda_cache=self.repo / "work/packages")
        self.assertIn("rebuild_materials", report)
        self.assertEqual((self.stage / "colmap/provenance/build/CMakeCache.txt").read_text(), original)
        self.assert_executable_tree("colmap")

    def test_brush_pack_producer_keeps_flat_snapshots_and_a_self_contained_recipe_tree(self):
        pack.deliver_packaging_recipes(self.repo, self.stage / "brush")
        self.assertEqual((self.stage / "brush/provenance/packaging/pack-engines.py").read_bytes(),
                         (self.repo / "scripts/macos/pack-engines.py").read_bytes())
        repository = self.assert_executable_tree("brush")
        # A delivered tree can itself deliver the next complete recipe tree.
        next_engine = self.root / "next candidate/brush"
        delivered = deliver_rebuild_repository(repository, next_engine)
        next_tree = next_engine / delivered["repository"]
        self.python(next_tree / "scripts/macos/pack-engines.py", "--help")

    def test_missing_dependency_fails_before_delivery_and_conflicting_snapshot_is_preserved(self):
        helper = self.repo / "scripts/shared/engine_paths.py"
        helper.unlink()
        with self.assertRaisesRegex(ValueError, "Missing or nonphysical rebuild input"):
            deliver_rebuild_repository(self.repo, self.stage / "brush")
        self.assertFalse((self.stage / "brush").exists())
        shutil.copyfile(ROOT / "scripts/shared/engine_paths.py", helper)
        deliver_rebuild_repository(self.repo, self.stage / "brush")
        snapshot = self.stage / "brush/provenance/packaging/repository/scripts/shared/engine_paths.py"
        snapshot.write_text("preserve previous snapshot", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Conflicting rebuild input snapshot"):
            deliver_rebuild_repository(self.repo, self.stage / "brush")
        self.assertEqual(snapshot.read_text(), "preserve previous snapshot")


if __name__ == "__main__":
    unittest.main()
