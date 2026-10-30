import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("prepare_brush_source", Path(__file__).with_name("prepare-brush-source.py"))
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class BrushPatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="brush patch 中文 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git("init", "--quiet")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.file = self.source / "file.txt"
        self.file.write_text("original\n")
        self.git("add", "file.txt")
        self.git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
        self.commit = self.git("rev-parse", "HEAD").decode().strip()
        self.git("checkout", "--quiet", "--detach", self.commit)
        self.file.write_text("patched\n")
        self.patch = self.root / "fixed.patch"
        self.patch.write_bytes(self.git(*PREPARE.DIFF_ARGS))
        self.file.write_text("original\n")
        self.hash = hashlib.sha256(self.patch.read_bytes()).hexdigest()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.source), *args], check=True,
                              capture_output=True).stdout

    def prepare(self):
        return PREPARE.prepare(self.source, self.patch, self.commit, self.hash)

    def test_apply_then_retry_accepts_exact_patch(self):
        self.assertEqual(self.prepare(), "applied")
        self.assertEqual(self.file.read_text(), "patched\n")
        self.assertEqual(self.prepare(), "already_applied")
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.commit)

    def test_active_branch_is_preserved_and_rejected(self):
        self.git("checkout", "--quiet", "-b", "user-main")
        with self.assertRaisesRegex(ValueError, "detached"):
            self.prepare()
        self.assertEqual(self.file.read_text(), "original\n")

    def test_other_changes_are_preserved_and_rejected(self):
        self.file.write_text("user edit\n")
        with self.assertRaisesRegex(ValueError, "other than"):
            self.prepare()
        self.assertEqual(self.file.read_text(), "user edit\n")

    def test_tampered_patch_is_rejected(self):
        self.patch.write_bytes(self.patch.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.prepare()
        self.assertEqual(self.file.read_text(), "original\n")

    def test_untracked_files_are_preserved_and_rejected(self):
        extra = self.source / "untracked.rs"
        extra.write_text("user data")
        with self.assertRaisesRegex(ValueError, "untracked"):
            self.prepare()
        self.assertEqual(extra.read_text(), "user data")

    def test_staged_changes_are_preserved_and_rejected(self):
        self.file.write_text("user edit\n")
        self.git("add", "file.txt")
        with self.assertRaisesRegex(ValueError, "staged"):
            self.prepare()
        self.assertEqual(self.file.read_text(), "user edit\n")

    def test_wrong_revision_is_rejected(self):
        self.commit = "0" * 40
        with self.assertRaisesRegex(ValueError, "commit"):
            self.prepare()
        self.assertEqual(self.file.read_text(), "original\n")

    def test_repository_patch_checksum_is_pinned(self):
        self.assertEqual(hashlib.sha256(PREPARE.PATCH.read_bytes()).hexdigest(), PREPARE.PATCH_SHA256)
        recipe = Path(__file__).with_name("build-brush.sh").read_text()
        self.assertIn("patch_sha256=" + PREPARE.PATCH_SHA256, recipe)
        self.assertIn("patch_id=" + PREPARE.PATCH_ID, recipe)
        for profile, (patch, checksum) in PREPARE.PROFILES.items():
            self.assertEqual(hashlib.sha256(patch.read_bytes()).hexdigest(), checksum)
            self.assertIn("patch_sha256=" + checksum, recipe)
            self.assertIn("patch_id=" + profile, recipe)

    def test_new_file_patch_is_tracked_without_staging_user_content(self):
        extra = self.source / "new-module.rs"
        extra.write_text("pub fn new_module() {}\n")
        self.git("add", "-N", "new-module.rs")
        self.patch.write_bytes(self.git(*PREPARE.DIFF_ARGS))
        self.git("reset", "--quiet", "HEAD", "--", "new-module.rs")
        extra.unlink()
        self.hash = hashlib.sha256(self.patch.read_bytes()).hexdigest()
        self.assertEqual(self.prepare(), "applied")
        self.assertEqual(self.git("diff", "--cached"), b"")
        self.assertEqual(self.prepare(), "already_applied")

    def test_verify_never_applies_missing_patch(self):
        with self.assertRaisesRegex(ValueError, "not applied"):
            PREPARE.prepare(self.source, self.patch, self.commit, self.hash, apply=False)
        self.assertEqual(self.file.read_text(), "original\n")
        self.prepare()
        self.assertEqual(PREPARE.prepare(self.source, self.patch, self.commit, self.hash, apply=False),
                         "already_applied")


if __name__ == "__main__":
    unittest.main()
