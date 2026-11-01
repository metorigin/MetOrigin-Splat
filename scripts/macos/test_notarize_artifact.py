#!/usr/bin/env python3
"""Exercise notarization state transitions without credentials or network calls."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("notarize_artifact", Path(__file__).with_name("notarize-artifact.py"))
notary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notary)
JOB = "8b508613-7d8b-4e5e-b90c-80c544343e95"


class Clock:
    def __init__(self):
        self.value = 0

    def now(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class FakeTools:
    def __init__(self, options, statuses=None):
        self.options = options
        self.calls = []
        self.statuses = list(statuses or ["Accepted"])
        self.original_sha = notary.sha256(options.submit_file)
        self.submit_output = json.dumps({"id": JOB, "message": "Successfully uploaded file"})
        self.info_output = None
        self.log_sha = self.original_sha
        self.on_info = None
        self.on_validate = None
        self.timeout_phase = None

    def __call__(self, argv, timeout):
        self.calls.append(argv)
        if argv[1] == "notarytool":
            phase = argv[2]
        else:
            phase = argv[2]
        if phase == self.timeout_phase:
            raise subprocess.TimeoutExpired(argv, timeout)
        output = ""
        if phase == "submit":
            output = self.submit_output
        elif phase == "info":
            if self.on_info:
                self.on_info()
            status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
            self.last_status = status
            output = self.info_output if self.info_output is not None else json.dumps({"id": JOB, "status": status})
        elif phase == "log":
            Path(argv[-1]).write_text(json.dumps({"jobId": JOB, "status": self.last_status,
                                                 "sha256": self.log_sha, "issues": None}))
        elif phase == "staple":
            target = self.options.staple_target
            if target.is_file():
                target.write_bytes(target.read_bytes() + b"-ticket")
            else:
                (target / "Contents" / "CodeResources").write_bytes(b"ticket")
        elif phase == "validate" and self.on_validate:
            self.on_validate()
        return subprocess.CompletedProcess(argv, 0, output, "")

    def count(self, phase):
        return sum(argv[2] == phase for argv in self.calls)


class NotarizationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.submit = self.root / "MetOrigin Splat.dmg"
        self.submit.write_bytes(b"frozen signed disk image")
        self.options = argparse.Namespace(submit_file=self.submit, staple_target=self.submit,
                                          keychain_profile="metorigin-notary", report_dir=self.root / "report",
                                          timeout_seconds=2.0, poll_interval=1.0)
        self.clock = Clock()

    def tearDown(self):
        self.temporary.cleanup()

    def workflow(self, tools=None, options=None):
        return notary.Workflow(options or self.options, runner=tools or self.tools,
                               clock=self.clock.now, sleep=self.clock.sleep)

    def report(self, name):
        return json.loads((self.options.report_dir / name).read_text())

    def app_options(self):
        archive = self.root / "MetOrigin Splat.zip"
        archive.write_bytes(b"frozen zipped application")
        application = self.root / "MetOrigin Splat.app"
        (application / "Contents" / "MacOS").mkdir(parents=True)
        (application / "Contents" / "MacOS" / "MetOrigin Splat").write_bytes(b"signed executable")
        return argparse.Namespace(**dict(vars(self.options), submit_file=archive, staple_target=application))

    def test_invalid_submission_downloads_log_but_never_staples(self):
        self.tools = FakeTools(self.options, ["Invalid"])
        with self.assertRaisesRegex(notary.NotarizationError, "Apple rejected"):
            self.workflow().run()
        self.assertEqual(self.tools.count("log"), 1)
        self.assertEqual(self.tools.count("staple"), 0)
        self.assertEqual(self.report("submission.json")["id"], JOB)
        self.assertEqual(self.report("result.json")["outcome"], "invalid")
        self.assertFalse(self.report("result.json")["notarization_verified"])

    def test_poll_timeout_keeps_id_and_resume_does_not_upload_again(self):
        self.tools = FakeTools(self.options, ["In Progress"])
        with self.assertRaises(notary.NotarizationTimeout):
            self.workflow().run()
        self.assertEqual(self.report("submission.json")["id"], JOB)
        self.assertEqual(self.report("result.json")["outcome"], "timeout")
        self.assertTrue((self.options.report_dir / "info.jsonl").is_file())
        self.tools.statuses = ["Accepted"]
        result = self.workflow().run()
        self.assertTrue(result["ticket_validated"])
        self.assertEqual(self.tools.count("submit"), 1)
        self.assertEqual(self.tools.count("staple"), 1)

    def test_command_timeout_keeps_submission_receipt(self):
        self.tools = FakeTools(self.options)
        self.tools.timeout_phase = "info"
        with self.assertRaises(notary.NotarizationTimeout):
            self.workflow().run()
        self.assertEqual(self.report("submission.json")["id"], JOB)
        self.assertEqual(self.tools.count("staple"), 0)
        self.assertEqual(self.report("result.json")["outcome"], "timeout")

    def test_success_records_pre_post_hashes_and_completed_dmg_resumes(self):
        self.tools = FakeTools(self.options)
        original = notary.sha256(self.submit)
        result = self.workflow().run()
        self.assertEqual(result["submitted_sha256"], original)
        self.assertNotEqual(result["final_sha256"], original)
        self.assertEqual(result["final_sha256"], notary.sha256(self.submit))
        self.assertEqual(result["staple_target_sha256_before"], original)
        self.assertEqual(result["staple_target_sha256_after"], result["final_sha256"])
        receipt = (self.options.report_dir / "result.json").read_bytes()
        command_log = (self.options.report_dir / "commands.jsonl").read_bytes()
        resumed = self.workflow().run()
        self.assertTrue(resumed["resumed_completed"])
        self.assertEqual(self.tools.count("submit"), 1)
        self.assertEqual(self.tools.count("info"), 1)
        self.assertEqual(self.tools.count("staple"), 1)
        self.assertEqual(self.tools.count("validate"), 2)
        self.assertEqual((self.options.report_dir / "result.json").read_bytes(), receipt)
        self.assertEqual((self.options.report_dir / "commands.jsonl").read_bytes(), command_log)

    def test_zip_staples_app_and_preserves_submitted_archive(self):
        options = self.app_options()
        self.tools = FakeTools(options)
        before = notary.target_sha256(options.staple_target)
        result = self.workflow(options=options).run()
        self.assertEqual(result["submitted_sha256"], result["final_sha256"])
        self.assertEqual(result["staple_target_sha256_before"], before)
        self.assertNotEqual(result["staple_target_sha256_after"], before)

    def test_validation_timeout_resumes_post_staple_checkpoint(self):
        self.tools = FakeTools(self.options)
        self.tools.timeout_phase = "validate"
        with self.assertRaises(notary.NotarizationTimeout):
            self.workflow().run()
        self.assertTrue((self.options.report_dir / "staple-state.json").is_file())
        self.tools.timeout_phase = None
        result = self.workflow().run()
        self.assertTrue(result["resumed_stapled"])
        self.assertTrue(result["ticket_validated"])
        self.assertEqual(self.tools.count("submit"), 1)
        self.assertEqual(self.tools.count("info"), 1)
        self.assertEqual(self.tools.count("staple"), 1)

    def test_submit_only_saves_pending_id_and_normal_resume_does_not_reupload(self):
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        self.tools = FakeTools(options)
        result = self.workflow(options=options).run()
        self.assertEqual(result["outcome"], "pending")
        self.assertEqual(result["status"], "Submitted")
        self.assertEqual(result["status_source"], "local-submit-receipt")
        self.assertTrue(result["pending"])
        self.assertFalse(result["accepted"])
        self.assertFalse(result["stapled"])
        self.assertFalse(result["notarization_verified"])
        self.assertEqual(self.report("submission.json")["id"], JOB)
        self.assertEqual([argv[2] for argv in self.tools.calls], ["submit"])
        again = self.workflow(options=options).run()
        self.assertEqual(again["submission_id"], JOB)
        self.assertEqual([argv[2] for argv in self.tools.calls], ["submit"])
        completed = self.workflow().run()
        self.assertTrue(completed["ticket_validated"])
        self.assertEqual(self.tools.count("submit"), 1)
        self.assertEqual(self.tools.count("info"), 1)
        self.assertEqual(self.tools.count("staple"), 1)

    def test_submit_only_preserves_known_accepted_status_without_stapling(self):
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        self.tools = FakeTools(options)
        self.workflow(options=options).run()
        info = {"id": JOB, "status": "Accepted"}
        info_file = self.options.report_dir / "info-latest.json"
        info_file.write_text(json.dumps(info))
        result = self.workflow(options=options).run()
        self.assertEqual(result["status"], "Accepted")
        self.assertTrue(result["pending"])
        self.assertFalse(result["apple_processing_pending"])
        self.assertFalse(result["ticket_validated"])
        self.assertFalse(result["notarization_verified"])
        self.assertEqual(json.loads(info_file.read_text()), info)
        self.assertEqual([argv[2] for argv in self.tools.calls], ["submit"])

    def test_submit_only_does_not_downgrade_saved_invalid_result(self):
        self.tools = FakeTools(self.options, ["Invalid"])
        with self.assertRaises(notary.NotarizationError):
            self.workflow().run()
        saved = (self.options.report_dir / "result.json").read_bytes()
        calls = list(self.tools.calls)
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        with self.assertRaisesRegex(notary.NotarizationError, "saved Apple status is Invalid"):
            self.workflow(options=options).run()
        self.assertEqual((self.options.report_dir / "result.json").read_bytes(), saved)
        self.assertEqual(self.tools.calls, calls)

    def test_submit_only_does_not_downgrade_completed_receipt(self):
        self.tools = FakeTools(self.options)
        self.workflow().run()
        saved = (self.options.report_dir / "result.json").read_bytes()
        calls = list(self.tools.calls)
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        result = self.workflow(options=options).run()
        self.assertEqual(result["outcome"], "accepted")
        self.assertTrue(result["ticket_validated"])
        self.assertEqual((self.options.report_dir / "result.json").read_bytes(), saved)
        self.assertEqual(self.tools.calls, calls)

    def test_submit_only_refuses_replaced_upload_before_any_service_request(self):
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        self.tools = FakeTools(options)
        self.workflow(options=options).run()
        calls = list(self.tools.calls)
        self.submit.write_bytes(b"changed pending file")
        with self.assertRaisesRegex(notary.NotarizationError, "submission file changed"):
            self.workflow(options=options).run()
        self.assertEqual(self.tools.calls, calls)
        self.assertEqual(self.report("submission.json")["id"], JOB)

    def test_submit_only_keeps_post_staple_checkpoint_pending_without_validation(self):
        self.tools = FakeTools(self.options)
        self.tools.timeout_phase = "validate"
        with self.assertRaises(notary.NotarizationTimeout):
            self.workflow().run()
        calls = list(self.tools.calls)
        options = argparse.Namespace(**dict(vars(self.options), submit_only=True))
        result = self.workflow(options=options).run()
        self.assertEqual(result["status"], "Accepted")
        self.assertTrue(result["pending"])
        self.assertTrue(result["stapled"])
        self.assertFalse(result["ticket_validated"])
        self.assertFalse(result["notarization_verified"])
        self.assertEqual(self.tools.calls, calls)
        self.tools.timeout_phase = None
        completed = self.workflow().run()
        self.assertTrue(completed["ticket_validated"])
        self.assertEqual(self.tools.count("submit"), 1)

    def test_changed_file_is_rejected_before_stapling(self):
        self.tools = FakeTools(self.options)
        self.tools.on_info = lambda: self.submit.write_bytes(b"modified while waiting")
        with self.assertRaisesRegex(notary.NotarizationError, "submission file changed"):
            self.workflow().run()
        self.assertEqual(self.tools.count("staple"), 0)
        self.assertEqual(self.report("submission.json")["submitted_sha256"], self.tools.original_sha)

    def test_changed_app_is_rejected_before_stapling(self):
        options = self.app_options()
        self.tools = FakeTools(options)
        self.tools.on_info = lambda: (options.staple_target / "injected").write_bytes(b"changed")
        with self.assertRaisesRegex(notary.NotarizationError, "staple target changed"):
            self.workflow(options=options).run()
        self.assertEqual(self.tools.count("staple"), 0)

    def test_change_during_validation_does_not_grant_success(self):
        self.tools = FakeTools(self.options)
        self.tools.on_validate = lambda: self.submit.write_bytes(b"changed during validation")
        with self.assertRaisesRegex(notary.NotarizationError, "changed during ticket validation"):
            self.workflow().run()
        self.assertFalse(self.report("result.json")["notarization_verified"])
        self.assertEqual(self.report("staple-state.json")["final_sha256"],
                         hashlib.sha256(b"frozen signed disk image-ticket").hexdigest())

    def test_malformed_submit_is_preserved_without_automatic_reupload(self):
        for index, output in enumerate(("not json", "[]", '{"id":"not-a-uuid"}', '{}')):
            with self.subTest(output=output):
                options = argparse.Namespace(**dict(vars(self.options), report_dir=self.root / f"bad-submit-{index}"))
                tools = FakeTools(options)
                tools.submit_output = output
                with self.assertRaises(notary.NotarizationError):
                    self.workflow(tools=tools, options=options).run()
                with self.assertRaisesRegex(notary.NotarizationError, "automatic re-upload is refused"):
                    self.workflow(tools=tools, options=options).run()
                self.assertEqual(tools.count("submit"), 1)
                self.assertEqual(tools.count("staple"), 0)

    def test_malformed_info_is_rejected_without_stapling(self):
        outputs = ("not json", "[]", '{}', json.dumps({"id": JOB}),
                   json.dumps({"id": "09c84e16-1613-4788-be23-8b98ad28328f", "status": "Accepted"}),
                   json.dumps({"id": JOB, "status": "Unexpected"}),
                   json.dumps({"id": JOB, "status": []}))
        for index, output in enumerate(outputs):
            with self.subTest(output=output):
                options = argparse.Namespace(**dict(vars(self.options), report_dir=self.root / f"bad-info-{index}"))
                tools = FakeTools(options)
                tools.info_output = output
                with self.assertRaises(notary.NotarizationError):
                    self.workflow(tools=tools, options=options).run()
                self.assertEqual(tools.count("staple"), 0)

    def test_apple_log_must_match_uploaded_hash(self):
        self.tools = FakeTools(self.options)
        self.tools.log_sha = "0" * 64
        with self.assertRaisesRegex(notary.NotarizationError, "not bound"):
            self.workflow().run()
        self.assertEqual(self.tools.count("staple"), 0)
        self.assertTrue((self.options.report_dir / "apple-log.json").exists())

    def test_pending_resume_refuses_profile_or_file_changes(self):
        self.tools = FakeTools(self.options, ["In Progress"])
        with self.assertRaises(notary.NotarizationTimeout):
            self.workflow().run()
        calls = len(self.tools.calls)
        options = argparse.Namespace(**dict(vars(self.options), keychain_profile="another-profile"))
        with self.assertRaisesRegex(notary.NotarizationError, "another artifact"):
            self.workflow(options=options).run()
        self.assertEqual(len(self.tools.calls), calls)
        self.submit.write_bytes(b"replaced")
        with self.assertRaisesRegex(notary.NotarizationError, "submission file changed"):
            self.workflow().run()
        self.assertEqual(self.tools.count("submit"), 1)

    def test_unsafe_inputs_are_rejected_before_commands_or_reports(self):
        app = self.app_options().staple_target
        linked = self.root / "linked.dmg"
        linked.symlink_to(self.submit)
        cases = [
            dict(submit_file=linked, staple_target=linked),
            dict(report_dir=app / "reports"),
            dict(staple_target=self.root / "other.dmg"),
            dict(keychain_profile="bad\nprofile"),
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                options = argparse.Namespace(**dict(vars(self.options), **changes))
                tools = FakeTools(self.options)
                with self.assertRaises(notary.NotarizationError):
                    self.workflow(tools=tools, options=options)
                self.assertEqual(tools.calls, [])
        self.assertFalse(self.options.report_dir.exists())


if __name__ == "__main__":
    unittest.main()
