#!/usr/bin/env python3
"""The queue behind one interface, so the scheduler stops caring where it lives.

`run-autonomous-work.py` used to read `prompts.txt` directly: parse the file,
find the first `STATUS: todo` section, rewrite that line when the prompt
finished. This module is that behaviour lifted out into a `QueueSource`, so a
second implementation — `queue_source_jira.py`, a Jira board — can take its
place without the scheduler learning anything about issue keys, columns or
ranks. See `plans/work-queue-as-a-jira-board.md` §8.

Two rules hold the seam in place:

* **Ordering is entirely the source's business.** `next_todo` returns the next
  entry and the caller never asks why it was next — line order for the file,
  LexoRank for Jira.
* **The status vocabulary is shared, and it is this file's.** Every source
  speaks in `STATUS_*` strings, so `determine_outcome`,
  `queue_status_for_outcome` and the summary writer keep working unchanged and
  the session-limit, cancelled and unmerged rules live in one place rather than
  once per source.

Underscores rather than the hyphens the sibling scripts use: this one is
imported. It is also **stdlib-only and 3.9-compatible**, because
`queue_source_jira.py` imports it and `usage-host.py` imports *that* for the
credential probe — and Chrome spawns the host with an environment we do not
control.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:  # Protocol landed in 3.8; the fallback is only for a truly ancient host.
    from typing import Protocol
except ImportError:  # pragma: no cover - not reachable on any supported Python
    Protocol = object  # type: ignore[assignment]

STATUS_TODO = "todo"
STATUS_COMPLETED = "completed"
STATUS_ERROR = "error"
# A prompt still being written, so not ready to run. Skipped without any special
# casing — `find_next_todo` picks up `todo` and nothing else — and named here
# only so the queue's vocabulary is stated in one place.
STATUS_DRAFT = "draft"
# Work that finished but is sitting on a branch rather than in main, because the
# run had a question it could not answer for itself. Always carries the branch
# name after a colon — `unmerged:add-widget` — since a status that did not say
# where the work went would be worse than no status at all. Skipped by
# `find_next_todo` like any status that is not `todo`.
STATUS_UNMERGED = "unmerged"
# Separates a status from its detail, so far only `unmerged`'s branch name.
STATUS_DETAIL_SEPARATOR = ":"

SECTION_SEPARATOR_PREFIX = "==="
STATUS_FIELD_PREFIX = "STATUS:"
REPOSITORY_FIELD_PREFIX = "REPO:"


class QueueUnavailable(Exception):
    """The queue could not be read at all — a missing file, a dead credential, no network.

    Deliberately distinct from "the queue is empty". An empty queue means there
    is nothing to do; an unavailable one means we do not know, and the only safe
    response is to run nothing and say why. Never fall back to another source on
    this: a stale queue would happily execute a prompt deleted days ago, which is
    the one failure that costs work rather than time.
    """


def status_name_of(status: str) -> str:
    """The status word on its own — `unmerged` out of `unmerged:add-widget`."""
    return status.partition(STATUS_DETAIL_SEPARATOR)[0]


def status_detail_of(status: str) -> str:
    """Whatever follows the colon, or "" — the branch name, for `unmerged:`."""
    return status.partition(STATUS_DETAIL_SEPARATOR)[2]


def normalise_status(status_text: str) -> str:
    """A STATUS field's value, lowercased — but with any `:detail` left as written.

    `unmerged:Add-Widget` names a git branch, and branch names are
    case-sensitive, so only the word before the colon can be folded. A colon
    with nothing after it is dropped rather than kept, so `unmerged:` reads as
    the plain status it looks like rather than as one with an empty branch.
    """
    status_name, separator, detail = status_text.partition(STATUS_DETAIL_SEPARATOR)
    status_name = status_name.strip().lower()
    detail = detail.strip()
    if not separator or not detail:
        return status_name
    return "{}{}{}".format(status_name, STATUS_DETAIL_SEPARATOR, detail)


def unmerged_status(branch_name: str) -> str:
    return "{}{}{}".format(STATUS_UNMERGED, STATUS_DETAIL_SEPARATOR, branch_name)


@dataclass(frozen=True)
class QueueEntry:
    # The status as `normalise_status` leaves it, so it may carry a `:detail`.
    # Compare against `status_name`, never against the raw string.
    status: str
    """Whatever the source needs to find this entry again — and nothing the
    scheduler may look inside. A line index for the file source, an issue key
    for Jira. Opaque on purpose: the moment anything outside a `QueueSource`
    interprets it, the seam has leaked."""
    handle: object
    """The REPO: line as a path, or None to start a new project — see `resolve_working_directory`."""
    repository_path: "Path | None"
    prompt: str
    # A model *name* — "opus" / "sonnet" / "haiku", the vocabulary
    # `autonomous_work_settings.VALID_MODEL_NAMES` holds — or None to run this
    # entry on the session's configured model. Only the Jira source ever sets it
    # (from a card's `Model` dropdown); the file source leaves it None. Named
    # `model_name`, not `model`, because the scheduler maps it to a concrete
    # model id (`claude-opus-5`) before it reaches `claude --model`.
    model_name: "str | None" = None

    @property
    def status_name(self) -> str:
        """The status word on its own — `unmerged` out of `unmerged:add-widget`."""
        return status_name_of(self.status)


class QueueSource(Protocol):
    """What the scheduler needs of a queue, and nothing more.

    `start` is the only method the file source does not want: a file has no
    "running" state, and the existing design deliberately leaves a STATUS line
    alone until the outcome is known. On a board it is the move into the
    In Progress column.
    """

    def next_todo(self) -> "QueueEntry | None":
        """The entry to run now, or None if there is nothing queued.

        Raises `QueueUnavailable` if the queue could not be read — which is a
        different answer from None and must never be treated as "empty".
        """

    def start(self, entry: QueueEntry) -> None:
        """Mark the entry as being worked on, where the source has such a state."""

    def record_outcome(self, entry: QueueEntry, status: str, report: object = None) -> str:
        """Write the finished status, returning the status the entry is left holding.

        Not always the one asked for: a run that marked itself
        `unmerged:<branch>` keeps that.

        `report` is Claude's own account of the prompt — turns, cost, closing
        message. Not part of the minimum a queue has to be, since a STATUS line
        has nowhere to put it and the file source ignores it; a board's whole
        payoff is that each card explains itself, so the Jira source spends it on
        a comment. One object rather than five arguments, so the file source can
        keep ignoring it as more is added.
        """

    def abandon(self, entry: QueueEntry) -> None:
        """Undo `start` — the entry was picked up but never really ran.

        Not a status change: a cancelled prompt and one a subscription limit
        refused are the two outcomes that leave a queue entry exactly as it was,
        so this returns it to where `start` found it and writes nothing else.
        """

    def remaining_todo_prompts(self, already_attempted: "list[str]") -> "list[str]":
        """Prompts still queued, in pick-up order, minus the ones already tried."""

    def holds_a_todo(self) -> bool:
        """Is there anything to come back for?"""

    def sweep_stale(self) -> None:
        """Return anything stranded mid-run by a hard kill to the queue."""

    def drain_pending_writes(self) -> int:
        """Replay outcomes an earlier run finished but could not record.

        Returns how many landed. Zero for a source whose write is a local,
        atomic file swap — there is nothing that can be owed.
        """

    def describe(self) -> str:
        """One phrase naming this queue, for the log and the run event."""


# --------------------------------------------------------------------------- #
# The file source
# --------------------------------------------------------------------------- #


def _parse_section(first_line_index: int, section_lines: "list[str]") -> "QueueEntry | None":
    status = None  # type: str | None
    status_line_index = -1
    repository_text = None  # type: str | None
    prompt_lines = []  # type: list[str]

    for offset, line in enumerate(section_lines):
        stripped_line = line.strip()

        if status is None:
            if not stripped_line:
                continue
            if not stripped_line.startswith(STATUS_FIELD_PREFIX):
                return None  # A section without a STATUS header is not a work item.
            status = normalise_status(stripped_line[len(STATUS_FIELD_PREFIX) :])
            status_line_index = first_line_index + offset
            continue

        # REPO is only a header while it precedes the prompt body.
        if (
            repository_text is None
            and not prompt_lines
            and stripped_line.startswith(REPOSITORY_FIELD_PREFIX)
        ):
            repository_text = stripped_line[len(REPOSITORY_FIELD_PREFIX) :].strip()
            continue

        prompt_lines.append(line)

    if status is None:
        return None

    prompt = "\n".join(prompt_lines).strip()
    repository_path = Path(os.path.expanduser(repository_text)) if repository_text else None

    return QueueEntry(
        status=status,
        handle=status_line_index,
        repository_path=repository_path,
        prompt=prompt,
    )


def parse_queue(lines: "list[str]") -> "list[QueueEntry]":
    """Split the queue into entries, remembering where each STATUS line lives."""
    entries = []  # type: list[QueueEntry]
    section_start_index = 0
    section_lines = []  # type: list[str]

    def flush_section() -> None:
        if not section_lines:
            return
        entry = _parse_section(section_start_index, section_lines)
        if entry is not None:
            entries.append(entry)

    for line_index, line in enumerate(lines):
        if line.startswith(SECTION_SEPARATOR_PREFIX):
            flush_section()
            section_lines = []
            section_start_index = line_index + 1
        else:
            section_lines.append(line)

    flush_section()
    return entries


def find_next_todo(entries: "list[QueueEntry]") -> "QueueEntry | None":
    for entry in entries:
        if entry.status_name == STATUS_TODO and entry.prompt:
            return entry
    return None


def status_on_line(lines: "list[str]", status_line_index: int) -> "str | None":
    """The status that line holds, or None if it is not a STATUS line at all.

    Checking the line still *is* a STATUS field, rather than only that the index
    is in range, is what keeps a queue edited during the run from having a line
    of its prompt overwritten: a run that adds or removes lines above its own
    entry shifts every index taken before it started.
    """
    if not 0 <= status_line_index < len(lines):
        return None
    stripped_line = lines[status_line_index].strip()
    if not stripped_line.startswith(STATUS_FIELD_PREFIX):
        return None
    return normalise_status(stripped_line[len(STATUS_FIELD_PREFIX) :])


def rewrite_status_line(
    lines: "list[str]", status_line_index: int, new_status: str
) -> "list[str] | None":
    """The queue lines with one STATUS line replaced, or None if the index no longer lines up.

    Pure line-rewriting, split out from the file I/O around it. Targeting the
    line by index rather than by string replacement keeps the update correct
    even when a prompt body happens to contain the word STATUS.
    """
    if status_on_line(lines, status_line_index) is None:
        return None
    updated_lines = list(lines)
    updated_lines[status_line_index] = "{} {}".format(STATUS_FIELD_PREFIX, new_status)
    return updated_lines


def _ignore(message: str) -> None:
    pass


class FileQueueSource:
    """`prompts.txt` — today's behaviour, moved rather than changed.

    Still the default for a fresh clone, and still what works with no account,
    no network and no third party. `status_on_line` and `rewrite_status_line`
    live in this module rather than in the scheduler because they are
    file-shaped concerns that never meant anything to the rest of it.
    """

    def __init__(self, queue_file: Path, log=_ignore) -> None:
        self.queue_file = queue_file
        self._log = log

    def describe(self) -> str:
        return str(self.queue_file)

    def read_lines(self) -> "list[str]":
        """The queue file's lines, or `QueueUnavailable` if it cannot be read."""
        if not self.queue_file.exists():
            raise QueueUnavailable("No prompt queue at {}".format(self.queue_file))
        try:
            return self.queue_file.read_text(encoding="utf-8").split("\n")
        except OSError as error:
            raise QueueUnavailable("Could not read prompt queue: {}".format(error))

    def entries(self) -> "list[QueueEntry]":
        return parse_queue(self.read_lines())

    def next_todo(self) -> "QueueEntry | None":
        return find_next_todo(self.entries())

    def start(self, entry: QueueEntry) -> None:
        """Nothing. A file has no "running" column, and inventing one would mean
        rewriting the STATUS line twice per prompt — doubling the window in which
        a crash leaves a status nobody wrote deliberately."""

    def abandon(self, entry: QueueEntry) -> None:
        """Nothing, for the same reason `start` does nothing."""

    def sweep_stale(self) -> None:
        """Nothing, for the same reason `start` does nothing: there is no
        In Progress state to be stranded in."""

    def drain_pending_writes(self) -> int:
        """Nothing is ever owed: the write is a local, atomic file swap."""
        return 0

    def remaining_todo_prompts(self, already_attempted: "list[str]") -> "list[str]":
        try:
            entries = self.entries()
        except QueueUnavailable:
            return []
        return [
            entry.prompt
            for entry in entries
            if entry.status_name == STATUS_TODO
            and entry.prompt
            and entry.prompt not in already_attempted
        ]

    def holds_a_todo(self) -> bool:
        try:
            return self.next_todo() is not None
        except QueueUnavailable:
            return False

    def record_outcome(self, entry: QueueEntry, status: str, report: object = None) -> str:
        """Rewrite one STATUS line, replacing the file atomically.

        `report` is ignored: a STATUS line is one field, and it is already spoken
        for. Claude's account of the prompt goes into the day's summary instead.

        The temp-file swap means a queue edited mid-run is never left truncated.

        An `unmerged:<branch>` already on the line wins over anything this run
        would write. Only the run itself can have put it there — it is the one
        party that knows it left work on a branch — and overwriting it with
        `completed` would throw away the branch name, the single thing that
        status exists to carry.
        """
        status_line_index = entry.handle
        if not isinstance(status_line_index, int):
            return status

        try:
            lines = self.read_lines()
        except QueueUnavailable as error:
            self._log(str(error))
            return status

        status_already_there = status_on_line(lines, status_line_index)
        if (
            status_already_there is not None
            and status_name_of(status_already_there) == STATUS_UNMERGED
        ):
            self._log(
                "Queue entry already marked '{}' by the run itself".format(status_already_there)
            )
            return status_already_there

        updated_lines = rewrite_status_line(lines, status_line_index, status)
        if updated_lines is None:
            self._log("Queue changed while running; not updating status to {}".format(status))
            return status

        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=str(self.queue_file.parent), delete=False
            ) as temp_handle:
                temp_handle.write("\n".join(updated_lines))
                temporary_path = Path(temp_handle.name)
            os.replace(str(temporary_path), str(self.queue_file))
            self._log("Queue entry marked '{}'".format(status))
        except OSError as error:
            self._log("Could not update prompt queue: {}".format(error))
        return status
