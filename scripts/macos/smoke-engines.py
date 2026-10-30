#!/usr/bin/env python3
"""Independent M0 engine experiment, never an application pipeline or release gate.

Consumes an explicitly licensed, checksum-locked image fixture. All outputs and
unredacted command logs belong in an ignored local experiment directory. Requires
Python 3.9+ and the pinned CPU COLMAP 4.1.0 / Brush 1.0 CLI binaries.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import socket
import struct
import subprocess
import sys
import time


BRUSH_COMMIT = "1388f74c6fe0236f68ee4915564bf00e9d2e3747"
COLMAP_COMMIT = "fa8e3b3ff591552855f8ad2806723c80f963f69c"
REQUIRED = ("x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2",
            "rot_0", "rot_1", "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2")


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, data):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def validate_ply(path, expected_sh=0):
    """Validate the exact float32 binary Gaussian format emitted by Brush 1.0.

    Strict on purpose: unknown encodings/elements are not accepted as evidence.
    Reads one vertex at a time, including every value, without duplicating the PLY.
    """
    path = Path(path)
    with path.open("rb") as stream:
        if stream.readline() != b"ply\n":
            raise ValueError("PLY magic is missing")
        properties, count, encoding, header_bytes = [], None, None, 4
        while True:
            line = stream.readline(4097)
            header_bytes += len(line)
            if not line or len(line) > 4096 or header_bytes > 65536:
                raise ValueError("PLY header is truncated or too large")
            words = line.decode("ascii").strip().split()
            if not words:
                raise ValueError("Empty PLY header directive")
            if words == ["end_header"]:
                break
            if words[0] == "comment":
                continue
            if words[0] == "format" and encoding is None:
                if words != ["format", "binary_little_endian", "1.0"]:
                    raise ValueError("Expected binary little-endian PLY 1.0")
                encoding = words[1]
            elif words[0] == "element" and count is None and len(words) == 3:
                if words[1] != "vertex":
                    raise ValueError("Unexpected PLY element")
                count = int(words[2])
                if count <= 0:
                    raise ValueError("PLY contains no Gaussian vertices")
            elif words[0] == "property" and count is not None:
                if len(words) != 3 or words[1] not in ("float", "float32"):
                    raise ValueError("Expected float32 scalar Gaussian properties")
                if words[2] in properties:
                    raise ValueError("Duplicate PLY property")
                properties.append(words[2])
            else:
                raise ValueError("Unsupported or misplaced PLY header directive")
        if encoding is None or count is None or not set(REQUIRED).issubset(properties):
            raise ValueError("PLY is missing format, vertices or Gaussian properties")
        rest = [name for name in properties if name.startswith("f_rest_")]
        expected_rest = 3 * ((expected_sh + 1) ** 2 - 1)
        if set(rest) != {"f_rest_" + str(i) for i in range(expected_rest)}:
            raise ValueError("PLY spherical harmonics degree does not match the run")
        record = struct.Struct("<" + "f" * len(properties))
        expected_size = stream.tell() + count * record.size
        if path.stat().st_size != expected_size:
            raise ValueError("PLY payload length does not match its declared vertices")
        for index in range(count):
            if not all(math.isfinite(value) for value in record.unpack(stream.read(record.size))):
                raise ValueError("PLY contains a non-finite value at vertex " + str(index))
    return {"vertices": count, "sh_degree": expected_sh, "stride": record.size,
            "bytes": expected_size, "sha256": sha256(path)}


def fixture_inventory(images, manifest):
    """Only named fixture images may enter the reconstruction; no hidden args.txt."""
    images = Path(images).resolve()
    if manifest.get("schema_version") != 1 or not manifest.get("license"):
        raise ValueError("Fixture needs schema_version 1 and an explicit license")
    inventory = manifest.get("images", [])
    if len(inventory) < 3:
        raise ValueError("Fixture must contain at least three locked photos")
    names = set()
    for entry in inventory:
        name = entry["path"]
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or name in names:
            raise ValueError("Unsafe or duplicate fixture image path")
        path = images / relative
        if path.is_symlink() or images not in path.resolve().parents:
            raise ValueError("Fixture image escapes the image directory")
        if path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            raise ValueError("Unsupported fixture image extension")
        if sha256(path) != entry["sha256"]:
            raise ValueError("Fixture checksum mismatch: " + name)
        names.add(name)
    return inventory


def verify_build_info(binary, path, expected_commit):
    info = json.loads(Path(path).read_text())
    if info.get("schema_version") != 1 or info.get("source_commit") != expected_commit:
        raise ValueError("Build evidence does not identify the pinned source commit")
    if info.get("target") != "aarch64-apple-darwin":
        raise ValueError("Build evidence does not identify a native arm64 macOS binary")
    if info.get("binary_sha256") != sha256(binary):
        raise ValueError("Binary checksum does not match its successful build evidence")
    return info


def verify_current_binaries(report):
    for name in ("colmap", "brush"):
        identity = report.get(name)
        if identity and sha256(identity["binary"]) != identity["sha256"]:
            raise ValueError(name + " binary changed during the run; use a stable engine build")


SUPERVISOR = r'''
import json, os, select, signal, socket, subprocess, sys, time

channel = socket.socket(fileno=int(sys.argv[1]))
# A caught handler is reset by exec; the actual command receives normal TERM.
signal.signal(signal.SIGTERM, lambda *_: None)

def abandoned():
    # The parent disappeared. This live session leader still owns this PGID.
    os.killpg(os.getpgrp(), signal.SIGTERM)
    time.sleep(2)
    os.killpg(os.getpgrp(), signal.SIGKILL)

def parent_disconnected():
    try:
        return not channel.recv(1)
    except ConnectionResetError:
        return True

channel.sendall(b'{"ready":true}\n')
with channel.makefile('rb') as control:
    if control.readline(16) != b'run\n':
        abandoned()
    try:
        child = subprocess.Popen(sys.argv[2:])
    except Exception as error:
        result = {"launch_error": type(error).__name__ + ': ' + str(error)}
    else:
        while child.poll() is None:
            if select.select([channel], [], [], 0.05)[0]:
                parent_disconnected()
                abandoned()
        result = {"exit_code": child.returncode}
    try:
        channel.sendall(json.dumps(result).encode() + b'\n')
    except (BrokenPipeError, ConnectionResetError):
        abandoned()
    # Keep the owned leader alive until group cleanup, even after command exit.
    parent_disconnected()
    abandoned()
'''


def supervisor_message(channel, stream, execution, timeout):
    channel.settimeout(timeout)
    try:
        raw = stream.readline(4097)
    except socket.timeout as error:
        raise subprocess.TimeoutExpired(execution, timeout) from error
    if not raw:
        raise RuntimeError("Command supervisor disconnected before reporting a result")
    if len(raw) > 4096 or not raw.endswith(b"\n"):
        raise RuntimeError("Command supervisor returned an invalid message")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise RuntimeError("Command supervisor returned an invalid result")
    return result


def stop_group(process, command_allowed=True):
    if process.returncode is not None:
        raise RuntimeError("Refusing to signal a reaped process group")
    # Do not reap the supervisor before signalling: its owned PID pins the PGID
    # against reuse. Before the handshake ACK no command can have been spawned.
    try:
        if command_allowed:
            os.killpg(process.pid, signal.SIGTERM)
            time.sleep(2)
            os.killpg(process.pid, signal.SIGKILL)
        else:
            os.kill(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def run_command(label, command, output, report, timeout=3600, env=None):
    verify_current_binaries(report)
    log = output / (label + ".log")
    entry = {"stage": label, "argv": [str(arg) for arg in command], "log": log.name}
    measured = report.get("measure_rss", False) and platform.system() == "Darwin"
    execution = (["/usr/bin/time", "-l"] if measured else []) + entry["argv"]
    entry["execution_argv"] = execution
    report["commands"].append(entry)
    atomic_json(output / "evidence.json", report)
    started = time.monotonic()
    process = None
    channel, child_channel = socket.socketpair()
    messages = None
    command_allowed = False
    try:
        with log.open("wb") as stream:
            process = subprocess.Popen([sys.executable, "-c", SUPERVISOR, str(child_channel.fileno()), *execution],
                                       stdout=stream, stderr=subprocess.STDOUT, start_new_session=True,
                                       pass_fds=(child_channel.fileno(),), env=env)
            child_channel.close()
            messages = channel.makefile("rb")
            if supervisor_message(channel, messages, execution, 10) != {"ready": True}:
                raise RuntimeError("Command supervisor did not establish its session")
            # Mark ownership before sending: even a partial ACK must take the
            # group-cleanup path while this unreaped leader still reserves its ID.
            command_allowed = True
            channel.sendall(b"run\n")
            result = supervisor_message(channel, messages, execution, timeout)
            if "launch_error" in result:
                raise RuntimeError(label + " could not start: " + str(result["launch_error"]))
            if type(result.get("exit_code")) is not int:
                raise RuntimeError("Command supervisor did not report the command exit code")
            entry["exit_code"] = result["exit_code"]
        if entry["exit_code"] != 0:
            raise RuntimeError(label + " failed; see " + log.name)
    except BaseException as error:
        entry["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        try:
            if process is not None:
                stop_group(process, command_allowed)
        except BaseException as error:
            entry["cleanup_error"] = type(error).__name__ + ": " + str(error)
            raise
        finally:
            if messages is not None:
                messages.close()
            channel.close()
            child_channel.close()
            entry["wall_seconds"] = round(time.monotonic() - started, 3)
            if measured and log.is_file():
                match = re.search(r"(?m)^\s*(\d+)\s+maximum resident set size\s*$",
                                  log.read_text(encoding="utf-8", errors="replace"))
                entry["max_rss_bytes"] = int(match[1]) if match else None
                footprint = re.search(r"(?m)^\s*(\d+)\s+peak memory footprint\s*$",
                                      log.read_text(encoding="utf-8", errors="replace"))
                entry["peak_memory_footprint_bytes"] = int(footprint[1]) if footprint else None
                entry["rss_scope"] = "macOS time -l child high-water RSS; not total unified physical memory"
            atomic_json(output / "evidence.json", report)
    verify_current_binaries(report)
    return log.read_text(encoding="utf-8", errors="replace")


def colmap_commands(binary, database, images, sparse, threads, mapper):
    return [
        ("features", [binary, "feature_extractor", "--database_path", database,
                      "--image_path", images, "--ImageReader.single_camera", "1",
                      "--FeatureExtraction.use_gpu", "0", "--FeatureExtraction.num_threads",
                      str(threads), "--FeatureExtraction.max_image_size", "1600"]),
        ("matching", [binary, "exhaustive_matcher", "--database_path", database,
                      "--FeatureMatching.use_gpu", "0", "--FeatureMatching.num_threads",
                      str(threads)]),
        ("mapping", [binary, mapper, "--database_path", database, "--image_path", images,
                     "--output_path", sparse] +
         (["--Mapper.ba_use_gpu", "0", "--Mapper.num_threads", str(threads)] if mapper == "mapper"
          else ["--GlobalMapper.gp_use_gpu", "0", "--GlobalMapper.ba_ceres_use_gpu", "0",
                "--GlobalMapper.num_threads", str(threads)])),
    ]


def verify_colmap_help(binary, output, report):
    required = {
        "feature_extractor": ("FeatureExtraction.use_gpu", "FeatureExtraction.num_threads",
                              "FeatureExtraction.max_image_size"),
        "exhaustive_matcher": ("FeatureMatching.use_gpu", "FeatureMatching.num_threads"),
        "mapper": ("Mapper.ba_use_gpu", "Mapper.num_threads"),
        "global_mapper": ("GlobalMapper.gp_use_gpu", "GlobalMapper.ba_ceres_use_gpu",
                          "GlobalMapper.num_threads"),
        "image_undistorter": ("output_type", "max_image_size"),
    }
    for command, flags in required.items():
        text = run_command("help-" + command, [binary, command, "-h"], output, report, 30)
        for flag in flags:
            if not re.search(r"(?m)^\s*--" + re.escape(flag) + r"(?:\s|=|$)", text):
                raise ValueError("COLMAP CPU capability missing: " + command + " --" + flag)


def select_model(sparse):
    # COLMAP binary images.bin starts with uint64 registered-image count.
    models = []
    for path in Path(sparse).iterdir():
        if not path.is_dir() or not all((path / (f + ".bin")).is_file()
                                       for f in ("cameras", "images", "points3D")):
            continue
        with (path / "images.bin").open("rb") as stream:
            raw = stream.read(8)
            if len(raw) != 8:
                continue
            count = struct.unpack("<Q", raw)[0]
        models.append((count, path.name, path))
    if not models:
        raise ValueError("COLMAP produced no complete sparse model")
    count, _, model = max(models)
    return model, count


def model_metrics(text):
    result = {}
    for key, label in (("sparse_points", "Points"), ("observations", "Observations"),
                       ("mean_track_length", "Mean track length"),
                       ("mean_reprojection_error_px", "Mean reprojection error")):
        match = re.search(re.escape(label) + r":\s+([0-9]+(?:\.[0-9]+)?)", text)
        if match:
            result[key] = float(match[1]) if "." in match[1] else int(match[1])
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--colmap", type=Path, required=True)
    parser.add_argument("--brush", type=Path)
    parser.add_argument("--colmap-build-info", type=Path, required=True)
    parser.add_argument("--brush-build-info", type=Path)
    parser.add_argument("--sfm-only", action="store_true", help="Validate CPU SfM while Brush is building")
    parser.add_argument("--measure-rss", action="store_true",
                        help="Wrap commands in macOS time -l; requires permission to read process metrics")
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--mapper", choices=("mapper", "global_mapper"), default="mapper")
    parser.add_argument("--iterations", type=int, default=300)
    args = parser.parse_args(argv)
    if not args.sfm_only and (args.brush is None or args.brush_build_info is None):
        parser.error("Training requires --brush and --brush-build-info")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This experiment requires native Apple Silicon macOS")
    if args.iterations < 1 or args.threads < 1:
        parser.error("Iterations and threads must be positive")
    output = args.output.resolve()
    if output.exists():
        parser.error("Use a fresh output directory; existing runs are never overwritten")
    output.mkdir(parents=True)
    report = {"schema_version": 1, "status": "running", "purpose": "M0 independent engine smoke",
              "harness_sha256": sha256(Path(__file__)),
              "platform": {"system": platform.system(), "architecture": platform.machine(),
                           "macos": platform.mac_ver()[0]}, "commands": [],
              "measure_rss": args.measure_rss,
              "expected_source_commits": {"brush": BRUSH_COMMIT, "colmap": COLMAP_COMMIT},
              "iterations_requested": args.iterations, "visual_validation": "not_performed",
              "application_and_package_acceptance": "not_performed"}
    atomic_json(output / "evidence.json", report)
    try:
        manifest = json.loads(args.fixture.read_text())
        inventory = fixture_inventory(args.images, manifest)
        report["fixture"] = manifest
        # Copy only locked images into this fresh run. No PLY or args.txt can leak in.
        import shutil
        input_images = output / "input-images"
        for entry in inventory:
            destination = input_images / entry["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.images.resolve() / entry["path"], destination)
        for name in (("colmap",) if args.sfm_only else ("colmap", "brush")):
            binary = getattr(args, name).resolve()
            if not binary.is_file() or not os.access(binary, os.X_OK):
                raise ValueError(name + " binary is missing or not executable")
            report[name] = {"sha256": sha256(binary), "binary": str(binary)}
            report[name]["build_info"] = verify_build_info(
                binary, getattr(args, name + "_build_info"),
                BRUSH_COMMIT if name == "brush" else COLMAP_COMMIT)
            setattr(args, name, binary)
        colmap_help = run_command("colmap-help", [args.colmap, "-h"], output, report, 30)
        if not re.search(r"\b4\.1\.0\b", colmap_help):
            raise ValueError("COLMAP 4.1.0 identity missing from help")
        verify_colmap_help(args.colmap, output, report)
        if not args.sfm_only:
            brush_help = run_command("brush-help", [args.brush, "--help"], output, report, 30)
            for required in ("--total-train-iters", "--max-scene-batch-cache-size", "--lod-levels"):
                if not re.search(r"(?m)^\s*" + re.escape(required) + r"(?:\s|=|$)", brush_help):
                    raise ValueError("Brush 1.0 CLI capability missing: " + required)
            brush_version = run_command("brush-version", [args.brush, "--version"], output, report, 30)
            if not re.search(r"\b1\.0\.0\b", brush_version):
                raise ValueError("Brush 1.0.0 version mismatch")
        sparse = output / "sparse"
        sparse.mkdir()
        for label, command in colmap_commands(args.colmap, output / "database.db", input_images,
                                              sparse, args.threads, args.mapper):
            run_command(label, command, output, report, 7200)
        model, registered = select_model(sparse)
        report["reconstruction"] = {"selected_model": model.name, "registered_images": registered,
                                    "input_images": len(inventory),
                                    "registration_rate": registered / len(inventory)}
        if registered < max(3, math.ceil(len(inventory) * 0.8)):
            raise ValueError("Smoke fixture registration rate is below 80%")
        analysis = run_command("model-analysis", [args.colmap, "model_analyzer", "--path", model], output, report)
        report["reconstruction"].update(model_metrics(analysis))
        dataset = output / "dataset"
        run_command("undistort", [args.colmap, "image_undistorter", "--image_path", input_images,
                                  "--input_path", model, "--output_path", dataset,
                                  "--output_type", "COLMAP", "--max_image_size", "960"], output, report)
        report["normalized_dataset"] = [
            {"path": path.relative_to(dataset).as_posix(), "sha256": sha256(path)}
            for directory in ("images", "sparse") for path in sorted((dataset / directory).rglob("*"))
            if path.is_file()]
        if args.sfm_only:
            fixture_inventory(args.images, manifest)
            verify_current_binaries(report)
            report["source_images_unchanged"] = True
            report["status"] = "cpu_sfm_smoke_passed"
            print("CPU SfM smoke passed; Brush and application acceptance remain.")
            return 0
        checkpoints = output / "checkpoints"
        brush_command = [args.brush, dataset, "--total-train-iters", str(args.iterations),
                         "--max-resolution", "960", "--max-splats", "300000",
                         "--max-scene-batch-cache-size", "512MiB", "--sh-degree", "0",
                         "--lod-levels", "0", "--export-every", "100", "--export-path", checkpoints,
                         "--export-name", "checkpoint_{iter}.ply"]
        env = dict(os.environ, RUST_LOG="info,wgpu_core=info,wgpu_hal=info")
        training_log = run_command("training", brush_command, output, report, 7200, env)
        final = checkpoints / ("checkpoint_" + str(args.iterations) + ".ply")
        report["final_ply"] = validate_ply(final)
        report["metal_evidence"] = [line for line in training_log.splitlines()
                                    if re.search(r"backend\s*[:=]\s*Metal\b", line, re.I)]
        report["training_completed_log"] = "Done training!" in training_log
        fixture_inventory(args.images, manifest)
        verify_current_binaries(report)
        report["source_images_unchanged"] = True
        if not report["training_completed_log"]:
            raise ValueError("Brush did not report completed training")
        if not report["metal_evidence"]:
            report["status"] = "training_passed_backend_unverified"
            print("Valid trained PLY; actual Metal backend evidence is still missing.")
            return 2
        report["status"] = "engine_smoke_passed"
        print("CPU SfM and Metal training smoke passed; application/visual/release acceptance remains.")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = type(error).__name__ + ": " + str(error)
        print(report["error"], file=sys.stderr)
        return 1
    finally:
        atomic_json(output / "evidence.json", report)


if __name__ == "__main__":
    sys.exit(main())
