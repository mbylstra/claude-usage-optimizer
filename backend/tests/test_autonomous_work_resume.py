#!/usr/bin/env python3
"""Unit tests for autonomous_work_resume.py.

The state file's shape and its guards, plus the launch agent's lifecycle driven
through a **fake launchctl** — a shell script that records its arguments — so
these tests never load, unload or overwrite a job on the machine running them.
Every path the module touches is redirected into a temp directory first, the
same arrangement `test_autonomous_work_settings.py` uses.

Loaded via a distinct module name so this file's environment overrides can never
be shadowed by another test module that imported the real names first: each test
file gets its own fresh copy, independent of run order.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent.parent

_TEMP_DIRECTORY = tempfile.TemporaryDirectory()
_TEMP_PATH = Path(_TEMP_DIRECTORY.name)

_LAUNCHCTL_LOG = _TEMP_PATH / "launchctl-calls"
_FAKE_LAUNCHCTL = _TEMP_PATH / "launchctl"
_FAKE_LAUNCHCTL.write_text(
    '#!/bin/bash\necho "$@" >> "{}"\n'.format(_LAUNCHCTL_LOG), encoding="utf-8"
)
_FAKE_LAUNCHCTL.chmod(0o755)

os.environ.update(
    {
        "AUTONOMOUS_WORK_SETTINGS_FILE": str(_TEMP_PATH / "autonomous-work-settings.json"),
        "AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "nightly.plist"),
        "AUTONOMOUS_WORK_ON_DEMAND_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "ondemand.plist"),
        "AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "resume.plist"),
        "AUTONOMOUS_WORK_RESUME_STATE_FILE": str(_TEMP_PATH / "autonomous-work-resume.json"),
        "AUTONOMOUS_WORK_LAUNCHCTL": str(_FAKE_LAUNCHCTL),
    }
)


def _load_module_under_test():
    module_path = SCRIPT_DIRECTORY / "autonomous_work_resume.py"
    spec = importlib.util.spec_from_file_location("autonomous_work_resume_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


resume_module = _load_module_under_test()

NOW = datetime(2026, 8, 25, 1, 30).astimezone()


def a_pending_resume(**overrides):
    fields = {
        "scheduled_for": NOW + timedelta(hours=3),
        "scheduled_at": NOW,
        "reason": "sessionLimit",
        "source": "cliNotice",
    }
    fields.update(overrides)
    return resume_module.PendingResume(**fields)


class ResumeTestCase(unittest.TestCase):
    """Every test starts with no state file and no agent, whatever the last one left."""

    def setUp(self):
        for path in (
            resume_module.RESUME_STATE_FILE,
            resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE,
        ):
            if path.exists():
                path.unlink()
        if _LAUNCHCTL_LOG.exists():
            _LAUNCHCTL_LOG.unlink()

    def launchctl_calls(self):
        if not _LAUNCHCTL_LOG.exists():
            return []
        return _LAUNCHCTL_LOG.read_text(encoding="utf-8").split("\n")[:-1]

    def stored_state(self):
        return json.loads(resume_module.RESUME_STATE_FILE.read_text(encoding="utf-8"))


class ParseResumeStateTests(ResumeTestCase):
    def test_a_complete_record_round_trips(self):
        pending = a_pending_resume()
        resume_module.write_resume_state(pending)
        self.assertEqual(resume_module.read_resume_state(), pending)

    def test_a_served_record_keeps_its_stamp(self):
        pending = a_pending_resume(served_at=NOW + timedelta(hours=3, minutes=1))
        resume_module.write_resume_state(pending)
        self.assertEqual(resume_module.read_resume_state().served_at, pending.served_at)

    def test_a_record_missing_a_timestamp_is_not_believed(self):
        # Every guard in the module is a clock comparison, so a record that
        # cannot be compared against the clock is worse than no record.
        self.assertIsNone(resume_module.parse_resume_state({"reason": "sessionLimit"}))
        self.assertIsNone(resume_module.parse_resume_state({"scheduledFor": "2026-08-25T06:00:00"}))

    def test_junk_is_not_believed(self):
        self.assertIsNone(resume_module.parse_resume_state(None))
        self.assertIsNone(resume_module.parse_resume_state("not a dict"))
        self.assertIsNone(resume_module.parse_resume_state({"scheduledFor": "yesterday"}))

    def test_an_absent_file_reads_as_no_resume(self):
        self.assertIsNone(resume_module.read_resume_state())
        self.assertIsNone(resume_module.read_pending_resume())


class ReadPendingResumeTests(ResumeTestCase):
    def test_an_unserved_record_is_pending(self):
        resume_module.write_resume_state(a_pending_resume())
        self.assertIsNotNone(resume_module.read_pending_resume())

    def test_a_served_record_is_not_pending_but_is_still_recorded(self):
        resume_module.write_resume_state(a_pending_resume(served_at=NOW))
        self.assertIsNone(resume_module.read_pending_resume())
        self.assertIsNotNone(resume_module.read_resume_state())


class ResumeScheduledTodayTests(ResumeTestCase):
    def test_no_state_means_today_has_had_none(self):
        self.assertFalse(resume_module.resume_scheduled_today(NOW))

    def test_one_scheduled_today_counts(self):
        resume_module.write_resume_state(a_pending_resume())
        self.assertTrue(resume_module.resume_scheduled_today(NOW))

    def test_one_already_served_today_still_counts(self):
        # This is why serving stamps rather than deletes: the record that today
        # had its resume has to outlive the schedule it describes.
        resume_module.write_resume_state(a_pending_resume(served_at=NOW + timedelta(hours=3)))
        self.assertTrue(resume_module.resume_scheduled_today(NOW))

    def test_yesterdays_does_not_count(self):
        resume_module.write_resume_state(
            a_pending_resume(scheduled_at=NOW - timedelta(days=1), served_at=NOW - timedelta(days=1))
        )
        self.assertFalse(resume_module.resume_scheduled_today(NOW))


class ConsumePendingResumeTests(ResumeTestCase):
    def test_a_pending_resume_is_returned_and_stamped(self):
        resume_module.write_resume_state(a_pending_resume())
        served_at = NOW + timedelta(hours=3)

        consumption = resume_module.consume_pending_resume(served_at)

        self.assertIsNotNone(consumption.pending)
        self.assertEqual(resume_module.read_resume_state().served_at, served_at)
        self.assertIsNone(resume_module.read_pending_resume())

    def test_no_state_at_all_is_a_no_op(self):
        consumption = resume_module.consume_pending_resume(NOW)
        self.assertIsNone(consumption.pending)
        self.assertIn("no resume", consumption.detail)

    def test_an_already_served_resume_is_not_served_twice(self):
        resume_module.write_resume_state(a_pending_resume(served_at=NOW))
        consumption = resume_module.consume_pending_resume(NOW + timedelta(minutes=1))
        self.assertIsNone(consumption.pending)
        self.assertIn("already served", consumption.detail)

    def test_a_long_past_resume_is_a_stray_fire(self):
        # The agent is pinned to a Month and Day, so an uncleaned one fires a
        # year later; a sleeping Mac runs a missed calendar job on waking.
        resume_module.write_resume_state(a_pending_resume())
        consumption = resume_module.consume_pending_resume(NOW + timedelta(days=1))
        self.assertIsNone(consumption.pending)
        self.assertIn("too long ago", consumption.detail)

    def test_slightly_late_is_still_served(self):
        resume_module.write_resume_state(a_pending_resume())
        late = NOW + timedelta(hours=3, minutes=30)
        self.assertIsNotNone(resume_module.consume_pending_resume(late).pending)


class ScheduleResumeTests(ResumeTestCase):
    def test_the_agent_is_pinned_to_one_month_day_hour_and_minute(self):
        fire_at = (NOW + timedelta(hours=3)).astimezone()
        update = resume_module.schedule_resume(a_pending_resume(scheduled_for=fire_at))

        self.assertTrue(update.applied, update.detail)
        plist_text = resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE.read_text(encoding="utf-8")
        for key, value in (
            ("Month", fire_at.month),
            ("Day", fire_at.day),
            ("Hour", fire_at.hour),
            ("Minute", fire_at.minute),
        ):
            self.assertIn(
                "<key>{}</key>\n    <integer>{}</integer>".format(key, value), plist_text
            )

    def test_no_placeholder_is_left_unexpanded(self):
        resume_module.schedule_resume(a_pending_resume())
        plist_text = resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE.read_text(encoding="utf-8")
        self.assertNotIn("__", plist_text.split("<plist", 1)[1])

    def test_the_agent_carries_resume_and_never_force(self):
        # --force would bypass the pace gate, which is the whole thing a resume
        # must not do: a week that caught up by then should run nothing.
        resume_module.schedule_resume(a_pending_resume())
        plist_text = resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE.read_text(encoding="utf-8")
        arguments = plist_text.split("<key>ProgramArguments</key>", 1)[1].split("</array>", 1)[0]
        self.assertIn("<string>--resume</string>", arguments)
        self.assertNotIn("--force", arguments)

    def test_launchd_is_asked_to_unload_before_it_is_asked_to_load(self):
        # launchd holds the definition it was given, so rewriting the file
        # without an unload changes the file and nothing else.
        resume_module.schedule_resume(a_pending_resume())
        calls = self.launchctl_calls()
        self.assertEqual(len(calls), 2)
        self.assertTrue(calls[0].startswith("unload "))
        self.assertTrue(calls[1].startswith("load "))

    def test_the_state_is_recorded_alongside_the_agent(self):
        resume_module.schedule_resume(a_pending_resume())
        stored = self.stored_state()
        self.assertEqual(stored["reason"], "sessionLimit")
        self.assertEqual(stored["source"], "cliNotice")
        self.assertIsNone(stored["servedAt"])

    def test_rescheduling_replaces_rather_than_accumulates(self):
        resume_module.schedule_resume(a_pending_resume())
        later = a_pending_resume(scheduled_for=NOW + timedelta(hours=4), source="snapshot")
        resume_module.schedule_resume(later)
        self.assertEqual(self.stored_state()["source"], "snapshot")


class CancelResumeTests(ResumeTestCase):
    def test_cancelling_removes_both_the_agent_and_the_state(self):
        resume_module.schedule_resume(a_pending_resume())

        self.assertTrue(resume_module.cancel_resume())

        self.assertFalse(resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists())
        self.assertFalse(resume_module.RESUME_STATE_FILE.exists())
        self.assertIn("unload {}".format(resume_module.INSTALLED_RESUME_LAUNCH_AGENT_FILE), self.launchctl_calls())

    def test_cancelling_nothing_reports_nothing(self):
        self.assertFalse(resume_module.cancel_resume())

    def test_a_cancelled_resume_no_longer_counts_against_the_day(self):
        # Deliberate: cancelling is the user saying they do not want this run,
        # not spending the day's allowance on it.
        resume_module.schedule_resume(a_pending_resume())
        resume_module.cancel_resume()
        self.assertFalse(resume_module.resume_scheduled_today(NOW))


class DescribePendingResumeTests(ResumeTestCase):
    def test_nothing_pending_says_so(self):
        self.assertIn("No resume", resume_module.describe_pending_resume())

    def test_a_pending_resume_names_its_time_and_why(self):
        resume_module.schedule_resume(a_pending_resume())
        described = resume_module.describe_pending_resume()
        self.assertIn("sessionLimit", described)
        self.assertIn("cliNotice", described)
        self.assertIn("not yet", described)


if __name__ == "__main__":
    unittest.main()
