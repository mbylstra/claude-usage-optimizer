#!/usr/bin/env python3
"""Unit tests for the pure logic in run-autonomous-work.py.

Deliberately does not test `run_claude`, `main`, or anything else that spawns
a subprocess, touches launchd, or talks to the real filesystem beyond a throwaway
temp directory — that's end-to-end territory, and much harder to keep fast and
deterministic. What's covered here is the decision logic split out specifically
to make it testable: `evaluate_pace_gate`, `determine_outcome`,
`queue_status_for_outcome`, `rewrite_status_line`, the queue parser, and the
various pure formatting helpers.

The module under test is loaded by file path (its filename has hyphens, so it
cannot be `import`ed normally), with every file path it touches at import time
redirected into a temp directory first. Running these tests never reads or
writes this machine's actual queue, log, snapshot or settings files.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SCRIPT_DIRECTORY = Path(__file__).resolve().parent.parent

_TEMP_DIRECTORY = tempfile.TemporaryDirectory()
_TEMP_PATH = Path(_TEMP_DIRECTORY.name)

# A launchctl that records rather than acts, so scheduling a resume in a test
# never loads a job on the machine running it.
_FAKE_LAUNCHCTL = _TEMP_PATH / "launchctl"
_FAKE_LAUNCHCTL.write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
_FAKE_LAUNCHCTL.chmod(0o755)

os.environ.update(
    {
        "AUTONOMOUS_WORK_USAGE_FILE": str(_TEMP_PATH / "claude-usage.json"),
        "AUTONOMOUS_WORK_QUEUE_FILE": str(_TEMP_PATH / "prompts.txt"),
        "AUTONOMOUS_WORK_LOG_FILE": str(_TEMP_PATH / "autonomous-work.log"),
        "AUTONOMOUS_WORK_EVENT_FILE": str(_TEMP_PATH / "autonomous-work.jsonl"),
        "AUTONOMOUS_WORK_RUN_EVENT_FILE": str(_TEMP_PATH / "autonomous-run-events.jsonl"),
        "AUTONOMOUS_WORK_SUMMARIES_DIR": str(_TEMP_PATH / "summaries"),
        "AUTONOMOUS_WORK_NEW_PROJECTS_DIR": str(_TEMP_PATH / "projects"),
        "AUTONOMOUS_WORK_SETTINGS_FILE": str(_TEMP_PATH / "autonomous-work-settings.json"),
        "AUTONOMOUS_WORK_MAX_PROMPT_DURATION_SECONDS": "5",
        # The resume machinery reaches for three more paths and for launchctl.
        # Redirected here as well, so a test that schedules a resume writes a
        # plist into a temp directory rather than into ~/Library/LaunchAgents,
        # and "is the nightly job installed?" is a question about this
        # directory rather than about the machine running the tests.
        "AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "nightly.plist"),
        "AUTONOMOUS_WORK_ON_DEMAND_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "ondemand.plist"),
        "AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST": str(_TEMP_PATH / "resume.plist"),
        "AUTONOMOUS_WORK_RESUME_STATE_FILE": str(_TEMP_PATH / "autonomous-work-resume.json"),
        "AUTONOMOUS_WORK_LAUNCHCTL": str(_FAKE_LAUNCHCTL),
    }
)


def _load_module_under_test():
    module_path = SCRIPT_DIRECTORY / "run-autonomous-work.py"
    spec = importlib.util.spec_from_file_location("run_autonomous_work_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


work = _load_module_under_test()


class EnvironmentHelpersTests(unittest.TestCase):
    def test_environment_path_returns_default_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEST_PATH_VAR", None)
            default = Path("/tmp/default")
            self.assertEqual(work.environment_path("TEST_PATH_VAR", default), default)

    def test_environment_path_expands_user(self):
        with mock.patch.dict(os.environ, {"TEST_PATH_VAR": "~/example"}):
            result = work.environment_path("TEST_PATH_VAR", Path("/tmp/default"))
            self.assertEqual(result, Path(os.path.expanduser("~/example")))

    def test_environment_int_default_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEST_INT_VAR", None)
            self.assertEqual(work.environment_int("TEST_INT_VAR", 42), 42)

    def test_environment_int_parses_value(self):
        with mock.patch.dict(os.environ, {"TEST_INT_VAR": "7"}):
            self.assertEqual(work.environment_int("TEST_INT_VAR", 42), 7)

    def test_environment_int_falls_back_on_garbage(self):
        with mock.patch.dict(os.environ, {"TEST_INT_VAR": "not-a-number"}):
            self.assertEqual(work.environment_int("TEST_INT_VAR", 42), 42)

    def test_environment_int_override_none_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEST_OVERRIDE_VAR", None)
            self.assertIsNone(work.environment_int_override("TEST_OVERRIDE_VAR"))

    def test_environment_int_override_parses_value(self):
        with mock.patch.dict(os.environ, {"TEST_OVERRIDE_VAR": "99"}):
            self.assertEqual(work.environment_int_override("TEST_OVERRIDE_VAR"), 99)


class RunEventBoundaryIndicesTests(unittest.TestCase):
    def test_finds_run_started_and_run_skipped_boundaries(self):
        lines = [
            '{"type": "runStarted", "runId": "a"}',
            '{"type": "claudeEvent", "event": {}}',
            "",
            '{"type": "runSkipped", "runId": "b"}',
        ]
        self.assertEqual(work.run_event_boundary_indices(lines), [0, 3])

    def test_ignores_blank_and_unparseable_lines(self):
        lines = ["", "not json", '{"type": "runFinished"}']
        self.assertEqual(work.run_event_boundary_indices(lines), [])

    def test_ignores_non_dict_json(self):
        lines = ["42", '"a string"', "[1, 2, 3]"]
        self.assertEqual(work.run_event_boundary_indices(lines), [])


class SnapshotAgeSecondsTests(unittest.TestCase):
    def test_non_string_returns_none(self):
        self.assertIsNone(work.snapshot_age_seconds(12345))
        self.assertIsNone(work.snapshot_age_seconds(None))

    def test_invalid_iso_returns_none(self):
        self.assertIsNone(work.snapshot_age_seconds("not-a-date"))

    def test_recent_timestamp_is_a_small_positive_age(self):
        recent = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        age = work.snapshot_age_seconds(recent)
        self.assertIsNotNone(age)
        self.assertGreaterEqual(age, 0)
        self.assertLess(age, 5)

    def test_naive_timestamp_is_treated_as_utc(self):
        age = work.snapshot_age_seconds("2020-01-01T00:00:00")
        self.assertIsNotNone(age)
        self.assertGreater(age, 0)


class DescribeAgeTests(unittest.TestCase):
    def test_none_is_unknown(self):
        self.assertEqual(work.describe_age(None), "age unknown")

    def test_minutes(self):
        self.assertEqual(work.describe_age(120), "2 min old")

    def test_hours(self):
        self.assertEqual(work.describe_age(7200), "2.0h old")

    def test_days(self):
        self.assertEqual(work.describe_age(200_000), "2.3 days old")


class DescribePaceTests(unittest.TestCase):
    def test_behind(self):
        self.assertEqual(
            work.describe_pace(-2 * work.MILLISECONDS_PER_HOUR), "2.0h behind an even weekly burn"
        )

    def test_ahead(self):
        self.assertEqual(
            work.describe_pace(3 * work.MILLISECONDS_PER_HOUR), "3.0h ahead of an even weekly burn"
        )

    def test_exactly_zero_reads_as_ahead(self):
        self.assertEqual(work.describe_pace(0), "0.0h ahead of an even weekly burn")


class EvaluatePaceGateTests(unittest.TestCase):
    """The threshold arithmetic behind `check_pace_gate`, isolated from I/O and logging."""

    THRESHOLD_MS = -2 * work.MILLISECONDS_PER_HOUR
    FIVE_HOUR_EXHAUSTED_PERCENT = 100

    def _snapshot(self, delta_ms, five_hour_percent=50.0, age_seconds=60.0):
        return work.PaceSnapshot(
            weekly_pace_delta_ms=delta_ms,
            weekly_pace_status="behind",
            five_hour_percent=five_hour_percent,
            age_seconds=age_seconds,
        )

    def _evaluate(self, pace_snapshot, force=False):
        return work.evaluate_pace_gate(
            pace_snapshot,
            force=force,
            pace_threshold_ms=self.THRESHOLD_MS,
            five_hour_exhausted_percent=self.FIVE_HOUR_EXHAUSTED_PERCENT,
        )

    def test_force_bypasses_everything(self):
        result = self._evaluate(None, force=True)
        self.assertTrue(result.ok)

    def test_no_snapshot_blocks(self):
        result = self._evaluate(None)
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "noSnapshot")

    def test_on_pace_blocks(self):
        result = self._evaluate(self._snapshot(delta_ms=-1 * work.MILLISECONDS_PER_HOUR))
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "onPace")

    def test_behind_pace_with_room_proceeds(self):
        result = self._evaluate(self._snapshot(delta_ms=-3 * work.MILLISECONDS_PER_HOUR, five_hour_percent=50.0))
        self.assertTrue(result.ok)

    def test_five_hour_window_exhausted_blocks_even_when_behind(self):
        result = self._evaluate(self._snapshot(delta_ms=-3 * work.MILLISECONDS_PER_HOUR, five_hour_percent=100.0))
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "fiveHourExhausted")

    def test_missing_five_hour_percent_does_not_block(self):
        result = self._evaluate(self._snapshot(delta_ms=-3 * work.MILLISECONDS_PER_HOUR, five_hour_percent=None))
        self.assertTrue(result.ok)

    def test_exactly_at_threshold_counts_as_behind_not_on_pace(self):
        result = self._evaluate(self._snapshot(delta_ms=self.THRESHOLD_MS))
        self.assertTrue(result.ok)


class ParseResetTimeTests(unittest.TestCase):
    """Reading the CLI's limit notice — wording that is not ours, so read defensively."""

    # A Tuesday, so a weekday in a notice is unambiguously a different day.
    NOW = datetime(2026, 8, 25, 1, 30, tzinfo=timezone(timedelta(hours=10)))

    def test_the_one_wording_we_have_a_sample_of(self):
        parsed = work.parse_reset_time(
            "You've hit your session limit · resets 3:50am (Australia/Melbourne)", self.NOW
        )
        self.assertIsNotNone(parsed)
        self.assertEqual((parsed.hour, parsed.minute), (3, 50))
        self.assertEqual(parsed.date(), self.NOW.date())

    def test_a_bare_hour_with_no_minutes(self):
        parsed = work.parse_reset_time("resets 3am", self.NOW)
        self.assertEqual((parsed.hour, parsed.minute), (3, 0))

    def test_twenty_four_hour_time_without_a_meridiem(self):
        parsed = work.parse_reset_time("resets 13:05", self.NOW)
        self.assertEqual((parsed.hour, parsed.minute), (13, 5))

    def test_a_time_already_past_today_means_tomorrow(self):
        parsed = work.parse_reset_time("resets 1:00am", self.NOW)
        self.assertEqual(parsed.date(), (self.NOW + timedelta(days=1)).date())

    def test_midday_and_midnight_meridiems(self):
        self.assertEqual(work.parse_reset_time("resets 12:00pm", self.NOW).hour, 12)
        self.assertEqual(work.parse_reset_time("resets 12:30am", self.NOW).hour, 0)

    def test_a_weekday_places_the_time_on_that_day(self):
        parsed = work.parse_reset_time("You've hit your weekly limit · resets Thu at 9am", self.NOW)
        # Tuesday the 25th → Thursday the 27th.
        self.assertEqual(parsed.date(), datetime(2026, 8, 27).date())

    def test_an_unknown_zone_falls_back_to_the_local_one(self):
        parsed = work.parse_reset_time("resets 3:50am (Mars/Olympus_Mons)", self.NOW)
        self.assertEqual(parsed.utcoffset(), self.NOW.utcoffset())

    def test_unrecognised_wording_is_none_rather_than_a_guess(self):
        self.assertIsNone(work.parse_reset_time("resets soon", self.NOW))
        self.assertIsNone(work.parse_reset_time("your limit has been reached", self.NOW))
        self.assertIsNone(work.parse_reset_time(None, self.NOW))
        self.assertIsNone(work.parse_reset_time("", self.NOW))

    def test_an_impossible_clock_reading_is_none(self):
        self.assertIsNone(work.parse_reset_time("resets 25:00", self.NOW))
        self.assertIsNone(work.parse_reset_time("resets 13:70", self.NOW))
        self.assertIsNone(work.parse_reset_time("resets 15pm", self.NOW))


