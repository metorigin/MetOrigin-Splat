#!/usr/bin/env python3
"""Exercise the pinned Brush machine/training contract on an existing local fixture.

Creates an isolated dataset copy and output directory. Requires actual Metal GPU
access. Does not modify the original dataset, install tools, or upload artifacts.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brush", required=True, type=Path)
    parser.add_argument("--build-info", required=True, type=Path)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    binary = args.brush.resolve(strict=True)
    source_dataset = args.dataset.resolve(strict=True)
    if any(source_dataset.rglob("args.txt")) or any(source_dataset.rglob("*.ply")):
        parser.error("Use the normalized fixture without args.txt or a PLY initialization")
    out = args.output.resolve()
    if out == source_dataset or source_dataset in out.parents or out in source_dataset.parents:
        parser.error("Output must not overlap the source dataset")
    spec = importlib.util.spec_from_file_location(
        "smoke", Path(__file__).with_name("smoke-engines.py"))
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    build_info = json.loads(args.build_info.read_text())
    if build_info["binary_sha256"] != smoke.sha256(binary):
        parser.error("Build metadata does not match the binary")
    out.mkdir(parents=True, exist_ok=False)
    dataset = out / "输入 数据集"
    shutil.copytree(source_dataset, dataset)
    (dataset / "args.txt").write_text(
        "--start-iter 999 --num-loader-threads 7 --sh-degree 3 "
        "--export-path '不要 写入' --export-name 'from args {iter}.ply' "
        "--total-train-iters 999\n")
    record = {"binary_sha256": smoke.sha256(binary), "build_info": build_info, "checks": []}
    environment = {**os.environ, "RUST_LOG": "info"}

    def save():
        smoke.atomic_json(out / "evidence.json", record)

    def run(label, arguments, expected_success=True):
        command = [str(binary), *map(str, arguments)]
        start = time.monotonic()
        with (out / (label + ".log")).open("wb") as log:
            result = subprocess.run(command, env=environment, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=120)
        entry = {"label": label, "argv": command, "exit_code": result.returncode,
                 "seconds": round(time.monotonic() - start, 3)}
        record["checks"].append(entry)
        save()
        assert (result.returncode == 0) == expected_success, entry
        return entry

    for flag in ["--capabilities-json", "--probe-json"]:
        result = subprocess.run([str(binary), flag], capture_output=True, timeout=120)
        (out / (flag[2:] + ".stdout.json")).write_bytes(result.stdout)
        (out / (flag[2:] + ".stderr.log")).write_bytes(result.stderr)
        assert result.returncode == 0 and len(result.stdout.splitlines()) == 1
        record[flag[2:]] = json.loads(result.stdout)
    capabilities = record["capabilities-json"]
    required = {"loader_thread_limit", "atomic_checkpoint", "explicit_cli_overrides"}
    assert required.issubset(capabilities["supported_features"])
    assert record["probe-json"]["backend"] == "metal"
    assert record["probe-json"]["status"] == "supported"
    base = ["--max-resolution", "960", "--max-splats", "300000",
            "--max-scene-batch-cache-size", "512MiB", "--sh-degree", "0",
            "--lod-levels", "0", "--num-loader-threads", "2"]
    if capabilities.get("lpips", {}).get("embedded_weights") is False:
        args_path = dataset / "args.txt"
        original_args = args_path.read_text()
        args_path.write_text(original_args + " --lpips-loss-weight 0.1\n")
        unavailable = "LPIPS weights are not included in this build"
        run("lpips-explicit-rejected", [dataset, "--lpips-loss-weight", "0.1"], False)
        assert unavailable in (out / "lpips-explicit-rejected.log").read_text()
        run("lpips-args-file-rejected", [dataset, *base, "--start-iter", "0",
            "--total-train-iters", "1", "--export-path", out / "rejected lpips"], False)
        assert unavailable in (out / "lpips-args-file-rejected.log").read_text()
        assert not (out / "rejected lpips").exists()
        entry = run("lpips-explicit-zero-overrides-file", [dataset, *base,
            "--start-iter", "0", "--total-train-iters", "1", "--lpips-loss-weight", "0",
            "--export-every", "1", "--export-path", out / "no lpips"])
        entry["checkpoint"] = smoke.validate_ply(out / "no lpips/from args 1.ply")
        args_path.write_text(original_args)
    if capabilities.get("rerun", {}).get("available") is False:
        args_path = dataset / "args.txt"
        original_args = args_path.read_text()
        unavailable = "Rerun visualization is not included in this build"
        run("rerun-explicit-rejected", [dataset, "--rerun-enabled"], False)
        assert unavailable in (out / "rerun-explicit-rejected.log").read_text()
        args_path.write_text(original_args + " --rerun-enabled\n")
        run("rerun-args-file-rejected", [dataset, *base, "--start-iter", "0",
            "--total-train-iters", "1", "--export-path", out / "rejected rerun"], False)
        assert unavailable in (out / "rerun-args-file-rejected.log").read_text()
        assert not (out / "rejected rerun").exists()
        args_path.write_text(original_args)
    exports = out / "输出 checkpoints"
    entry = run("explicit-default-paths", [
        dataset, *base, "--start-iter", "0", "--total-train-iters", "10",
        "--export-every", "10", "--export-path", exports])
    checkpoint = exports / "from args 10.ply"
    entry["checkpoint"] = smoke.validate_ply(checkpoint)
    log = (out / "explicit-default-paths.log").read_text()
    assert "Dataset loader actor threads: 2" in log and "Done training!" in log
    assert not list(exports.glob("*.part"))
    shutil.copyfile(checkpoint, dataset / "init.ply")
    entry = run("warm-start", [
        dataset, *base, "--start-iter", "10", "--total-train-iters", "20",
        "--export-every", "20", "--export-path", out / "恢复 checkpoints"])
    entry["checkpoint"] = smoke.validate_ply(out / "恢复 checkpoints/from args 20.ply")

    old_hash = smoke.sha256(checkpoint)
    lower_budget = base.copy()
    lower_budget[lower_budget.index("--max-splats") + 1] = "100"
    run("refuse-downsample", [
        dataset, *lower_budget, "--start-iter", "10", "--total-train-iters", "20",
        "--export-every", "20", "--export-path", out / "拒绝 checkpoints"], False)
    assert "Warm start will not discard Gaussians" in (out / "refuse-downsample.log").read_text()
    assert smoke.sha256(checkpoint) == old_hash and not (out / "拒绝 checkpoints").exists()

    blocked = out / "not a directory"
    blocked.write_text("preserve me")
    run("export-failure", [
        dataset, *base, "--start-iter", "10", "--total-train-iters", "11",
        "--export-every", "11", "--export-path", blocked], False)
    assert blocked.read_text() == "preserve me"
    assert "Done training!" not in (out / "export-failure.log").read_text()

    # Cancel after the atomic checkpoint name appears, then warm-start it.
    interrupted = out / "interrupted checkpoints"
    command = [str(binary), str(dataset), *base, "--start-iter", "0",
               "--total-train-iters", "10000", "--export-every", "100",
               "--export-path", str(interrupted), "--export-name", "checkpoint_{iter}.ply"]
    with (out / "interrupted.log").open("wb") as log:
        process = subprocess.Popen(command, env=environment, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            checkpoint = interrupted / "checkpoint_00100.ply"
            deadline = time.monotonic() + 90
            while (not checkpoint.exists() and time.monotonic() < deadline
                   and process.poll() is None):
                time.sleep(0.05)
            assert checkpoint.exists(), "Checkpoint was not published before timeout"
            verified = smoke.validate_ply(checkpoint)
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    record["checks"].append({"label": "interruption", "argv": command,
                             "exit_code": process.returncode, "checkpoint": verified})
    assert process.returncode != 0 and smoke.validate_ply(checkpoint) == verified
    for path in interrupted.glob("*.ply"):
        smoke.validate_ply(path)
    shutil.copyfile(checkpoint, dataset / "init.ply")
    entry = run("resume-after-interruption", [
        dataset, *base, "--start-iter", "100", "--total-train-iters", "110",
        "--export-every", "110", "--export-path", out / "after interruption"])
    entry["checkpoint"] = smoke.validate_ply(out / "after interruption/from args 110.ply")
    record["status"] = "passed"
    save()
    print(json.dumps({"status": "passed", "checks": len(record["checks"]),
                      "evidence": str(out / "evidence.json")}))


if __name__ == "__main__":
    main()
