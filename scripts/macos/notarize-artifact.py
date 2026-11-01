#!/usr/bin/env python3
"""Submit one frozen artifact to Apple's notary service and staple its ticket.

Credentials are read only by notarytool through a named Keychain profile. The
report directory is a resumable receipt, never a package/latest publication step.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import uuid


class NotarizationError(Exception):
    exit_code = 1


class NotarizationTimeout(NotarizationError):
    exit_code = 2


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def physical_path(value, *, must_exist=True):
    """Reject links before resolving, including links in existing parents."""
    path = Path(os.path.abspath(os.fspath(value)))
    if any(character in str(path) for character in ("\0", "\n", "\r")):
        raise NotarizationError("Artifact and report paths cannot contain control characters.")
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            if must_exist:
                raise NotarizationError("Required path does not exist: " + str(current))
            continue
        if stat.S_ISLNK(mode):
            raise NotarizationError("Symbolic links are not accepted: " + str(current))
    if must_exist and not path.exists():
        raise NotarizationError("Required path does not exist: " + str(path))
    return path


def target_sha256(path):
    """A file hash for DMGs, or a content/mode inventory hash for app bundles."""
    physical_path(path)
    if path.is_file():
        return sha256(path)
    entries = []
    for item in sorted(path.rglob("*")):
        mode = item.lstat().st_mode
        record = {"path": item.relative_to(path).as_posix(), "mode": stat.S_IMODE(mode)}
        if stat.S_ISLNK(mode):
            raise NotarizationError("Symbolic links are not accepted in the staple target: " + str(item))
        if stat.S_ISDIR(mode):
            record["type"] = "directory"
        elif stat.S_ISREG(mode):
            record.update(type="file", sha256=sha256(item), size_bytes=item.stat().st_size)
        else:
            raise NotarizationError("Special files are not accepted in the staple target: " + str(item))
        entries.append(record)
    encoded = json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def regular_report_file(path, *, may_be_missing=False):
    physical_path(path, must_exist=not may_be_missing)
    if path.exists() and not path.is_file():
        raise NotarizationError("Expected a physical report file: " + str(path))


def write_json(path, value, *, exclusive=False):
    regular_report_file(path, may_be_missing=True)
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    if exclusive:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError:
            raise NotarizationError("Another upload already owns this report directory; resume it instead.")
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".notary-", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def append_json(path, value):
    regular_report_file(path, may_be_missing=True)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags, 0o600), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def read_json(path):
    regular_report_file(path)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as error:
        raise NotarizationError("Invalid JSON receipt: " + str(path)) from error
    if not isinstance(value, dict):
        raise NotarizationError("Expected a JSON object: " + str(path))
    return value


def submission_id(value):
    if not isinstance(value, str):
        raise NotarizationError("The notary service did not return a valid submission ID.")
    try:
        parsed = str(uuid.UUID(value))
    except ValueError as error:
        raise NotarizationError("The notary service did not return a valid submission ID.") from error
    if parsed != value.lower():
        raise NotarizationError("The notary service did not return a canonical submission ID.")
    return parsed


def valid_sha256(value):
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def execute(argv, timeout):
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


class Workflow:
    def __init__(self, options, *, runner=execute, clock=time.monotonic, sleep=time.sleep):
        self.runner, self.clock, self.sleep = runner, clock, sleep
        self.timeout = options.timeout_seconds
        self.interval = options.poll_interval
        self.submit_only = bool(getattr(options, "submit_only", False))
        if not math.isfinite(self.timeout) or self.timeout <= 0:
            raise NotarizationError("timeout-seconds must be positive and finite.")
        if not math.isfinite(self.interval) or self.interval <= 0:
            raise NotarizationError("poll-interval must be positive and finite.")
        self.profile = options.keychain_profile
        if (not isinstance(self.profile, str) or not self.profile or self.profile.strip() != self.profile
                or self.profile.startswith("-") or any(ord(character) < 32 for character in self.profile)):
            raise NotarizationError("A nonempty Keychain profile name without control characters is required.")
        self.submit = physical_path(options.submit_file)
        self.target = physical_path(options.staple_target)
        self.report = physical_path(options.report_dir, must_exist=False)
        if not self.submit.is_file() or self.submit.suffix.lower() not in {".zip", ".dmg"}:
            raise NotarizationError("submit-file must be an existing physical .zip or .dmg file.")
        self.kind = "dmg" if self.submit.suffix.lower() == ".dmg" else "app"
        if self.kind == "dmg" and self.target != self.submit:
            raise NotarizationError("A DMG submission must staple the same DMG file.")
        if self.kind == "app" and (not self.target.is_dir() or self.target.suffix.lower() != ".app"):
            raise NotarizationError("A ZIP submission must staple an existing physical .app directory.")
        if self.report == self.target or self.target in self.report.parents:
            raise NotarizationError("The report directory must not be inside the staple target.")
        if self.report.suffix.lower() == ".app" or any(parent.suffix.lower() == ".app" for parent in self.report.parents):
            raise NotarizationError("The report directory must not be inside an application bundle.")
        if self.report.exists() and not self.report.is_dir():
            raise NotarizationError("report-dir must be a physical directory.")
        self.report.mkdir(parents=True, exist_ok=True)
        self.receipt = None
        self.receipt_owned = False
        self.completed = False
        self.staple_checkpoint = None

    def command(self, argv, phase, timeout=None):
        started = utc_now()
        try:
            result = self.runner(argv, timeout if timeout is not None else min(self.timeout, 300))
        except subprocess.TimeoutExpired as error:
            append_json(self.report / "commands.jsonl", {
                "phase": phase, "argv": argv, "started_at_utc": started, "timed_out": True,
            })
            raise NotarizationTimeout(phase + " timed out; the submission receipt is preserved.") from error
        except OSError as error:
            raise NotarizationError(phase + " could not start: " + str(error)) from error
        append_json(self.report / "commands.jsonl", {
            "phase": phase, "argv": argv, "started_at_utc": started,
            "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
        })
        if result.returncode:
            raise NotarizationError(phase + " failed; see commands.jsonl for the tool result.")
        return result.stdout

    def object_response(self, text, phase):
        try:
            value = json.loads(text)
        except (TypeError, ValueError) as error:
            raise NotarizationError(phase + " returned malformed JSON; see commands.jsonl.") from error
        if not isinstance(value, dict):
            raise NotarizationError(phase + " must return a JSON object.")
        return value

    def load_or_submit(self):
        path = self.report / "submission.json"
        if path.exists() or path.is_symlink():
            self.receipt = read_json(path)
            expected = {"schema_version": 1, "submit_file": str(self.submit),
                        "staple_target": str(self.target), "staple_target_kind": self.kind,
                        "keychain_profile": self.profile}
            if any(self.receipt.get(key) != value for key, value in expected.items()):
                raise NotarizationError("The existing submission belongs to another artifact, target, or Keychain profile.")
            if not valid_sha256(self.receipt.get("submitted_sha256")) or not valid_sha256(self.receipt.get("staple_target_sha256_before")):
                raise NotarizationError("The existing submission has invalid artifact identity fields.")
            self.receipt_owned = True
            if not self.receipt.get("id"):
                raise NotarizationError("A previous upload has no recorded ID. Its receipt is preserved; automatic re-upload is refused.")
            submission_id(self.receipt["id"])
            if not self.resume_completed() and not self.resume_stapled():
                self.check_frozen()
            return
        if any((self.report / name).exists() or (self.report / name).is_symlink()
               for name in ("result.json", "commands.jsonl", "info.jsonl", "staple-state.json")):
            raise NotarizationError("The report directory contains prior notarization state without a submission receipt.")
        self.receipt = {
            "schema_version": 1, "submit_file": str(self.submit), "submitted_sha256": sha256(self.submit),
            "staple_target": str(self.target), "staple_target_kind": self.kind,
            "staple_target_sha256_before": target_sha256(self.target),
            "keychain_profile": self.profile, "id": None, "upload_started_at_utc": utc_now(),
        }
        # Claim the directory before a network call. An interrupted/ambiguous
        # upload without an ID must never trigger a duplicate upload on resume.
        write_json(path, self.receipt, exclusive=True)
        self.receipt_owned = True
        output = self.command(["/usr/bin/xcrun", "notarytool", "submit", str(self.submit),
                               "--keychain-profile", self.profile, "--output-format", "json"],
                              "submit", timeout=self.timeout)
        response = self.object_response(output, "submit")
        self.receipt.update(id=submission_id(response.get("id")), response=response,
                            submitted_at_utc=utc_now())
        write_json(path, self.receipt)
        self.check_frozen()

    def check_frozen(self):
        if sha256(self.submit) != self.receipt["submitted_sha256"]:
            raise NotarizationError("The submission file changed after its upload identity was recorded.")
        if target_sha256(self.target) != self.receipt["staple_target_sha256_before"]:
            raise NotarizationError("The staple target changed after its initial identity was recorded.")

    def resume_completed(self):
        path = self.report / "result.json"
        if not path.exists() and not path.is_symlink():
            return False
        result = read_json(path)
        if result.get("outcome") != "accepted" or result.get("ticket_validated") is not True:
            return False
        if (result.get("submission_id") != self.receipt["id"]
                or result.get("submitted_sha256") != self.receipt["submitted_sha256"]
                or result.get("staple_target_sha256_before") != self.receipt["staple_target_sha256_before"]
                or result.get("submit_file") != str(self.submit)
                or result.get("staple_target") != str(self.target)
                or result.get("keychain_profile") != self.profile
                or sha256(self.submit) != result.get("final_sha256")
                or target_sha256(self.target) != result.get("staple_target_sha256_after")
                or sha256(self.report / "apple-log.json") != result.get("apple_log_sha256")):
            raise NotarizationError("The completed receipt does not match the current artifact and staple target.")
        self.check_apple_log("Accepted")
        # Submit-only reuses the exact, already-validated receipt without making
        # another service/tool request. Normal recovery revalidates the ticket.
        if not self.submit_only:
            argv = ["/usr/bin/xcrun", "stapler", "validate", str(self.target)]
            try:
                validation = self.runner(argv, min(self.timeout, 300))
            except (subprocess.TimeoutExpired, OSError) as error:
                raise NotarizationError("The completed ticket could not be validated again.") from error
            if validation.returncode:
                raise NotarizationError("The completed ticket no longer validates.")
        self.completed = True
        self.result = dict(result, resumed_completed=True)
        return True

    def resume_stapled(self):
        path = self.report / "staple-state.json"
        if not path.exists() and not path.is_symlink():
            return False
        state = read_json(path)
        if (state.get("submission_id") != self.receipt["id"]
                or not valid_sha256(state.get("final_sha256"))
                or not valid_sha256(state.get("staple_target_sha256_after"))
                or sha256(self.submit) != state["final_sha256"]
                or target_sha256(self.target) != state["staple_target_sha256_after"]
                or (self.kind == "app" and state["final_sha256"] != self.receipt["submitted_sha256"])):
            raise NotarizationError("The post-staple checkpoint does not match the current artifact and target.")
        self.check_apple_log("Accepted")
        if self.submit_only:
            self.staple_checkpoint = state
            return True
        self.command(["/usr/bin/xcrun", "stapler", "validate", str(self.target)], "validate-resume")
        self.result = self.finish_accepted(state["final_sha256"], state["staple_target_sha256_after"],
                                           resumed_stapled=True)
        self.completed = True
        return True

    def poll(self):
        deadline = self.clock() + self.timeout
        while True:
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise NotarizationTimeout("Notarization status polling timed out; resume with the same report directory.")
            output = self.command(["/usr/bin/xcrun", "notarytool", "info", self.receipt["id"],
                                   "--keychain-profile", self.profile, "--output-format", "json"],
                                  "info", timeout=min(remaining, 120))
            response = self.object_response(output, "info")
            if submission_id(response.get("id")) != self.receipt["id"]:
                raise NotarizationError("info returned another submission ID.")
            status = response.get("status")
            if not isinstance(status, str) or status not in {"In Progress", "Accepted", "Invalid"}:
                raise NotarizationError("info returned an unknown or missing status.")
            observation = dict(response, observed_at_utc=utc_now())
            append_json(self.report / "info.jsonl", observation)
            write_json(self.report / "info-latest.json", observation)
            if status in {"Accepted", "Invalid"}:
                return status
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise NotarizationTimeout("Notarization status polling timed out; resume with the same report directory.")
            self.sleep(min(self.interval, remaining))

    def download_log(self, status):
        path = self.report / "apple-log.json"
        regular_report_file(path, may_be_missing=True)
        self.command(["/usr/bin/xcrun", "notarytool", "log", self.receipt["id"],
                      "--keychain-profile", self.profile, str(path)], "log")
        self.check_apple_log(status)

    def check_apple_log(self, status):
        value = read_json(self.report / "apple-log.json")
        if (submission_id(value.get("jobId")) != self.receipt["id"]
                or value.get("status") != status
                or not isinstance(value.get("sha256"), str)
                or value["sha256"].lower() != self.receipt["submitted_sha256"]):
            raise NotarizationError("The Apple log is not bound to this exact submission and terminal status.")

    def base_result(self):
        receipt = self.receipt or {}
        return {
            "schema_version": 1, "submit_file": str(self.submit),
            "submitted_sha256": receipt.get("submitted_sha256"),
            "submission_id": receipt.get("id"), "keychain_profile": self.profile,
            "staple_target": str(self.target), "staple_target_kind": self.kind,
            "staple_target_sha256_before": receipt.get("staple_target_sha256_before"),
        }

    def finish_accepted(self, final_submit_sha, final_target_sha, **additional):
        if sha256(self.submit) != final_submit_sha or target_sha256(self.target) != final_target_sha:
            raise NotarizationError("The artifact changed during ticket validation.")
        result = dict(self.base_result(), outcome="accepted", status="Accepted", accepted=True,
                      final_sha256=final_submit_sha, staple_target_sha256_after=final_target_sha,
                      stapled=True, ticket_validated=True, notarization_verified=True,
                      apple_log_sha256=sha256(self.report / "apple-log.json"),
                      completed_at_utc=utc_now(), **additional)
        write_json(self.report / "result.json", result)
        return result

    def submitted_only_result(self):
        """Record upload completion, never imply that Apple accepted the file."""
        status, status_source = "Submitted", "local-submit-receipt"
        result_path = self.report / "result.json"
        previous = read_json(result_path) if result_path.exists() else None
        info_path = self.report / "info-latest.json"
        if info_path.exists() or info_path.is_symlink():
            info = read_json(info_path)
            if submission_id(info.get("id")) != self.receipt["id"]:
                raise NotarizationError("Saved info belongs to another submission ID.")
            if info.get("status") not in ("In Progress", "Accepted", "Invalid"):
                raise NotarizationError("Saved info has an unknown or missing status.")
            status, status_source = info["status"], "saved-notary-info"
        # Preserve a known terminal result even if an earlier polling receipt is
        # absent/stale. Submit-only must never reset Invalid/Accepted to Submitted.
        if previous and previous.get("status") in ("Accepted", "Invalid"):
            status, status_source = previous["status"], "saved-result"
        if self.staple_checkpoint:
            status, status_source = "Accepted", "saved-accepted-log-and-staple-checkpoint"
        if status == "Invalid":
            if not previous or previous.get("outcome") != "invalid":
                write_json(result_path, dict(self.base_result(), outcome="invalid", status=status,
                                             status_source=status_source, pending=False, accepted=False,
                                             stapled=False, ticket_validated=False,
                                             notarization_verified=False, submission_only=True,
                                             recorded_at_utc=utc_now()))
            raise NotarizationError("The saved Apple status is Invalid; submit-only will not overwrite that result.")
        result = dict(self.base_result(), outcome="pending", status=status, status_source=status_source,
                      submission_only=True, pending=True, apple_processing_pending=status != "Accepted",
                      accepted=status == "Accepted", stapled=self.staple_checkpoint is not None,
                      ticket_validated=False, notarization_verified=False,
                      current_sha256=sha256(self.submit),
                      staple_target_sha256_current=target_sha256(self.target), recorded_at_utc=utc_now())
        write_json(result_path, result)
        return result

    def run(self):
        try:
            self.load_or_submit()
            if self.completed:
                return self.result
            if self.submit_only:
                return self.submitted_only_result()
            status = self.poll()
            self.download_log(status)
            self.check_frozen()
            if status == "Invalid":
                result = dict(self.base_result(), outcome="invalid", status=status, accepted=False,
                              stapled=False, ticket_validated=False, notarization_verified=False,
                              completed_at_utc=utc_now())
                write_json(self.report / "result.json", result)
                raise NotarizationError("Apple rejected the submission; see apple-log.json. No ticket was stapled.")
            self.command(["/usr/bin/xcrun", "stapler", "staple", str(self.target)], "staple")
            final_submit_sha = sha256(self.submit)
            final_target_sha = target_sha256(self.target)
            if self.kind == "app" and final_submit_sha != self.receipt["submitted_sha256"]:
                raise NotarizationError("The ZIP submission changed while stapling its application.")
            # Preserve the post-staple identities even if the validation command
            # fails or is interrupted. They do not themselves grant acceptance.
            write_json(self.report / "staple-state.json", {
                "submission_id": self.receipt["id"], "final_sha256": final_submit_sha,
                "staple_target_sha256_after": final_target_sha, "recorded_at_utc": utc_now(),
            })
            self.command(["/usr/bin/xcrun", "stapler", "validate", str(self.target)], "validate")
            return self.finish_accepted(final_submit_sha, final_target_sha)
        except NotarizationError as error:
            if not self.receipt_owned:
                raise
            # Never destroy a previously completed receipt, or a terminal Invalid
            # result that has more precise Apple-provided information.
            result_path = self.report / "result.json"
            previous = read_json(result_path) if result_path.exists() else None
            if previous and previous.get("outcome") == "accepted":
                raise
            event = {"outcome": "timeout" if isinstance(error, NotarizationTimeout) else "error",
                     "message": str(error), "recorded_at_utc": utc_now(),
                     "submission_id": (self.receipt or {}).get("id")}
            if not previous or previous.get("outcome") not in {"accepted", "invalid"}:
                write_json(result_path, dict(self.base_result(), **event, accepted=False,
                                             stapled=False, ticket_validated=False,
                                             notarization_verified=False))
            append_json(self.report / "events.jsonl", event)
            raise


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--submit-file", type=Path, required=True)
    parser.add_argument("--staple-target", type=Path, required=True)
    parser.add_argument("--keychain-profile", required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=3600)
    parser.add_argument("--poll-interval", type=float, default=15)
    parser.add_argument("--submit-only", action="store_true",
                        help="Upload/save the submission ID only; exit 0 means submitted, not accepted or stapled. Resume without this flag.")
    return parser.parse_args(argv)


def main(argv=None):
    try:
        result = Workflow(parse_arguments(argv)).run()
    except NotarizationError as error:
        print("Notarization: " + str(error), file=sys.stderr)
        return error.exit_code
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