class ChooseResumeTimeTests(unittest.TestCase):
    """The three sources, the buffer, and the clamp that rejects a weekly limit."""

    NOW = datetime(2026, 8, 25, 1, 30, tzinfo=timezone(timedelta(hours=10)))
    BUFFER_SECONDS = 120

    def _choose(self, limit_notice=None, snapshot_resets_at=None):
        return work.choose_resume_time(
            self.NOW,
            limit_notice=limit_notice,
            snapshot_resets_at=snapshot_resets_at,
            buffer_seconds=self.BUFFER_SECONDS,
        )

    def test_the_notice_wins_and_is_buffered(self):
        chosen = self._choose(limit_notice="resets 3:50am (Australia/Melbourne)")
        self.assertEqual(chosen.source, work.RESUME_SOURCE_CLI_NOTICE)
        self.assertEqual(
            chosen.fire_at - chosen.resets_at, timedelta(seconds=self.BUFFER_SECONDS)
        )
        self.assertEqual((chosen.fire_at.hour, chosen.fire_at.minute), (3, 52))

    def test_the_notice_beats_a_snapshot_that_disagrees(self):
        chosen = self._choose(
            limit_notice="resets 3:50am",
            snapshot_resets_at=self.NOW + timedelta(hours=4),
        )
        self.assertEqual(chosen.source, work.RESUME_SOURCE_CLI_NOTICE)

    def test_a_weekly_limits_reset_schedules_nothing_at_all(self):
        # Days out, so it is not this window — and no source further down the
        # list should be consulted, because nothing here says this window is
        # spent.
        self.assertIsNone(self._choose(limit_notice="weekly limit · resets Thu 9am"))

    def test_an_unparseable_notice_falls_through_rather_than_blocking(self):
        chosen = self._choose(limit_notice="resets at some point")
        self.assertEqual(chosen.source, work.RESUME_SOURCE_FALLBACK)

    def test_the_snapshot_is_used_when_there_is_no_notice(self):
        resets_at = self.NOW + timedelta(hours=2)
        chosen = self._choose(snapshot_resets_at=resets_at)
        self.assertEqual(chosen.source, work.RESUME_SOURCE_SNAPSHOT)
        self.assertEqual(chosen.resets_at, resets_at)

    def test_a_snapshot_reset_already_past_falls_through_to_the_fallback(self):
        chosen = self._choose(snapshot_resets_at=self.NOW - timedelta(hours=2))
        self.assertEqual(chosen.source, work.RESUME_SOURCE_FALLBACK)

    def test_a_snapshot_reset_beyond_one_window_falls_through_too(self):
        chosen = self._choose(snapshot_resets_at=self.NOW + timedelta(days=3))
        self.assertEqual(chosen.source, work.RESUME_SOURCE_FALLBACK)

    def test_the_fallback_is_one_window_plus_the_buffer(self):
        chosen = self._choose()
        self.assertEqual(
            chosen.fire_at,
            self.NOW
            + timedelta(seconds=work.FIVE_HOUR_WINDOW_SECONDS + self.BUFFER_SECONDS),
        )

    def test_every_source_lands_inside_the_clamp(self):
        for chosen in [
            self._choose(limit_notice="resets 3:50am"),
            self._choose(snapshot_resets_at=self.NOW + timedelta(hours=2)),
            self._choose(),
        ]:
            self.assertGreater(chosen.fire_at, self.NOW)
            self.assertLessEqual(
                chosen.fire_at,
                self.NOW + timedelta(seconds=work.RESUME_MAX_DELAY_SECONDS),
            )


