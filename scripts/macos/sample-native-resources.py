#!/usr/bin/env python3
"""Read-only, bounded native-session evidence. Never induces memory pressure."""

import argparse
import datetime
import json
import pathlib
import subprocess
import sys
import time


def command(arguments):
    result = subprocess.run(arguments, text=True, capture_output=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def sysctl_number(key):
    try:
        return int(command(["/usr/sbin/sysctl", "-n", key]))
    except (ValueError, TypeError):
        return None


def process_sample(root_pid, root_binary):
    table = {}
    for line in (command(["/bin/ps", "-axo", "pid=,ppid=,rss=,comm="]) or "").splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) != 4:
            continue
        pid, parent, rss = map(int, parts[:3])
        table[pid] = {"pid": pid, "parent_pid": parent, "resident_bytes": rss * 1024,
                      "binary": parts[3]}
    root = table.get(root_pid)
    identity_ok = root is not None and root["binary"] == root_binary
    result = []
    if identity_ok:
        for pid, item in table.items():
            cursor, visited = pid, set()
            while cursor in table and cursor not in visited:
                visited.add(cursor)
                if cursor == root_pid:
                    name = pathlib.Path(item["binary"]).name.lower()
                    role = ("application" if pid == root_pid else
                            "brush" if "brush" in name else
                            "colmap" if "colmap" in name else
                            "webkit" if "webkit" in name else None)
                    if role and item["resident_bytes"] > 0:
                        result.append({**item, "role": role})
                    break
                cursor = table[cursor]["parent_pid"]
    return identity_ok, sorted(result, key=lambda item: item["pid"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True, help="Currently verified native app PID")
    parser.add_argument("--binary", required=True, help="Exact app executable path reported by ps")
    parser.add_argument("--output", type=pathlib.Path, required=True, help="New JSONL evidence file")
    parser.add_argument("--stop-file", type=pathlib.Path, help="Stop when this file exists")
    parser.add_argument("--duration", type=float, default=600, help="Maximum seconds; default 600")
    parser.add_argument("--interval", type=float, default=5, help="Seconds between samples; default 5")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This collector uses macOS ps, sysctl and vm_stat.")
    if args.pid <= 0 or not 1 <= args.interval <= 60 or not 1 <= args.duration <= 3600:
        parser.error("Use a positive PID, interval 1–60 seconds and duration 1–3600 seconds.")
    if not process_sample(args.pid, args.binary)[0]:
        parser.error("The requested PID does not currently match the exact app binary path.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves earlier evidence, including interrupted runs.
    with args.output.open("x", encoding="utf-8") as output:
        def emit(value):
            output.write(json.dumps(value, ensure_ascii=False) + "\n")
            output.flush()

        def now():
            return datetime.datetime.now(datetime.timezone.utc).isoformat()

        emit({"type": "metadata", "schema_version": 1, "root_pid": args.pid,
              "root_binary": args.binary, "physical_memory_bytes": sysctl_number("hw.memsize"),
              "interval_seconds": args.interval, "maximum_seconds": args.duration,
              "started_at": now(),
              "scope": "Read-only current-host session; not a 16 GiB acceptance or allocation limit.",
              "rss_caveat": "Per-process RSS can contain shared pages and must not be summed. Only a verified root and descendants are included; zero/unavailable RSS is omitted.",
              "webkit_attribution": "Unknown for launchd/XPC processes; excluded unless ancestry proves ownership.",
              "available_memory": "Raw vm_stat retained; no synthetic available or GPU memory claim."})
        print(args.output, flush=True)
        start = time.monotonic()
        reason = "maximum_duration"
        try:
            while time.monotonic() - start < args.duration:
                if args.stop_file and args.stop_file.exists():
                    reason = "stop_file"
                    break
                present, processes = process_sample(args.pid, args.binary)
                pressure = sysctl_number("kern.memorystatus_vm_pressure_level")
                emit({"type": "sample", "at": now(),
                      "elapsed_seconds": round(time.monotonic() - start, 3),
                      "app_identity_verified": present, "pressure_raw": pressure,
                      "pressure": {1: "normal", 2: "warning", 4: "critical"}.get(pressure),
                      "swap_usage": command(["/usr/sbin/sysctl", "-n", "vm.swapusage"]),
                      "vm_stat": command(["/usr/bin/vm_stat"]), "processes": processes})
                time.sleep(min(args.interval, max(0, args.duration - (time.monotonic() - start))))
        except KeyboardInterrupt:
            reason = "interrupted"
        finally:
            emit({"type": "end", "at": now(), "elapsed_seconds": round(time.monotonic() - start, 3),
                  "reason": reason})


if __name__ == "__main__":
    main()
