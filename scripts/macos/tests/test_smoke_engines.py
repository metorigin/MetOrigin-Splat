import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("smoke", Path(__file__).parents[1] / "smoke-engines.py")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def ply(self, names=None, values=None, count=1):
        names = list(smoke.REQUIRED) if names is None else names
        values = [0.1] * len(names) if values is None else values
        header = "ply\nformat binary_little_endian 1.0\nelement vertex " + str(count) + "\n"
        header += "".join("property float " + name + "\n" for name in names)
        path = self.root / "test.ply"
        path.write_bytes((header + "end_header\n").encode() + struct.pack("<" + "f" * len(values), *values))
        return path

    def test_valid_complete_gaussian(self):
        result = smoke.validate_ply(self.ply())
        self.assertEqual(result["vertices"], 1)
        self.assertEqual(result["stride"], 56)

    def test_rejects_truncated_and_extra_payload(self):
        path = self.ply()
        content = path.read_bytes()
        for payload in (content[:-1], content + b"x"):
            path.write_bytes(payload)
            with self.assertRaisesRegex(ValueError, "length"):
                smoke.validate_ply(path)

    def test_rejects_missing_gaussian_properties(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            smoke.validate_ply(self.ply(names=["x", "y", "z"]))

    def test_rejects_nonfinite_vertices(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            values = [0.0] * len(smoke.REQUIRED)
            values[3] = value
            with self.assertRaisesRegex(ValueError, "non-finite"):
                smoke.validate_ply(self.ply(values=values))

    def test_rejects_duplicate_properties_and_wrong_sh(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            smoke.validate_ply(self.ply(names=list(smoke.REQUIRED) + ["x"]))
        with self.assertRaisesRegex(ValueError, "harmonics"):
            smoke.validate_ply(self.ply(names=list(smoke.REQUIRED) + ["f_rest_0"]))

    def test_rejects_header_only_and_zero_vertices(self):
        for content in (b"ply\n", b"ply\nformat binary_little_endian 1.0\nelement vertex 0\nend_header\n"):
            path = self.root / "test.ply"
            path.write_bytes(content)
            with self.assertRaises(ValueError):
                smoke.validate_ply(path)

    def test_cpu_flags_are_explicit_for_both_mappers(self):
        for mapper in ("mapper", "global_mapper"):
            commands = smoke.colmap_commands("colmap", "db", "photos 中文", "sparse", 4, mapper)
            self.assertIn("--FeatureExtraction.use_gpu", commands[0][1])
            self.assertIn("--FeatureMatching.use_gpu", commands[1][1])
            self.assertIn("photos 中文", commands[0][1])
            flags = ("--Mapper.ba_use_gpu",) if mapper == "mapper" else (
                "--GlobalMapper.gp_use_gpu", "--GlobalMapper.ba_ceres_use_gpu")
            for flag in flags:
                self.assertEqual(commands[2][1][commands[2][1].index(flag) + 1], "0")
            self.assertFalse(any("gpu_index" in str(arg) for _, command in commands for arg in command))

    def test_model_selection_is_not_hardcoded_to_zero(self):
        for name, count in (("0", 3), ("7", 10)):
            model = self.root / name
            model.mkdir()
            for file in ("cameras", "images", "points3D"):
                (model / (file + ".bin")).write_bytes(struct.pack("<Q", count))
        model, count = smoke.select_model(self.root)
        self.assertEqual((model.name, count), ("7", 10))

    def test_fixture_checksum_and_path_safety(self):
        entries = []
        for index in range(3):
            path = self.root / (str(index) + ".jpg")
            path.write_bytes(b"test image")
            entries.append({"path": path.name, "sha256": smoke.sha256(path)})
        manifest = {"schema_version": 1, "license": "CC0-1.0", "images": entries}
        self.assertEqual(len(smoke.fixture_inventory(self.root, manifest)), 3)
        (self.root / "1.jpg").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum"):
            smoke.fixture_inventory(self.root, manifest)
        entries[0]["path"] = "../outside.jpg"
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            smoke.fixture_inventory(self.root, manifest)

    def test_atomic_evidence_json_rejects_nonfinite_values(self):
        path = self.root / "evidence.json"
        smoke.atomic_json(path, {"status": "running"})
        with self.assertRaises(ValueError):
            smoke.atomic_json(path, {"value": float("nan")})
        self.assertEqual(json.loads(path.read_text()), {"status": "running"})

    def test_binary_is_bound_to_the_pinned_source_commit(self):
        binary = self.root / "brush-cli"
        binary.write_bytes(b"test binary")
        record = self.root / "build-info.json"
        smoke.atomic_json(record, {"schema_version": 1, "source_commit": smoke.BRUSH_COMMIT,
                                   "target": "aarch64-apple-darwin",
                                   "binary_sha256": smoke.sha256(binary)})
        smoke.verify_build_info(binary, record, smoke.BRUSH_COMMIT)
        binary.write_bytes(b"another build")
        with self.assertRaisesRegex(ValueError, "checksum"):
            smoke.verify_build_info(binary, record, smoke.BRUSH_COMMIT)
        with self.assertRaisesRegex(ValueError, "commit"):
            smoke.verify_build_info(binary, record, smoke.COLMAP_COMMIT)
        record.write_text(json.dumps({"schema_version": 1, "source_commit": smoke.BRUSH_COMMIT,
                                      "target": "x86_64-apple-darwin", "binary_sha256": smoke.sha256(binary)}))
        with self.assertRaisesRegex(ValueError, "arm64"):
            smoke.verify_build_info(binary, record, smoke.BRUSH_COMMIT)

    def test_help_prose_does_not_count_as_an_available_cpu_flag(self):
        with patch.object(smoke, "run_command", return_value="Use --FeatureExtraction.use_gpu if available"):
            with self.assertRaisesRegex(ValueError, "capability missing"):
                smoke.verify_colmap_help("colmap", self.root, {"commands": []})

    def test_changed_binary_cannot_launch_the_next_stage(self):
        binary = self.root / "brush-cli"
        binary.write_bytes(b"original build")
        report = {"commands": [], "brush": {"binary": str(binary), "sha256": smoke.sha256(binary)}}
        binary.write_bytes(b"recompiled build")
        with patch.object(smoke.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(ValueError, "changed during"):
                smoke.run_command("later-stage", [str(binary)], self.root, report)
            popen.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "Unix commands")
    def test_binary_change_during_last_stage_is_not_success(self):
        binary = self.root / "brush-cli"
        binary.write_bytes(b"original build")
        report = {"commands": [], "brush": {"binary": str(binary), "sha256": smoke.sha256(binary)}}
        with self.assertRaisesRegex(ValueError, "changed during"):
            smoke.run_command("last-stage", ["/bin/sh", "-c", 'printf changed > "$1"', "sh", str(binary)],
                              self.root, report)

    @unittest.skipUnless(os.name == "posix", "Unix process groups")
    def test_normal_parent_exit_stops_background_descendant(self):
        marker = self.root / "descendant-wrote"
        report = {"commands": []}
        # File-backed output lets the direct child exit even while its child lives.
        smoke.run_command("normal", ["/bin/sh", "-c", '(sleep 3; touch "$1") &', "sh", str(marker)],
                          self.root, report, timeout=5)
        time.sleep(1.2)
        self.assertFalse(marker.exists())
        self.assertEqual(report["commands"][0]["exit_code"], 0)

    @unittest.skipUnless(os.name == "posix", "Unix process groups")
    def test_timeout_stops_term_ignoring_descendant(self):
        marker = self.root / "descendant-wrote"
        report = {"commands": []}
        with self.assertRaises(smoke.subprocess.TimeoutExpired):
            smoke.run_command("timeout", ["/bin/sh", "-c",
                              'trap "" TERM; (sleep 3; touch "$1") & wait', "sh", str(marker)],
                              self.root, report, timeout=0.1)
        time.sleep(1.2)
        self.assertFalse(marker.exists())
        self.assertGreater(report["commands"][0]["wall_seconds"], 2)


if __name__ == "__main__":
    unittest.main()
