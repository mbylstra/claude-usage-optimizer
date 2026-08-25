#!/usr/bin/env python3
"""Unit tests for autonomous_work_summary.py.

The rendering is pure, so almost everything here is a string assertion against
a hand-built session. Only `write_session_summary` touches disk, and it is given
a temp directory — these tests never write to the repository's `summaries/`.

Loaded via a distinct module name, for the same reason
test_autonomous_work_settings.py is: each test file gets its own copy of the
module under test, independent of run order.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent.parent


def _load_module_under_test():
    module_path = SCRIPT_DIRECTORY / "autonomous_work_summary.py"
    spec = importlib.util.spec_from_file_location("autonomous_work_summary_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


summary_module = _load_module_under_test()


def build_attempt(
    prompt: str = "Add a summaries folder\nwith one file per day",
    outcome: str = summary_module.OUTCOME_COMPLETED,
    queue_status: str = "completed",
    result_text: str | None = "Done — added the folder.",
    started_hour: int = 2,
    finished_hour: int = 3,
    **overrides,
):
    fields = dict(
        prompt=prompt,
        working_directory="/Users/someone/code/thing",
        is_new_project=False,
        outcome=outcome,
        queue_status=queue_status,
        result_text=result_text,
        started_at=datetime(2026, 8, 15, started_hour, 0),
        finished_at=datetime(2026, 8, 15, finished_hour, 0),
        turns=12,
        cost_usd=1.5,
    )
    fields.update(overrides)
    return summary_module.PromptAttempt(**fields)


def build_session(**overrides):
    fields = dict(started_at=datetime(2026, 8, 15, 2, 0), forced=False)
    fields.update(overrides)
    session = summary_module.SessionSummary(**fields)
    return session


class PromptTitleTests(unittest.TestCase):
    def test_uses_the_first_non_empty_line(self):
        self.assertEqual(
            summary_module.prompt_title("\n\n  Fix the flaky test  \nand more"), "Fix the flaky test"
        )

    def test_collapses_internal_whitespace(self):
        self.assertEqual(summary_module.prompt_title("Fix   the    test"), "Fix the test")

    def test_truncates_a_long_first_line(self):
        title = summary_module.prompt_title("word " * 100)
        self.assertLessEqual(len(title), summary_module.TITLE_CHARACTER_LIMIT)
        self.assertTrue(title.endswith("…"))

    def test_empty_prompt_is_named_rather_than_blank(self):
        self.assertEqual(summary_module.prompt_title("   \n  "), "(empty prompt)")


class DescribeDurationTests(unittest.TestCase):
    def test_seconds_below_ninety(self):
        self.assertEqual(summary_module.describe_duration(45), "45s")

    def test_minutes(self):
        self.assertEqual(summary_module.describe_duration(600), "10 min")

    def test_hours_past_ninety_minutes(self):
        self.assertEqual(summary_module.describe_duration(7200), "2.0h")


class DescribeStopReasonTests(unittest.TestCase):
    def test_known_reason_without_detail(self):
        self.assertEqual(
            summary_module.describe_stop_reason("emptyQueue", None),
            summary_module.STOP_REASON_DESCRIPTIONS["emptyQueue"],
        )

    def test_detail_is_appended(self):
        described = summary_module.describe_stop_reason("onPace", "1.2h ahead of an even weekly burn")
        self.assertIn("Caught back up to pace", described)
        self.assertIn("(1.2h ahead of an even weekly burn)", described)

    def test_five_hour_exhaustion_is_distinguishable_from_being_on_pace(self):
        exhausted = summary_module.describe_stop_reason("fiveHourExhausted", None)
        self.assertIn("5-hour session window", exhausted)
        self.assertNotIn("even weekly burn", exhausted)

    def test_unknown_reason_is_reported_rather_than_swallowed(self):
        self.assertIn("somethingNew", summary_module.describe_stop_reason("somethingNew", None))

    def test_missing_reason_still_produces_a_sentence(self):
        self.assertTrue(summary_module.describe_stop_reason(None, None).endswith("."))


class RenderSessionSummaryTests(unittest.TestCase):
    def test_a_scheduled_resume_is_stated_under_why_it_stopped(self):
        # Otherwise the queue starts again hours later with nothing in the
        # morning's file to say why.
        session = build_session()
        session.record_attempt(
            build_attempt(
                prompt="Refused by the limit",
                outcome=summary_module.OUTCOME_SESSION_LIMIT,
                queue_status="todo",
            )
        )
        session.stop(summary_module.OUTCOME_SESSION_LIMIT)
        session.resume_scheduled_for = datetime(2026, 8, 15, 6, 17)

        rendered = summary_module.render_session_summary(session)

        self.assertIn("**Resuming:** 06:17", rendered)
        self.assertIn("5-hour session window resets", rendered)

    def test_no_resume_line_when_none_was_scheduled(self):
        session = build_session()
        session.record_attempt(build_attempt())
        session.stop("emptyQueue")
        self.assertNotIn("**Resuming:**", summary_module.render_session_summary(session))

    def test_reports_each_outcome_category(self):
        session = build_session()
        session.record_attempt(build_attempt(prompt="Ship the thing"))
        session.record_attempt(
            build_attempt(
                prompt="Break the thing",
                outcome=summary_module.OUTCOME_ERROR,
                queue_status="error",
                result_text="Could not find the file.",
            )
        )
        session.not_attempted = ["Write the docs"]
        session.stop("onPace", "0.5h ahead of an even weekly burn")
        session.finished_at = datetime(2026, 8, 15, 4, 30)

        rendered = summary_module.render_session_summary(session)

        self.assertIn("### Completed — Ship the thing", rendered)
        self.assertIn("### Failed — Break the thing", rendered)
        self.assertIn("### Not attempted", rendered)
        self.assertIn("- Write the docs", rendered)
        self.assertIn("2 prompts attempted: 1 completed, 1 failed. 1 still queued.", rendered)
        self.assertIn("Caught back up to pace", rendered)
        self.assertIn("02:00–04:30", rendered)

    def test_timeout_reads_as_a_failure_not_a_completion(self):
        session = build_session()
        session.record_attempt(
            build_attempt(outcome=summary_module.OUTCOME_TIMEOUT, queue_status="error")
        )
        session.stop("emptyQueue")

        rendered = summary_module.render_session_summary(session)

        self.assertIn("### Failed (ran past its time limit and was killed)", rendered)
        self.assertIn("0 completed", rendered)

    def test_cancelled_attempt_keeps_its_todo_status(self):
        session = build_session()
        session.record_attempt(
            build_attempt(
                outcome=summary_module.OUTCOME_CANCELLED,
                queue_status="todo",
                result_text="Half way through the refactor.",
            )
        )
        session.stop("cancelled")

        rendered = summary_module.render_session_summary(session)

        self.assertIn("Cancelled part-way through", rendered)
        self.assertIn("Queue entry left as `todo`", rendered)
        # Cancelled is its own category: a run somebody stopped did not fail.
        self.assertIn("1 prompt attempted: 0 completed, 0 failed, 1 cancelled.", rendered)
        # The last thing it said, not a claim about what it finished.
        self.assertIn("Where it got to", rendered)
        self.assertIn("Half way through the refactor.", rendered)

    def test_session_limit_is_not_counted_as_a_failure(self):
        session = build_session()
        session.record_attempt(
            build_attempt(
                prompt="Ship the thing",
                outcome=summary_module.OUTCOME_SESSION_LIMIT,
                queue_status="todo",
                result_text="You've hit your session limit · resets 3:50am (Australia/Melbourne)",
            )
        )
        session.stop(summary_module.OUTCOME_SESSION_LIMIT)

        rendered = summary_module.render_session_summary(session)

        self.assertIn("### Not run (subscription limit reached — still queued)", rendered)
        self.assertIn("Queue entry left as `todo`", rendered)
        # Nothing failed here — the prompt was refused before it ran.
        self.assertIn(
            "1 prompt attempted: 0 completed, 0 failed, 1 stopped by the subscription limit.",
            rendered,
        )
        self.assertIn("What the CLI reported", rendered)
        self.assertIn("A subscription limit was reached", rendered)

    def test_empty_not_attempted_list_says_so(self):
        session = build_session()
        session.record_attempt(build_attempt())
        session.stop("emptyQueue")

        rendered = summary_module.render_session_summary(session)

        self.assertIn("no further `todo` entries", rendered)

    def test_forced_session_is_labelled_as_run_now(self):
        session = build_session(forced=True)
        session.record_attempt(build_attempt())
        session.stop("forcedSingleRun")

        self.assertIn("(run now)", summary_module.render_session_summary(session))

    def test_missing_closing_message_points_at_the_log(self):
        session = build_session()
        session.record_attempt(build_attempt(result_text=None))
        session.stop("emptyQueue")

        self.assertIn("autonomous-work.log", summary_module.render_session_summary(session))

    def test_long_result_text_is_truncated(self):
        session = build_session()
        session.record_attempt(build_attempt(result_text="x" * 10_000))
        session.stop("emptyQueue")

        rendered = summary_module.render_session_summary(session)

        self.assertNotIn("x" * (summary_module.RESULT_TEXT_CHARACTER_LIMIT + 1), rendered)
        self.assertIn("…", rendered)


class WriteSessionSummaryTests(unittest.TestCase):
    def test_creates_the_folder_and_a_dated_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            summaries = Path(temporary_directory) / "summaries"
            session = build_session()
            session.record_attempt(build_attempt())
            session.stop("emptyQueue")

            written_path = summary_module.write_session_summary(summaries, session)

            self.assertEqual(written_path, summaries / "2026-08-15.md")
            self.assertTrue(written_path.exists())
            self.assertIn("# Autonomous work —", written_path.read_text(encoding="utf-8"))

    def test_second_session_the_same_day_appends_to_the_same_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            summaries = Path(temporary_directory) / "summaries"

            morning = build_session()
            morning.record_attempt(build_attempt(prompt="First prompt"))
            morning.stop("emptyQueue")
            summary_module.write_session_summary(summaries, morning)

            evening = build_session(started_at=datetime(2026, 8, 15, 21, 0), forced=True)
            evening.record_attempt(build_attempt(prompt="Second prompt"))
            evening.stop("forcedSingleRun")
            second_path = summary_module.write_session_summary(summaries, evening)

            self.assertEqual(second_path, summaries / "2026-08-15.md")
            self.assertEqual(len(list(summaries.iterdir())), 1)

            contents = second_path.read_text(encoding="utf-8")
            self.assertEqual(contents.count("# Autonomous work —"), 1)
            self.assertIn("First prompt", contents)
            self.assertIn("Second prompt", contents)

    def test_a_different_day_gets_its_own_file(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            summaries = Path(temporary_directory) / "summaries"

            for day in (15, 16):
                session = build_session(started_at=datetime(2026, 8, day, 2, 0))
                session.record_attempt(build_attempt())
                session.stop("emptyQueue")
                summary_module.write_session_summary(summaries, session)

            self.assertEqual(
                sorted(path.name for path in summaries.iterdir()),
                ["2026-08-15.md", "2026-08-16.md"],
            )

    def test_unwritable_destination_reports_none_rather_than_raising(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            # A file where the folder should be: mkdir fails, and a summary must
            # never be able to take the run down with it.
            blocked = Path(temporary_directory) / "summaries"
            blocked.write_text("not a directory", encoding="utf-8")

            session = build_session()
            session.record_attempt(build_attempt())
            session.stop("emptyQueue")

            self.assertIsNone(summary_module.write_session_summary(blocked, session))


if __name__ == "__main__":
    unittest.main()