class ReadPaceSnapshotResetTimeTests(unittest.TestCase):
    """The snapshot contract with the extension, including the version skew in it."""

    def _write_snapshot(self, payload):
        work.USAGE_SNAPSHOT_FILE.parent.mkdir(parents=True, exist_ok=True)
        work.USAGE_SNAPSHOT_FILE.write_text(json.dumps(payload), encoding="utf-8")
        self.addCleanup(work.USAGE_SNAPSHOT_FILE.unlink)

    def test_the_reset_time_is_read_when_the_extension_reports_it(self):
        self._write_snapshot(
            {
                "fetchedAt": "2026-08-25T01:00:00.000Z",
                "weeklyPaceDeltaMs": -3600000,
                "fiveHourPercent": 100,
                "fiveHourResetsAt": "2026-08-25T04:00:00.000Z",
            }
        )
        snapshot = work.read_pace_snapshot()
        self.assertEqual(
            snapshot.five_hour_resets_at,
            datetime(2026, 8, 25, 4, 0, tzinfo=timezone.utc),
        )

    def test_an_extension_that_predates_the_field_still_reads(self):
        self._write_snapshot({"fetchedAt": "2026-08-25T01:00:00.000Z", "weeklyPaceDeltaMs": -1})
        snapshot = work.read_pace_snapshot()
        self.assertIsNotNone(snapshot)
        self.assertIsNone(snapshot.five_hour_resets_at)


class ParseQueueTests(unittest.TestCase):
    def test_parses_status_and_prompt(self):
        text = "\n".join(
            [
                "===",
                "STATUS: todo",
                "Do the thing.",
                "Multiple lines.",
                "===",
                "STATUS: completed",
                "REPO: ~/code/foo",
                "Already done.",
            ]
        )
        entries = work.parse_queue(text.split("\n"))
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0].status, "todo")
        self.assertEqual(entries[0].prompt, "Do the thing.\nMultiple lines.")
        self.assertIsNone(entries[0].repository_path)
        self.assertEqual(entries[1].status, "completed")
        self.assertEqual(entries[1].repository_path, Path(os.path.expanduser("~/code/foo")))
        self.assertEqual(entries[1].prompt, "Already done.")

    def test_draft_status_is_parsed_like_any_other(self):
        text = "\n".join(["===", "STATUS: Draft", "Not ready yet."])
        entries = work.parse_queue(text.split("\n"))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].status, work.STATUS_DRAFT)
        self.assertEqual(entries[0].prompt, "Not ready yet.")

    def test_an_unmerged_status_keeps_its_branch_name(self):
        text = "\n".join(["===", "STATUS: unmerged:Add-Widget", "Done, on a branch."])
        entries = work.parse_queue(text.split("\n"))
        self.assertEqual(entries[0].status, "unmerged:Add-Widget")
        self.assertEqual(entries[0].status_name, work.STATUS_UNMERGED)

    def test_section_without_status_is_ignored(self):
        text = "\n".join(["===", "Just some notes, no STATUS line."])
        entries = work.parse_queue(text.split("\n"))
        self.assertEqual(entries, [])

    def test_repo_line_after_prompt_started_is_not_treated_as_repo_field(self):
        text = "\n".join(
            [
                "===",
                "STATUS: todo",
                "First do this.",
                "REPO: ~/should-not-be-parsed-as-repo",
            ]
        )
        entries = work.parse_queue(text.split("\n"))
        self.assertEqual(len(entries), 1)
        self.assertIsNone(entries[0].repository_path)
        self.assertEqual(entries[0].prompt, "First do this.\nREPO: ~/should-not-be-parsed-as-repo")


