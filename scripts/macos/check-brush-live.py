#!/usr/bin/env python3
"""Verify a capability-enabled Brush live producer against the protocol-1 consumer contract.

Runs baseline/live training on a normalized local fixture, consumes and validates
PLY frames before acknowledging them, and records engine process memory. Viewer
and WebView memory are outside this measurement. Requires actual Metal access.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brush", type=Path, required=True)
    parser.add_argument("--build-info", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=1000)
    args = parser.parse_args()
    if args.iterations < 1000:
        parser.error("Use at least 1000 iterations to leave time for protocol checks")
    binary = args.brush.resolve(strict=True)
    dataset = args.dataset.resolve(strict=True)
    out = args.output.resolve()
    if out == dataset or dataset in out.parents or out in dataset.parents:
        parser.error("Output must not overlap the dataset")
    if any(dataset.rglob("args.txt")) or any(dataset.rglob("*.ply")):
        parser.error("Use a normalized fixture without args.txt or PLY initialization")
    spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("smoke-engines.py"))
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    build_info = json.loads(args.build_info.read_text())
    if smoke.sha256(binary) != build_info["binary_sha256"]:
        parser.error("Build metadata does not match the binary")
    capabilities = json.loads(subprocess.check_output([str(binary), "--capabilities-json"]))
    if (capabilities["live_protocol"] != "ply_request_ack_v1"
            or "live_preview" not in capabilities["supported_features"]):
        parser.error("The binary does not declare the verified live contract")
    out.mkdir(parents=True, exist_ok=False)
    record = {"binary_sha256": smoke.sha256(binary), "build_info": build_info,
              "capabilities": capabilities, "runs": [], "checks": [], "frames": [],
              "memory_scope": "Engine process only; warmed CubeCL caches; excludes app WebView and viewer mesh memory."}

    def save():
        smoke.atomic_json(out / "evidence.json", record)

    common = [str(binary), str(dataset), "--total-train-iters", str(args.iterations),
              "--max-resolution", "960", "--max-splats", "50000",
              "--max-scene-batch-cache-size", "512MiB", "--sh-degree", "0",
              "--lod-levels", "0", "--num-loader-threads", "2", "--export-every", "100",
              "--export-name", "checkpoint_{iter}.ply"]
    for label in ["baseline", "live"]:
        export = out / (label + " checkpoints")
        command = ["/usr/bin/time", "-l", *common, "--export-path", str(export)]
        environment = {**os.environ, "RUST_LOG": "info"}
        environment.pop("METORIGIN_BRUSH_LIVE_DIR", None)
        environment.pop("METORIGIN_BRUSH_LIVE_SESSION", None)
        session_id = str(uuid.uuid4())
        live_root = out / (label + " preview")
        directory = live_root / session_id
        directory.mkdir(parents=True)
        smoke.atomic_json(live_root / "session.json", {
            "protocol": 1, "session_id": session_id, "available": True, "running": True})
        if label == "live":
            environment.update(METORIGIN_BRUSH_LIVE_DIR=str(directory),
                               METORIGIN_BRUSH_LIVE_SESSION=session_id)
        start = time.monotonic()
        with (out / (label + ".log")).open("wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       env=environment, start_new_session=True)

            def latest():
                path = directory / "latest.json"
                return json.loads(path.read_text()) if path.exists() else None

            def request(after, mode="live", valid=True, session=None):
                smoke.atomic_json(directory / "request.json", {
                    "session_id": session or session_id, "after_revision": after, "mode": mode,
                    "expires_at_ms": int(time.time() * 1000) + (10000 if valid else -1)})

            def stable(revision, check):
                time.sleep(0.3)
                frame = latest()
                actual = frame["revision"] if frame else 0
                assert process.poll() is None, "Training ended early; increase --iterations"
                assert actual == revision, (check, actual, revision)
                record["checks"].append(check)
                save()

            def consume(revision):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    frame = latest()
                    if frame and frame["revision"] == revision:
                        break
                    assert process.poll() is None, "Training ended before requested frame"
                    time.sleep(0.02)
                else:
                    raise AssertionError("Frame timeout")
                assert frame["protocol"] == 1 and frame["session_id"] == session_id
                assert frame["relative_path"] == f"frame-{revision}.ply"
                validated = smoke.validate_ply(directory / frame["relative_path"])
                assert validated["vertices"] == frame["splat_count"]
                if record["frames"]:
                    assert frame["iteration"] > record["frames"][-1]["iteration"]
                record["frames"].append({**frame, "ply": validated})
                save()
                return frame

            try:
                if label == "live":
                    stable(0, "no request produces no frame")
                    request(0, session=str(uuid.uuid4()))
                    stable(0, "unknown session produces no frame")
                    request(0, valid=False)
                    stable(0, "expired request produces no frame")
                    request(0)
                    consume(1)
                    stable(1, "one frame until ACK")
                    request(1)
                    consume(2)
                    request(1)
                    stable(2, "stale ACK cannot advance")
                    request(2, valid=False)
                    stable(2, "expired ACK cannot advance")
                    request(2, mode="off")
                    stable(2, "off mode cannot advance")
                    request(2)
                    consume(3)
                    revision = 3
                    deadline = time.monotonic() + 180
                    while process.poll() is None:
                        assert time.monotonic() < deadline, "Training timeout"
                        request(revision)
                        frame = latest()
                        if frame and frame["revision"] > revision:
                            assert frame["revision"] == revision + 1
                            consume(frame["revision"])
                            revision = frame["revision"]
                        time.sleep(0.05)
                process.wait(timeout=180)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
        entry = {"label": label, "argv": command, "exit_code": process.returncode,
                 "seconds": round(time.monotonic() - start, 3)}
        text = (out / (label + ".log")).read_text()
        for key, regex in [
            ("maximum_resident_set_bytes", r"(\d+)\s+maximum resident set size"),
            ("peak_memory_footprint_bytes", r"(\d+)\s+peak memory footprint"),
        ]:
            match = re.search(regex, text)
            entry[key] = int(match.group(1)) if match else None
        entry["final_checkpoint"] = smoke.validate_ply(export / f"checkpoint_{args.iterations}.ply")
        record["runs"].append(entry)
        save()
        assert process.returncode == 0
        if label == "live":
            files = list(directory.glob("frame-*.ply"))
            assert len(files) <= 2
            assert not list(directory.glob("*.tmp")) and not list(directory.glob("*.part"))
            for path in files:
                smoke.validate_ply(path)
            last = latest()
            record["last_frame"] = last
            if last["iteration"] == args.iterations:
                assert smoke.sha256(directory / last["relative_path"]) == entry["final_checkpoint"]["sha256"]
                record["final_frame_matches_checkpoint"] = True
            # Without a fresh ACK, the last live frame can precede the final
            # checkpoint; the app must then use its checkpoint fallback.
            request(last["revision"])
            time.sleep(0.3)
            assert latest() == last
            record["checks"].append("no producer remains after training exit")
    record["status"] = "passed"
    save()
    print(json.dumps({"status": "passed", "frames": len(record["frames"]),
                      "evidence": str(out / "evidence.json")}))


if __name__ == "__main__":
    main()
