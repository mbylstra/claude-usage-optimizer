#!/usr/bin/env python3
"""Unit tests for the queue seam and the file source.

The file source's behaviour is the behaviour `run-autonomous-work.py` had before
`QueueSource` existed, so these are the guard on "no behaviour change" — they
exercise the parser, the status vocabulary and the in-place STATUS rewrite
directly, without the scheduler around them.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import queue_source  # noqa: E402  (must follow the sys.path line above)


class StatusVocabularyTests(unittest.TestCase):
    def test_a_plain_status_is_lowercased(self):
        self.assertEqual(queue_source.normalise_status("  ToDo "), "todo")

    def test_a_branch_name_keeps_its_case(self):
        self.assertEqual(
            queue_source.normalise_status("Unmerged: Add-Widget"), "unmerged:Add-Widget"
        )

    def test_an_empty_detail_is_dropped(self):
        self.assertEqual(queue_source.normalise_status("unmerged:"), "unmerged")

    def test_status_name_and_detail_split_at_the_colon(self):
        self.assertEqual(queue_source.status_name_of("unmerged:add-widget"), "unmerged")
        self.assertEqual(queue_source.status_detail_of("unmerged:add-widget"), "add-widget")

    def test_a_status_with_no_detail_has_an_empty_one(self):
        self.assertEqual(queue_source.status_detail_of("completed"), "")


class FileQueueSourceTests(unittest.TestCase):
    """A real file in a temp directory — the whole point is what lands on disk."""

    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.queue_file = Path(self._directory.name) / "prompts.txt"
        self.logged: list[str] = []
        self.source = queue_source.FileQueueSource(self.queue_file, log=self.logged.append)

    def tearDown(self):
        self._directory.cleanup()

    def _write(self, *lines: str) -> None:
        self.queue_file.write_text("\n".join(lines), encoding="utf-8")

    def _lines(self) -> list[str]:
        return self.queue_file.read_text(encoding="utf-8").split("\n")

    def test_a_missing_file_is_unavailable_rather_than_empty(self):
        # The distinction the whole design rests on: "I could not read the queue"
        # must never be mistaken for "there is nothing to do".
        with self.assertRaises(queue_source.QueueUnavailable):
            self.source.next_todo()

    def test_holds_a_todo_is_false_rather_than_raising(self):
        self.assertFalse(self.source.holds_a_todo())

    def test_the_handle_is_the_status_line_index(self):
        self._write("===", "STATUS: todo", "Do it.")
        entry = self.source.next_todo()
        self.assertEqual(entry.handle, 1)
        self.assertEqual(entry.prompt, "Do it.")

    def test_a_repo_line_becomes_the_repository_path(self):
        self._write("===", "STATUS: todo", "REPO: ~/code/thing", "Do it.")
        entry = self.source.next_todo()
        self.assertEqual(entry.repository_path, Path("~/code/thing").expanduser())
        self.assertEqual(entry.prompt, "Do it.")

    def test_only_todo_is_picked_up(self):
        self._write(
            "===", "STATUS: draft", "Still writing.",
            "===", "STATUS: unmerged:add-widget", "Left on a branch.",
            "===", "STATUS: error", "Broke.",
            "===", "STATUS: todo", "Do this one.",
        )
        self.assertEqual(self.source.next_todo().prompt, "Do this one.")

    def test_recording_an_outcome_rewrites_the_status_line(self):
        self._write("===", "STATUS: todo", "Do it.")
        entry = self.source.next_todo()
        self.assertEqual(
            self.source.record_outcome(entry, queue_source.STATUS_COMPLETED),
            queue_source.STATUS_COMPLETED,
        )
        self.assertEqual(self._lines()[1], "STATUS: completed")

    def test_an_unmerged_status_the_run_wrote_itself_survives(self):
        self._write("===", "STATUS: todo", "Do it.")
        entry = self.source.next_todo()
        # The run rewrote the line itself part-way through, as it does when it
        # leaves work on a branch.
        self._write("===", "STATUS: unmerged:Add-Widget", "Do it.")
        self.assertEqual(
            self.source.record_outcome(entry, queue_source.STATUS_COMPLETED),
            "unmerged:Add-Widget",
        )

    def test_a_shifted_index_leaves_the_file_alone(self):
        self._write("===", "STATUS: todo", "Do it.")
        entry = self.source.next_todo()
        self._write("===", "A note added mid-run.", "STATUS: todo", "Do it.")
        self.source.record_outcome(entry, queue_source.STATUS_COMPLETED)
        self.assertEqual(self._lines()[1], "A note added mid-run.")
        self.assertEqual(self._lines()[2], "STATUS: todo")

    def test_start_and_abandon_and_sweep_touch_nothing(self):
        # A file has no In Progress column to be stranded in, so all three are
        # deliberately no-ops — and must leave the file byte-identical.
        self._write("===", "STATUS: todo", "Do it.")
        before = self.queue_file.read_bytes()
        entry = self.source.next_todo()
        self.source.start(entry)
        self.source.abandon(entry)
        self.source.sweep_stale()
        self.assertEqual(self.queue_file.read_bytes(), before)

    def test_remaining_prompts_exclude_the_ones_already_attempted(self):
        self._write(
            "===", "STATUS: todo", "Cut short",
            "===", "STATUS: todo", "Never reached",
        )
        self.assertEqual(
            self.source.remaining_todo_prompts(["Cut short"]), ["Never reached"]
        )

    def test_a_report_is_accepted_and_ignored(self):
        # The file source takes the argument so the scheduler has one call shape,
        # and drops it: a STATUS line has one field and it is already spoken for.
        self._write("===", "STATUS: todo", "Do it.")
        entry = self.source.next_todo()
        self.source.record_outcome(entry, queue_source.STATUS_ERROR, report=object())
        self.assertEqual(self._lines()[1], "STATUS: error")


if __name__ == "__main__":
    unittest.main()