class FindNextTodoTests(unittest.TestCase):
    def test_returns_first_todo_with_a_prompt(self):
        entries = [
            work.QueueEntry(status="completed", handle=0, repository_path=None, prompt="done"),
            work.QueueEntry(status="todo", handle=1, repository_path=None, prompt=""),
            work.QueueEntry(status="todo", handle=2, repository_path=None, prompt="do this"),
        ]
        found = work.find_next_todo(entries)
        self.assertIs(found, entries[2])

    def test_none_when_no_todo(self):
        entries = [
            work.QueueEntry(status="completed", handle=0, repository_path=None, prompt="done"),
        ]
        self.assertIsNone(work.find_next_todo(entries))

    def test_draft_is_skipped_in_favour_of_a_later_todo(self):
        entries = [
            work.QueueEntry(
                status=work.STATUS_DRAFT, handle=0, repository_path=None, prompt="still writing"
            ),
            work.QueueEntry(status="todo", handle=1, repository_path=None, prompt="do this"),
        ]
        self.assertIs(work.find_next_todo(entries), entries[1])

    def test_unmerged_work_is_skipped_in_favour_of_a_later_todo(self):
        entries = [
            work.QueueEntry(
                status="unmerged:add-widget",
                handle=0,
                repository_path=None,
                prompt="waiting on an answer",
            ),
            work.QueueEntry(status="todo", handle=1, repository_path=None, prompt="do this"),
        ]
        self.assertIs(work.find_next_todo(entries), entries[1])

    def test_none_when_only_unmerged_work_remains(self):
        entries = [
            work.QueueEntry(
                status="unmerged:add-widget",
                handle=0,
                repository_path=None,
                prompt="waiting on an answer",
            ),
        ]
        self.assertIsNone(work.find_next_todo(entries))

    def test_none_when_only_drafts_remain(self):
        entries = [
            work.QueueEntry(
                status=work.STATUS_DRAFT, handle=0, repository_path=None, prompt="still writing"
            ),
        ]
        self.assertIsNone(work.find_next_todo(entries))


class NormaliseStatusTests(unittest.TestCase):
    def test_a_plain_status_is_lowercased(self):
        self.assertEqual(work.normalise_status(" Todo "), work.STATUS_TODO)

    def test_a_branch_name_keeps_its_case(self):
        # Branch names are case-sensitive, so folding the whole value would name
        # a branch that does not exist.
        self.assertEqual(work.normalise_status("Unmerged: Add-Widget"), "unmerged:Add-Widget")

    def test_a_colon_with_nothing_after_it_is_dropped(self):
        self.assertEqual(work.normalise_status("unmerged:"), work.STATUS_UNMERGED)

    def test_status_name_ignores_the_detail(self):
        self.assertEqual(work.status_name_of("unmerged:Add-Widget"), work.STATUS_UNMERGED)
        self.assertEqual(work.status_name_of(work.STATUS_TODO), work.STATUS_TODO)


class RewriteStatusLineTests(unittest.TestCase):
    def test_replaces_the_targeted_line(self):
        lines = ["===", "STATUS: todo", "Do it."]
        result = work.rewrite_status_line(lines, 1, "completed")
        self.assertEqual(result, ["===", "STATUS: completed", "Do it."])

    def test_does_not_mutate_the_input(self):
        lines = ["===", "STATUS: todo", "Do it."]
        work.rewrite_status_line(lines, 1, "completed")
        self.assertEqual(lines, ["===", "STATUS: todo", "Do it."])

    def test_out_of_range_index_returns_none(self):
        lines = ["===", "STATUS: todo"]
        self.assertIsNone(work.rewrite_status_line(lines, 5, "completed"))

    def test_negative_index_returns_none(self):
        lines = ["===", "STATUS: todo"]
        self.assertIsNone(work.rewrite_status_line(lines, -1, "completed"))

    def test_a_line_that_is_no_longer_a_status_line_returns_none(self):
        # What a run editing the queue above its own entry leaves behind: the
        # index is still in range, but points at somebody's prompt.
        lines = ["===", "STATUS: todo", "Do it."]
        self.assertIsNone(work.rewrite_status_line(lines, 2, "completed"))


class ShortenTests(unittest.TestCase):
    def test_short_text_is_unchanged(self):
        self.assertEqual(work.shorten("hello world"), "hello world")

    def test_collapses_whitespace(self):
        self.assertEqual(work.shorten("hello\n\n  world"), "hello world")

    def test_truncates_long_text_with_ellipsis(self):
        text = "x" * 200
        result = work.shorten(text, limit=10)
        self.assertEqual(len(result), 10)
        self.assertEqual(result, "x" * 9 + "…")


class DescribeToolInputTests(unittest.TestCase):
    def test_non_dict_input_is_blank(self):
        self.assertEqual(work.describe_tool_input("Bash", None), "")
        self.assertEqual(work.describe_tool_input("Bash", "not a dict"), "")

    def test_prefers_command_field(self):
        self.assertEqual(
            work.describe_tool_input("Bash", {"command": "ls -la", "description": "list"}),
            "ls -la",
        )

    def test_falls_back_to_file_path(self):
        self.assertEqual(work.describe_tool_input("Read", {"file_path": "/tmp/x"}), "/tmp/x")

    def test_falls_back_to_sorted_keys_when_no_known_field(self):
        self.assertEqual(
            work.describe_tool_input("Custom", {"zeta": 1, "alpha": 2, "beta": 3, "gamma": 4}),
            "alpha, beta, gamma",
        )


class SummariseStreamEventTests(unittest.TestCase):
    def test_system_init(self):
        event = {"type": "system", "subtype": "init", "model": "opus", "session_id": "abcdef1234567890"}
        lines = work.summarise_stream_event(event)
        self.assertEqual(len(lines), 1)
        self.assertIn("claude started", lines[0])
        self.assertIn("opus", lines[0])
        self.assertIn("abcdef12", lines[0])

    def test_assistant_text_and_tool_use(self):
        event = {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "Looking into it"},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}},
                ]
            },
        }
        lines = work.summarise_stream_event(event)
        self.assertEqual(len(lines), 2)
        self.assertIn("Looking into it", lines[0])
        self.assertIn("Bash(ls)", lines[1])

    def test_result_event(self):
        event = {
            "type": "result",
            "duration_ms": 5000,
            "total_cost_usd": 0.27,
            "num_turns": 6,
            "is_error": False,
            "subtype": "success",
        }
        lines = work.summarise_stream_event(event)
        self.assertEqual(len(lines), 1)
        self.assertIn("claude finished: success", lines[0])
        self.assertIn("6 turns", lines[0])
        self.assertIn("5s", lines[0])
        self.assertIn("$0.27", lines[0])

    def test_result_event_is_error_overrides_subtype(self):
        event = {"type": "result", "is_error": True, "subtype": "success", "num_turns": 1, "duration_ms": 0}
        lines = work.summarise_stream_event(event)
        self.assertIn("claude finished: error", lines[0])

    def test_unknown_event_type_is_silent(self):
        self.assertEqual(work.summarise_stream_event({"type": "something_else"}), [])


