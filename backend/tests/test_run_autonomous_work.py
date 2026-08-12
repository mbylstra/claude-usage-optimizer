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
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPT_DIRECTORY = Path(__file__).resolve().parent.parent

_TEMP_DIRECTORY = tempfile.TemporaryDirectory()
_TEMP_PATH = Path(_TEMP_DIRECTORY.name)

os.environ.update(
    {
        "AUTONOMOUS_WORK_USAGE_FILE": str(_TEMP_PATH / "claude-usage.json"),
        "AUTONOMOUS_WORK_QUEUE_FILE": str(_TEMP_PATH / "prompts.txt"),
        "AUTONOMOUS_WORK_LOG_FILE": str(_TEMP_PATH / "autonomous-work.log"),
        "AUTONOMOUS_WORK_EVENT_FILE": str(_TEMP_PATH / "autonomous-work.jsonl"),
        "AUTONOMOUS_WORK_RUN_EVENT_FILE": str(_TEMP_PATH / "autonomous-run-events.jsonl"),
        "AUTONOMOUS_WORK_NEW_PROJECTS_DIR": str(_TEMP_PATH / "projects"),
        "AUTONOMOUS_WORK_SETTINGS_FILE": str(_TEMP_PATH / "autonomous-work-settings.json"),
        "AUTONOMOUS_WORK_MAX_PROMPT_DURATION_SECONDS": "5",
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
            work.QueueEntry(status="completed", status_line_index=0, repository_path=None, prompt="done"),
            work.QueueEntry(status="todo", status_line_index=1, repository_path=None, prompt=""),
            work.QueueEntry(status="todo", status_line_index=2, repository_path=None, prompt="do this"),
        ]
        found = work.find_next_todo(entries)
        self.assertIs(found, entries[2])

    def test_none_when_no_todo(self):
        entries = [
            work.QueueEntry(status="completed", status_line_index=0, repository_path=None, prompt="done"),
        ]
        self.assertIsNone(work.find_next_todo(entries))


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


class QueueStatusForOutcomeTests(unittest.TestCase):
    def test_completed_maps_to_completed_status(self):
        self.assertEqual(work.queue_status_for_outcome("completed"), work.STATUS_COMPLETED)

    def test_error_maps_to_error_status(self):
        self.assertEqual(work.queue_status_for_outcome("error"), work.STATUS_ERROR)

    def test_timeout_maps_to_error_status(self):
        self.assertEqual(work.queue_status_for_outcome("timeout"), work.STATUS_ERROR)

    def test_zero_exit_code_error_outcome_is_not_marked_completed(self):
        # The exact bug findings/song-ratings-vinyl-prompt-stall.md describes:
        # exit_code 0 must not automatically mean STATUS: completed.
        exit_code, outcome = work.determine_outcome(0, False, True)
        self.assertEqual(exit_code, 0)
        self.assertEqual(work.queue_status_for_outcome(outcome), work.STATUS_ERROR)


if __name__ == "__main__":
    unittest.main()
