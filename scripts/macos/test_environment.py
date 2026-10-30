import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("collect_environment", Path(__file__).with_name("collect-environment.py"))
environment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(environment)


class EnvironmentTests(unittest.TestCase):
    def test_hardware_whitelist_excludes_identifiers_and_display_names(self):
        report = environment.hardware_summary({
            "SPHardwareDataType": [{"chip_type": "Apple M1 Pro", "physical_memory": "32 GB",
                                    "serial_number": "private-serial", "platform_UUID": "private-id",
                                    "provisioning_UDID": "private-id", "machine_name": "private-name"}],
            "SPDisplaysDataType": [{"sppci_model": "Apple M1 Pro", "spdisplays_metal": "supported",
                                    "serial_number": "private-display", "spdisplays_ndrvs": [{"_name": "private-name"}]}],
        })
        self.assertEqual(report["physical_memory"], "32 GB")
        self.assertEqual(report["displays"][0]["device"], "Apple M1 Pro")
        self.assertNotIn("private", json.dumps(report))

    def test_missing_command_is_unknown_not_zero(self):
        with patch.object(environment.subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(environment.command(["not-installed"]), {"status": "missing"})

    def test_errors_do_not_record_raw_output(self):
        result = environment.subprocess.CompletedProcess([], 1, "private-path", "private-token")
        with patch.object(environment.subprocess, "run", return_value=result):
            self.assertEqual(environment.command(["failed"]), {"status": "failed", "exit_code": 1})

    def test_version_drops_build_configuration_paths(self):
        result = environment.subprocess.CompletedProcess([], 0, "ffmpeg version 8.1.2\nconfiguration: /private/build", "")
        with patch.object(environment.subprocess, "run", return_value=result):
            self.assertEqual(environment.version("ffmpeg", ["-version"]),
                             {"status": "available", "version": "ffmpeg version 8.1.2"})

    def test_atomic_replace_failure_keeps_previous_record(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "environment.json"
            environment.write_record(output, {"previous": True})
            with patch.object(environment.os, "replace", side_effect=OSError("injected")):
                with self.assertRaises(OSError):
                    environment.write_record(output, {"previous": False})
            self.assertEqual(json.loads(output.read_text()), {"previous": True})
            self.assertEqual(list(Path(directory).iterdir()), [output])


if __name__ == "__main__":
    unittest.main()