class BuildPromptTests(unittest.TestCase):
    def test_empty_append_setting_still_gets_the_mandatory_suffix(self):
        with mock.patch.object(work, "APPEND_TO_ALL_PROMPTS", ""):
            self.assertEqual(
                work.build_prompt("Fix the bug"),
                "Fix the bug" + work.MANDATORY_PROMPT_SUFFIX,
            )

    def test_blank_append_setting_contributes_nothing_but_the_suffix_remains(self):
        with mock.patch.object(work, "APPEND_TO_ALL_PROMPTS", "   "):
            self.assertEqual(
                work.build_prompt("Fix the bug"),
                "Fix the bug" + work.MANDATORY_PROMPT_SUFFIX,
            )

    def test_append_setting_sits_between_the_prompt_and_the_mandatory_suffix(self):
        with mock.patch.object(work, "APPEND_TO_ALL_PROMPTS", "Keep changes small."):
            self.assertEqual(
                work.build_prompt("Fix the bug"),
                "Fix the bug\n\nKeep changes small." + work.MANDATORY_PROMPT_SUFFIX,
            )

    def test_mandatory_suffix_carries_the_branch_and_merge_contract(self):
        # A distinctive literal, so an accidental edit to the constant is caught
        # rather than silently agreeing with itself.
        self.assertIn("Create a new branch for the work", work.MANDATORY_PROMPT_SUFFIX)
        self.assertIn("merge it into main and delete the branch", work.MANDATORY_PROMPT_SUFFIX)
        self.assertTrue(work.build_prompt("anything").endswith(work.MANDATORY_PROMPT_SUFFIX))


class SlugifyPromptTests(unittest.TestCase):
    def test_basic_slug(self):
        self.assertEqual(
            work.slugify_prompt("Add a Random Rated button to the vinyl page"),
            "add-a-random-rated-button-to",
        )

    def test_empty_prompt_falls_back(self):
        self.assertEqual(work.slugify_prompt(""), "prompt")

    def test_punctuation_only_falls_back(self):
        self.assertEqual(work.slugify_prompt("!!! ??? ..."), "prompt")

    def test_respects_word_limit(self):
        self.assertEqual(work.slugify_prompt("one two three", word_limit=2), "one-two")


class DatedProjectNameTests(unittest.TestCase):
    def test_combines_date_and_slug(self):
        today = datetime(2026, 8, 12, 9, 30)
        self.assertEqual(
            work.dated_project_name("Add Random Rated button", today),
            "2026-08-12-add-random-rated-button",
        )


class FirstAvailablePathTests(unittest.TestCase):
    def test_returns_bare_name_when_free(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            self.assertEqual(work.first_available_path(base, "my-project"), base / "my-project")

    def test_suffixes_on_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "my-project").mkdir()
            self.assertEqual(work.first_available_path(base, "my-project"), base / "my-project-2")

    def test_keeps_incrementing_past_multiple_collisions(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "my-project").mkdir()
            (base / "my-project-2").mkdir()
            (base / "my-project-3").mkdir()
            self.assertEqual(work.first_available_path(base, "my-project"), base / "my-project-4")


class DetermineOutcomeTests(unittest.TestCase):
    def test_clean_success(self):
        self.assertEqual(work.determine_outcome(0, False, False), (0, "completed"))

    def test_nonzero_exit_is_error(self):
        self.assertEqual(work.determine_outcome(1, False, False), (1, "error"))

    def test_watchdog_kill_is_timeout_regardless_of_exit_code(self):
        self.assertEqual(work.determine_outcome(0, True, False), (1, "timeout"))
        self.assertEqual(work.determine_outcome(1, True, False), (1, "timeout"))

    def test_background_task_timeout_with_zero_exit_is_error(self):
        # Regression for findings/song-ratings-vinyl-prompt-stall.md: the CLI
        # can force-end a turn (exit 0) while still stuck on a background task.
        self.assertEqual(work.determine_outcome(0, False, True), (0, "error"))

    def test_background_task_timeout_with_nonzero_exit_stays_error(self):
        self.assertEqual(work.determine_outcome(1, False, True), (1, "error"))

    def test_session_limit_overrides_the_nonzero_exit_it_arrives_with(self):
        # The CLI exits 1 on a subscription limit, which is indistinguishable
        # from a genuine failure without the stream.
        self.assertEqual(
            work.determine_outcome(1, False, False, True), (0, work.OUTCOME_SESSION_LIMIT)
        )

    def test_session_limit_outranks_the_watchdog(self):
        self.assertEqual(
            work.determine_outcome(1, True, True, True), (0, work.OUTCOME_SESSION_LIMIT)
        )

    def test_no_session_limit_keeps_the_previous_behaviour(self):
        self.assertEqual(work.determine_outcome(0, False, False, False), (0, "completed"))


