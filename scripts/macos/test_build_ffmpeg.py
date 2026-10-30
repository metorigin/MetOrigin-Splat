"""Recipe contracts; synthetic command output is not media or release evidence."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from verify_ffmpeg_build import validate_links, validate_version

SCRIPT = Path(__file__).with_name("build-ffmpeg.sh")
COMMIT = "38b88335f99e76ed89ff3c93f877fdefce736c13"


class FfmpegBuildRecipeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ffmpeg recipe 测试 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.source = self.root / "source"
        (self.source / ".git").mkdir(parents=True)
        self.build = self.root / "build output"
        self.install = self.root / "install output"
        self.log = self.root / "args.json"
        self.env = dict(os.environ, PATH=f"{self.bin}:/usr/bin:/bin", RECIPE_LOG=str(self.log))
        self.stub("uname", 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.stub("git", f'case "$3" in rev-parse) echo {COMMIT};; status) ;; esac')
        self.stub("xcrun", 'case "$*" in *--find*) echo /usr/bin/true;; *--show-sdk-path*) echo /fake/sdk;; *) echo 27.0;; esac')
        for tool in ("make", "lipo", "otool", "sw_vers"):
            self.stub(tool, "exit 0")
        self.configure('''/usr/bin/python3 -c 'import json,os,sys; json.dump(sys.argv[1:],open(os.environ["RECIPE_LOG"],"w"))' "$@"''')

    def stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def configure(self, body):
        path = self.source / "configure"
        path.write_text("#!/bin/bash\n" + body + "\n")
        path.chmod(0o755)

    def run_recipe(self, *extra):
        return subprocess.run(
            ["/bin/bash", str(SCRIPT), "--source", str(self.source),
             "--build-dir", str(self.build), "--install-dir", str(self.install),
             "--configure-only", *extra],
            env=self.env, capture_output=True, text=True, check=False,
        )

    def test_explicit_lgpl_arm64_and_relocatable_configuration(self):
        result = self.run_recipe()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = json.loads(self.log.read_text())
        for flag in ("--arch=arm64", "--disable-gpl", "--disable-nonfree",
                     "--disable-version3", "--disable-autodetect", "--disable-network",
                     "--enable-shared", "--disable-static", "--enable-zlib",
                     "--install-name-dir=@rpath", "--disable-stripping"):
            self.assertIn(flag, args)
        self.assertIn(f"--prefix={self.install}", args)
        self.assertIn("--extra-ldexeflags=-Wl,-rpath,@executable_path/../lib", args)
        self.assertIn("--host-cflags=-isysroot /fake/sdk -mmacosx-version-min=15.0", args)

    def test_source_identity_and_changes_are_checked_before_configure(self):
        for output in ("wrong-commit", COMMIT):
            self.stub("git", f'case "$3" in rev-parse) echo {output};; status) echo " M configure";; esac')
            self.assertNotEqual(self.run_recipe().returncode, 0)
            self.assertFalse(self.log.exists())

    def test_overlapping_paths_and_symlink_are_rejected_before_mkdir(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        for path in (self.source / "build", alias / "build", self.root, self.install):
            self.assertNotEqual(self.run_recipe("--build-dir", str(path)).returncode, 0)
        self.assertFalse((self.source / "build").exists())
        self.assertFalse(self.log.exists())

    def test_failed_rebuild_clears_stale_evidence(self):
        self.build.mkdir()
        evidence = self.build / "build-info.json"
        evidence.write_text('{}')
        self.configure("exit 19")
        self.assertEqual(self.run_recipe().returncode, 19)
        self.assertFalse(evidence.exists())


class FfmpegVerificationTests(unittest.TestCase):
    def test_requires_exact_version_and_safe_license_flags(self):
        output = "ffmpeg version 8.1.2\nconfiguration: --disable-gpl --disable-version3 --disable-nonfree --disable-autodetect --disable-network --enable-shared --disable-static --enable-zlib\n"
        validate_version(output, "ffmpeg")
        for modified in (output.replace("8.1.2", "8.1.20"),
                         output.replace("--disable-gpl", "--enable-gpl"),
                         output + " --enable-nonfree"):
            with self.assertRaises(ValueError):
                validate_version(modified, "ffmpeg")

    def test_accepts_only_system_or_bundled_dylib_links(self):
        output = "ffmpeg:\n\t@rpath/libavcodec.62.dylib (compatibility version 62.0.0, current version 62.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n"
        self.assertEqual(len(validate_links(output)), 2)
        for dependency in ("/opt/homebrew/lib/libavcodec.dylib", "/Users/test/deps/lib/libz.dylib", "libz.dylib"):
            with self.assertRaises(ValueError):
                validate_links("ffmpeg:\n\t" + dependency)


if __name__ == "__main__":
    unittest.main()
