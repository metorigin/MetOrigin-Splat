import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SPEC = importlib.util.spec_from_file_location("fixture", Path(__file__).parents[1] / "prepare-smoke-fixture.py")
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class FixtureTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.archive = self.root / "images.zip"
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as zipped:
            for name in ("a.jpg", "b.jpg", "c.jpg"):
                zipped.writestr(name, b"image bytes " + name.encode())
            zipped.writestr("unused.bin", b"x" * 200000)
        self.data = self.archive.read_bytes()
        self.prefix = self.root / "prefix.zip"
        self.prefix.write_bytes(self.data[:1000])
        self.tail = self.root / "tail.bin"
        self.tail.write_bytes(self.data[-65536:])
        self.patches = [patch.object(fixture, "ARCHIVE_SIZE", len(self.data)),
                        patch.object(fixture, "ARCHIVE_MD5", hashlib.md5(self.data).hexdigest()),
                        patch.object(fixture, "ARCHIVE_SHA256", hashlib.sha256(self.data).hexdigest()),
                        patch.object(fixture, "FILES", ["a.jpg", "b.jpg", "c.jpg"])]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in self.patches:
            item.stop()
        self.temporary.cleanup()

    def test_full_archive_checks_provider_digest_and_records_sha256(self):
        result = fixture.prepare(self.archive, self.root / "out")
        self.assertEqual(result["archive"]["whole_archive_verification"], "passed")
        self.assertEqual(result["archive"]["sha256"], hashlib.sha256(self.data).hexdigest())
        self.assertEqual(len(result["images"]), 3)

    def test_partial_archive_only_claims_entry_integrity(self):
        result = fixture.prepare(self.prefix, self.root / "out", self.tail)
        self.assertEqual(result["archive"]["whole_archive_verification"], "pending_partial_download")
        self.assertNotIn("sha256", result["archive"])
        self.assertEqual(len(result["images"]), 3)
        self.assertEqual((self.root / "out/images/a.jpg").read_bytes(), b"image bytes a.jpg")

    def test_partial_missing_bytes_fail_without_output_fixture(self):
        with patch.object(fixture, "FILES", ["unused.bin"]):
            with self.assertRaisesRegex(ValueError, "not downloaded"):
                fixture.prepare(self.prefix, self.root / "out", self.tail)
        self.assertFalse((self.root / "out").exists())

    def test_corrupted_entry_fails_crc_even_in_partial_mode(self):
        corrupted = bytearray(self.prefix.read_bytes())
        offset = corrupted.index(b"image bytes a.jpg")
        corrupted[offset] ^= 1
        self.prefix.write_bytes(corrupted)
        with self.assertRaises(zipfile.BadZipFile):
            fixture.prepare(self.prefix, self.root / "out", self.tail)
        self.assertFalse((self.root / "out").exists())

    def test_full_archive_mismatch_is_rejected(self):
        with patch.object(fixture, "ARCHIVE_MD5", "0" * 32):
            with self.assertRaisesRegex(ValueError, "MD5"):
                fixture.prepare(self.archive, self.root / "out")

    def test_existing_fixture_is_never_overwritten(self):
        output = self.root / "out"
        output.mkdir()
        (output / "user-file").write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError, "fresh output"):
            fixture.prepare(self.archive, output)
        self.assertEqual((output / "user-file").read_bytes(), b"keep")

    def test_locked_sha256_is_checked_even_if_md5_matches(self):
        with patch.object(fixture, "ARCHIVE_SHA256", "0" * 64):
            with self.assertRaisesRegex(ValueError, "locked SHA-256"):
                fixture.prepare(self.archive, self.root / "out")


if __name__ == "__main__":
    unittest.main()