class SessionLimitMessageTests(unittest.TestCase):
    """Recognising the CLI's limit notice — the only signal there is."""

    # Recorded verbatim from a real 2026-08-17 run that was wrongly marked as an
    # error; the fields it carries are what the detection keys off.
    REAL_NOTICE = {
        "type": "assistant",
        "message": {
            "model": "<synthetic>",
            "content": [
                {
                    "type": "text",
                    "text": "You've hit your session limit · resets 3:50am (Australia/Melbourne)",
                }
            ],
        },
        "error": "rate_limit",
        "is_api_error_message": True,
    }

    def test_recognises_a_real_rate_limited_assistant_event(self):
        self.assertEqual(
            work.session_limit_message(self.REAL_NOTICE),
            "You've hit your session limit · resets 3:50am (Australia/Melbourne)",
        )

    def test_error_code_alone_is_enough_even_with_unfamiliar_wording(self):
        # The wording is the CLI's and changes; the field is structured.
        event = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Try again later."}]},
            "error": "rate_limit",
        }
        self.assertEqual(work.session_limit_message(event), "Try again later.")

    def test_api_error_message_without_the_code_still_matches_on_wording(self):
        event = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Claude usage limit reached."}]},
            "is_api_error_message": True,
        }
        self.assertEqual(work.session_limit_message(event), "Claude usage limit reached.")

    def test_failed_result_event_carrying_the_notice_matches(self):
        event = {"type": "result", "is_error": True, "result": "You've hit your weekly limit"}
        self.assertEqual(work.session_limit_message(event), "You've hit your weekly limit")

    def test_ordinary_prose_about_limits_is_not_a_limit(self):
        # A prompt about this very feature must not look like it hit one.
        event = {
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "I changed how the session limit is handled."}]
            },
        }
        self.assertIsNone(work.session_limit_message(event))

    def test_an_unrelated_api_error_is_not_a_limit(self):
        event = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "API Error: 500 internal"}]},
            "is_api_error_message": True,
        }
        self.assertIsNone(work.session_limit_message(event))

    def test_a_successful_result_mentioning_limits_is_not_a_limit(self):
        event = {"type": "result", "is_error": False, "result": "Documented the usage limit."}
        self.assertIsNone(work.session_limit_message(event))

    def test_unrelated_event_types_are_ignored(self):
        self.assertIsNone(work.session_limit_message({"type": "system", "subtype": "init"}))


class ClaudeOutputCollectorTests(unittest.TestCase):
    """What the day's summary is able to say about a prompt, given its stream."""

    def test_prefers_the_result_events_text(self):
        collector = work.ClaudeOutputCollector()
        collector.observe(
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "thinking out loud"}]}}
        )
        collector.observe({"type": "result", "result": "Done — shipped it.", "num_turns": 9})

        self.assertEqual(collector.closing_text, "Done — shipped it.")

    def test_falls_back_to_the_last_assistant_message_when_no_result_arrives(self):
        # A timed-out, wedged or cancelled prompt never emits a result event, and
        # "how far did it get" is exactly what the summary must answer then.
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "assistant", "message": {"content": [{"type": "text", "text": "first"}]}})
        collector.observe({"type": "assistant", "message": {"content": [{"type": "text", "text": "second"}]}})

        self.assertEqual(collector.closing_text, "second")

    def test_tool_use_blocks_do_not_count_as_a_closing_message(self):
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "assistant", "message": {"content": [{"type": "text", "text": "on it"}]}})
        collector.observe(
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]}}
        )

        self.assertEqual(collector.closing_text, "on it")

    def test_collects_turns_and_cost(self):
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "result", "result": "done", "num_turns": 25, "total_cost_usd": 1.056})

        self.assertEqual(collector.turns, 25)
        self.assertAlmostEqual(collector.cost_usd, 1.056)

    def test_missing_fields_stay_none(self):
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "result", "subtype": "error"})

        self.assertIsNone(collector.closing_text)
        self.assertIsNone(collector.turns)
        self.assertIsNone(collector.cost_usd)

    def test_ignores_unrelated_events(self):
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "system", "subtype": "init", "model": "claude-opus-5"})

        self.assertIsNone(collector.closing_text)

    def test_notices_a_session_limit_and_keeps_its_wording(self):
        collector = work.ClaudeOutputCollector()
        collector.observe(SessionLimitMessageTests.REAL_NOTICE)

        self.assertTrue(collector.hit_session_limit)
        self.assertIn("session limit", collector.session_limit_notice)

    def test_a_run_that_never_hit_a_limit_says_so(self):
        collector = work.ClaudeOutputCollector()
        collector.observe({"type": "result", "result": "Done.", "num_turns": 3})

        self.assertFalse(collector.hit_session_limit)
        self.assertIsNone(collector.session_limit_notice)


