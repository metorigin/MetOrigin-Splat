import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("distribution", Path(__file__).with_name("check-brush-distribution.py"))
DIST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIST)


class DistributionPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.weights = b"".join(hashlib.sha256(str(i).encode()).digest() for i in range(8192))
        resource = self.root / "crates/lpips/burn_mapped.bpk"
        resource.parent.mkdir(parents=True)
        resource.write_bytes(self.weights)
        self.binary = self.root / "brush-cli"
        self.binary.write_bytes(b"clean fixture binary")
        self.tree = self.root / "cargo-tree.txt"
        self.tree.write_text("brush-cli v1.0.0\n    brush-process v1.0.0\n")
        self.policy = {"lpips": {"embedded_weights": False, "loss_available": False,
                                 "distribution_policy": "weights_excluded_by_default"}}
        self.sha = patch.object(DIST, "WEIGHT_SHA256", hashlib.sha256(self.weights).hexdigest())
        self.sha.start()
        self.addCleanup(self.sha.stop)

    def verify(self):
        with patch.object(DIST.subprocess, "check_output", return_value=json.dumps(self.policy)):
            return DIST.verify(self.binary, self.root, self.tree)

    def test_clean_binary_and_graph_are_accepted(self):
        self.assertFalse(self.verify()["embedded_lpips_weights"])

    def test_v6_excludes_missing_notice_dependencies_and_native_rerun(self):
        self.policy.update(build_id="metorigin-macos.6", rerun={"available": False,
            "distribution_policy": "excluded_by_default"})
        self.tree.write_text("brush-cli v1.0.0\n    brush-rerun v1.0.0\n")
        self.assertEqual(self.verify()["excluded_dependencies"],
                         ["hex-slice", "indicatif-log-bridge", "rerun"])
        for package in ["hex-slice", "indicatif-log-bridge", "rerun"]:
            self.tree.write_text(f"brush-cli v1.0.0\n    {package} v1.0.0\n")
            with self.assertRaisesRegex(ValueError, "Excluded dependency"):
                self.verify()
        self.tree.write_text("brush-cli v1.0.0\n")
        self.policy["rerun"]["available"] = True
        with self.assertRaisesRegex(ValueError, "no-Rerun policy"):
            self.verify()

    def test_even_partial_known_payload_is_rejected(self):
        self.binary.write_bytes(b"prefix" + self.weights[:4096] + b"suffix")
        with self.assertRaisesRegex(ValueError, "payload"):
            self.verify()

    def test_lpips_in_graph_is_rejected(self):
        self.tree.write_text("brush-cli v1.0.0\n    lpips v1.0.0\n")
        with self.assertRaisesRegex(ValueError, "dependency graph"):
            self.verify()

    def test_empty_graph_is_rejected(self):
        self.tree.write_text("")
        with self.assertRaisesRegex(ValueError, "target graph"):
            self.verify()

    def test_changed_weight_identity_requires_new_audit(self):
        (self.root / "crates/lpips/burn_mapped.bpk").write_bytes(b"unknown weights")
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.verify()

    def test_binary_capability_must_confirm_exclusion(self):
        self.policy["lpips"]["embedded_weights"] = True
        with self.assertRaisesRegex(ValueError, "no-weight policy"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
