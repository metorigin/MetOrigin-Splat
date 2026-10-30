#!/usr/bin/env python3
"""Check the default Brush release graph and binary omit unreviewed weights and optional dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

WEIGHT_SHA256 = "ff80f1f56a24c6021d1e82b9957f92ee9a28d1b2fef4198e8ad1eedfbb93c252"


def verify(binary, source, dependency_tree):
    weights = (source / "crates/lpips/burn_mapped.bpk").read_bytes()
    if hashlib.sha256(weights).hexdigest() != WEIGHT_SHA256:
        raise ValueError("Unreviewed weight identity changed; repeat the provenance audit")
    tree = dependency_tree.read_text()
    if not tree.strip() or not tree.startswith("brush-cli v"):
        raise ValueError("Expected actual brush-cli Cargo target graph")
    if re.search(r"\blpips(?:-convert)? v", tree):
        raise ValueError("LPIPS is present in the default distribution dependency graph")
    excluded = []
    capabilities = json.loads(subprocess.check_output([str(binary), "--capabilities-json"]))
    if capabilities.get("build_id") == "metorigin-macos.6":
        excluded = ["hex-slice", "indicatif-log-bridge", "rerun"]
        for package in excluded:
            if re.search(r"(?<![\w-])" + re.escape(package) + r" v", tree):
                raise ValueError(f"Excluded dependency is present in default graph: {package}")
        rerun = capabilities.get("rerun", {})
        if rerun.get("available") is not False or rerun.get("distribution_policy") != "excluded_by_default":
            raise ValueError("Binary does not declare the required no-Rerun policy")
    data = binary.read_bytes()
    # A full-blob check plus 64 separated 4 KiB samples detects retained embedded
    # weights even if a linker changes section boundaries around the resource.
    samples = [weights[(len(weights) - 4096) * index // 63:][:4096] for index in range(64)]
    if weights in data or any(sample in data for sample in samples):
        raise ValueError("LPIPS weight payload found in the distribution binary")
    policy = capabilities.get("lpips", {})
    if (policy.get("embedded_weights") is not False or policy.get("loss_available") is not False
            or policy.get("distribution_policy") != "weights_excluded_by_default"):
        raise ValueError("Binary does not declare the required no-weight policy")
    return {"schema_version": 1, "binary_sha256": hashlib.sha256(data).hexdigest(),
            "excluded_resource_sha256": WEIGHT_SHA256, "sample_count": len(samples),
            "sample_bytes": 4096, "lpips_dependency_absent": True,
            "embedded_lpips_weights": False, "excluded_dependencies": excluded, "capabilities": capabilities}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brush", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--dependency-tree", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    result = verify(args.brush.resolve(strict=True), args.source.resolve(strict=True),
                    args.dependency_tree.resolve(strict=True))
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print("Verified: default graph and binary exclude LPIPS weights")


if __name__ == "__main__":
    main()