class RemainingTodoPromptsTests(unittest.TestCase):
    def setUp(self):
        work.QUEUE_FILE.write_text(
            "\n".join(
                [
                    "STATUS: completed",
                    "Already done",
                    "===",
                    "STATUS: todo",
                    "Cancelled part way",
                    "===",
                    "STATUS: todo",
                    "Never reached",
                    "===",
                    "STATUS: draft",
                    "Still being written",
                    "===",
                    "STATUS: error",
                    "Failed earlier",
                ]
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        work.QUEUE_FILE.unlink(missing_ok=True)

    def test_lists_todo_entries_in_queue_order(self):
        self.assertEqual(
            work.remaining_todo_prompts([]), ["Cancelled part way", "Never reached"]
        )

    def test_excludes_prompts_this_session_already_attempted(self):
        # A cancelled prompt is deliberately left as `todo`; it belongs in the
        # summary as the one that was cut short, not again as one never reached.
        self.assertEqual(
            work.remaining_todo_prompts(["Cancelled part way"]), ["Never reached"]
        )

    def test_missing_queue_file_is_not_an_error(self):
        work.QUEUE_FILE.unlink(missing_ok=True)
        self.assertEqual(work.remaining_todo_prompts([]), [])


class ScheduleResumeIfWarrantedTests(unittest.TestCase):
    """The guards from the plan's §3, each of which exists to stop a chain.

    Everything these touch is redirected into the temp directory at the top of
    this file: the nightly agent's path is a file here, launchctl is a script
    that does nothing, and the state file is written beside them.
    """

    NOW = datetime(2026, 8, 25, 1, 30).astimezone()
    SESSION_LIMIT_NOTICE = "You've hit your session limit · resets 3:50am"

    def setUp(self):
        work.QUEUE_FILE.write_text("STATUS: todo\nSomething to come back for\n", encoding="utf-8")
        # The resume only happens where the user has already asked for
        # unattended work, so every test that expects one starts from there.
        work.autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.write_text("", encoding="utf-8")
        self.events = work.RunEventStream(run_id="test", enabled=False)

    def tearDown(self):
        work.QUEUE_FILE.unlink(missing_ok=True)
        work.autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.unlink(missing_ok=True)
        work.autonomous_work_resume.RESUME_STATE_FILE.unlink(missing_ok=True)
        work.autonomous_work_resume.INSTALLED_RESUME_LAUNCH_AGENT_FILE.unlink(missing_ok=True)

    def _schedule(self, **overrides):
        arguments = {
            "limit_notice": self.SESSION_LIMIT_NOTICE,
            "snapshot_resets_at": None,
            "forced": False,
            "is_resume_run": False,
            "events": self.events,
            "now": self.NOW,
        }
        arguments.update(overrides)
        return work.schedule_resume_if_warranted("sessionLimit", **arguments)

    def test_a_session_limit_with_work_queued_schedules_one(self):
        pending = self._schedule()
        self.assertIsNotNone(pending)
        self.assertEqual((pending.scheduled_for.hour, pending.scheduled_for.minute), (3, 52))
        self.assertTrue(work.autonomous_work_resume.INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists())

    def test_a_resume_run_schedules_nothing_further(self):
        # The guard that makes every freshness check unnecessary: a resumed run
        # reads the same possibly-stale snapshot, so allowing it to schedule
        # another would let one reading walk through the following day.
        self.assertIsNone(self._schedule(is_resume_run=True))
        self.assertFalse(work.autonomous_work_resume.INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists())

    def test_a_forced_run_schedules_nothing(self):
        self.assertIsNone(self._schedule(forced=True))

    def test_a_second_run_the_same_day_schedules_nothing(self):
        self.assertIsNotNone(self._schedule())
        self.assertIsNone(self._schedule(now=self.NOW + timedelta(hours=1)))

    def test_a_run_the_next_day_may_schedule_one_again(self):
        self.assertIsNotNone(self._schedule())
        self.assertIsNotNone(self._schedule(now=self.NOW + timedelta(days=1)))

    def test_nothing_is_scheduled_where_the_nightly_job_is_not_installed(self):
        # Writing a launch agent nobody asked for is not this script's call —
        # least of all right after somebody ran `just uninstall-autonomous-work`.
        work.autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.unlink()
        self.assertIsNone(self._schedule())

    def test_an_empty_queue_schedules_nothing(self):
        work.QUEUE_FILE.write_text("STATUS: completed\nAll done\n", encoding="utf-8")
        self.assertIsNone(self._schedule())

    def test_a_missing_queue_schedules_nothing(self):
        work.QUEUE_FILE.unlink()
        self.assertIsNone(self._schedule())

    def test_a_weekly_limit_schedules_nothing(self):
        self.assertIsNone(
            self._schedule(limit_notice="You've hit your weekly limit · resets Thu 9am")
        )
        self.assertFalse(work.autonomous_work_resume.INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists())

    def test_the_exhausted_gate_ending_uses_the_snapshots_reset_time(self):
        pending = self._schedule(
            limit_notice=None, snapshot_resets_at=self.NOW + timedelta(hours=2)
        )
        self.assertEqual(pending.source, work.RESUME_SOURCE_SNAPSHOT)

    def test_with_no_notice_and_no_snapshot_it_still_comes_back(self):
        pending = self._schedule(limit_notice=None)
        self.assertEqual(pending.source, work.RESUME_SOURCE_FALLBACK)


class WriteQueueStatusTests(unittest.TestCase):
    """The one place the queue file is written, exercised against a real file.

    Goes through `work.QUEUE`, which is a `FileQueueSource` here because no
    queue source is configured — the same object `main` writes through. Its file
    is `work.QUEUE_FILE`, pointed into this module's temp directory by the
    environment set up at the top, so nothing here touches the real queue.
    """

    def _write_queue(self, *lines: str) -> None:
        work.QUEUE_FILE.write_text("\n".join(lines), encoding="utf-8")

    def _queue_lines(self) -> list[str]:
        return work.QUEUE_FILE.read_text(encoding="utf-8").split("\n")

    def _record(self, status_line_index: int, new_status: str) -> str:
        entry = work.QueueEntry(
            status=work.STATUS_TODO,
            handle=status_line_index,
            repository_path=None,
            prompt="Do it.",
        )
        return work.record_outcome(entry, new_status)

    def tearDown(self):
        work.QUEUE_FILE.unlink(missing_ok=True)

    def test_writes_the_status_and_reports_it_back(self):
        self._write_queue("===", "STATUS: todo", "Do it.")
        left_as = self._record(1, work.STATUS_COMPLETED)
        self.assertEqual(left_as, work.STATUS_COMPLETED)
        self.assertEqual(self._queue_lines()[1], "STATUS: completed")

    def test_an_unmerged_status_the_run_wrote_itself_survives(self):
        # The run is the only party that can have written this, and it is the
        # only one that knows where it left the work.
        self._write_queue("===", "STATUS: unmerged:Add-Widget", "Do it.")
        left_as = self._record(1, work.STATUS_COMPLETED)
        self.assertEqual(left_as, "unmerged:Add-Widget")
        self.assertEqual(self._queue_lines()[1], "STATUS: unmerged:Add-Widget")

    def test_an_unmerged_status_outranks_an_error_too(self):
        self._write_queue("===", "STATUS: unmerged:add-widget", "Do it.")
        self.assertEqual(self._record(1, work.STATUS_ERROR), "unmerged:add-widget")

    def test_a_shifted_index_leaves_the_file_alone(self):
        # A run that inserted a line above its own entry: the index still lands
        # inside the file, but on a line of somebody's prompt.
        self._write_queue("===", "A note added mid-run.", "STATUS: todo", "Do it.")
        left_as = self._record(1, work.STATUS_COMPLETED)
        self.assertEqual(left_as, work.STATUS_COMPLETED)
        self.assertEqual(self._queue_lines()[1], "A note added mid-run.")
        self.assertEqual(self._queue_lines()[2], "STATUS: todo")

    def test_a_missing_queue_file_reports_the_status_it_was_asked_for(self):
        work.QUEUE_FILE.unlink(missing_ok=True)
        self.assertEqual(self._record(1, work.STATUS_COMPLETED), work.STATUS_COMPLETED)


class UnmergedBranchAfterRunTests(unittest.TestCase):
    """Real git repositories in a temp directory — the whole point is what git says.

    Mocking git here would only test the argument strings, and the questions
    being asked (is this branch contained in that one?) are exactly the ones git
    answers and a fake would have to re-implement.
    """

    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.repository = Path(self._directory.name)
        self.addCleanup(self._directory.cleanup)

    def git(self, *arguments: str) -> None:
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                *arguments,
            ],
            cwd=self.repository,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def init_repository(self, default_branch: str = "main") -> None:
        self.git("init", "--quiet", f"--initial-branch={default_branch}")
        self.git("commit", "--quiet", "--allow-empty", "-m", "first")

    def commit(self, message: str = "work") -> None:
        self.git("commit", "--quiet", "--allow-empty", "-m", message)

    def test_a_branch_left_ahead_of_main_is_reported(self):
        self.init_repository()
        before = work.capture_git_checkpoint(self.repository)
        self.git("checkout", "--quiet", "-b", "add-widget")
        self.commit()
        self.assertEqual(work.unmerged_branch_after_run(self.repository, before), "add-widget")

    def test_a_branch_merged_into_main_is_not_reported_even_if_still_checked_out(self):
        self.init_repository()
        before = work.capture_git_checkpoint(self.repository)
        self.git("checkout", "--quiet", "-b", "add-widget")
        self.commit()
        self.git("checkout", "--quiet", "main")
        self.git("merge", "--quiet", "--no-ff", "-m", "merge", "add-widget")
        self.git("checkout", "--quiet", "add-widget")
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_committing_straight_to_main_is_not_unmerged(self):
        self.init_repository()
        before = work.capture_git_checkpoint(self.repository)
        self.commit()
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_uncommitted_changes_are_not_unmerged_work(self):
        self.init_repository()
        before = work.capture_git_checkpoint(self.repository)
        (self.repository / "notes.txt").write_text("left for review", encoding="utf-8")
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_a_branch_the_run_never_touched_is_left_alone(self):
        # Somebody else's half-finished work, checked out when the prompt
        # started. Claiming it would put it in the queue under this prompt.
        self.init_repository()
        self.git("checkout", "--quiet", "-b", "someone-elses-work")
        self.commit()
        before = work.capture_git_checkpoint(self.repository)
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_commits_added_to_a_pre_existing_branch_are_reported(self):
        self.init_repository()
        self.git("checkout", "--quiet", "-b", "add-widget")
        before = work.capture_git_checkpoint(self.repository)
        self.commit()
        self.assertEqual(work.unmerged_branch_after_run(self.repository, before), "add-widget")

    def test_a_new_project_with_no_default_branch_to_merge_into_reports_nothing(self):
        # `git init` on a machine whose init.defaultBranch is neither main nor
        # master: the one branch there is *is* the work, not a detour from it.
        before = work.capture_git_checkpoint(self.repository)
        self.init_repository(default_branch="trunk")
        self.commit()
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_a_directory_that_is_not_a_repository_reports_nothing(self):
        before = work.capture_git_checkpoint(self.repository)
        (self.repository / "notes.txt").write_text("no repository here", encoding="utf-8")
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))

    def test_a_detached_head_is_not_a_branch(self):
        self.init_repository()
        before = work.capture_git_checkpoint(self.repository)
        self.git("checkout", "--quiet", "-b", "add-widget")
        self.commit()
        self.git("checkout", "--quiet", "--detach")
        self.assertIsNone(work.unmerged_branch_after_run(self.repository, before))


class QueueStatusForOutcomeTests(unittest.TestCase):
    def test_completed_maps_to_completed_status(self):
        self.assertEqual(work.queue_status_for_outcome("completed"), work.STATUS_COMPLETED)

    def test_error_maps_to_error_status(self):
        self.assertEqual(work.queue_status_for_outcome("error"), work.STATUS_ERROR)

    def test_timeout_maps_to_error_status(self):
        self.assertEqual(work.queue_status_for_outcome("timeout"), work.STATUS_ERROR)

    def test_session_limit_leaves_the_entry_todo(self):
        # The whole point: a prompt the subscription limit refused never ran, so
        # it must stay queued rather than be skipped for good as an error.
        self.assertEqual(
            work.queue_status_for_outcome(work.OUTCOME_SESSION_LIMIT), work.STATUS_TODO
        )

    def test_zero_exit_code_error_outcome_is_not_marked_completed(self):
        # The exact bug findings/song-ratings-vinyl-prompt-stall.md describes:
        # exit_code 0 must not automatically mean STATUS: completed.
        exit_code, outcome = work.determine_outcome(0, False, True)
        self.assertEqual(exit_code, 0)
        self.assertEqual(work.queue_status_for_outcome(outcome), work.STATUS_ERROR)

    def test_completed_work_left_on_a_branch_names_that_branch(self):
        self.assertEqual(
            work.queue_status_for_outcome("completed", "add-widget"), "unmerged:add-widget"
        )

    def test_a_branch_does_not_soften_an_error(self):
        # Both are true of the run, and "error" is the one worth reading: it is
        # the status that keeps the entry from being treated as done.
        self.assertEqual(work.queue_status_for_outcome("error", "add-widget"), work.STATUS_ERROR)

    def test_a_branch_does_not_override_a_session_limit(self):
        self.assertEqual(
            work.queue_status_for_outcome(work.OUTCOME_SESSION_LIMIT, "add-widget"),
            work.STATUS_TODO,
        )


class ClaudeModelIdForTests(unittest.TestCase):
    """Which concrete model id one queued entry runs on — see `claude_model_id_for`."""

    def _entry(self, model_name):
        return work.QueueEntry(
            status=work.STATUS_TODO,
            handle=0,
            repository_path=None,
            prompt="Do it.",
            model_name=model_name,
        )

    def test_an_entry_that_names_a_model_runs_on_that_model(self):
        self.assertEqual(work.claude_model_id_for(self._entry("sonnet")), "claude-sonnet-5")
        self.assertEqual(work.claude_model_id_for(self._entry("opus")), "claude-opus-5")

    def test_an_entry_that_names_nothing_runs_on_the_session_default(self):
        self.assertEqual(work.claude_model_id_for(self._entry(None)), work.CLAUDE_MODEL)

    def test_an_unrecognised_name_falls_back_to_the_session_default(self):
        # `selected_model_name` should already have screened this out on the Jira
        # side, but the mapping must not blow up if one slips through. "haiku" is
        # now one of these: dropped from `_MODEL_ID_MAP` because auto permission
        # mode does not support it.
        self.assertEqual(work.claude_model_id_for(self._entry("gpt-4")), work.CLAUDE_MODEL)
        self.assertEqual(work.claude_model_id_for(self._entry("haiku")), work.CLAUDE_MODEL)

    def test_the_env_override_wins_over_the_entry(self):
        # `AUTONOMOUS_WORK_MODEL` is an explicit "run everything on X" for the
        # whole session, the same precedence the other env knobs follow.
        with mock.patch.object(work, "_MODEL_NAME_FORCED_BY_ENV", "sonnet"), mock.patch.object(
            work, "CLAUDE_MODEL", "claude-sonnet-5"
        ):
            self.assertEqual(work.claude_model_id_for(self._entry("opus")), "claude-sonnet-5")

    def test_the_model_pin_is_the_first_two_claude_arguments(self):
        # Losing `--model` off the front of the invocation is the regression the
        # module's own line-190 comment records having shipped once.
        arguments = work.claude_arguments_for(self._entry("sonnet"))
        self.assertEqual(arguments[:2], ["--model", "claude-sonnet-5"])
        self.assertEqual(arguments[2:], work.CLAUDE_BASE_ARGUMENTS)
        self.assertNotIn("--model", work.CLAUDE_BASE_ARGUMENTS)


if __name__ == "__main__":
    unittest.main()
