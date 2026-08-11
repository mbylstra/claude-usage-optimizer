#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Run the next queued Claude Code prompt, but only when weekly usage is behind pace.

Reads the pace snapshot the Chrome extension exports to the download directory,
compares it against a threshold, and — if we are far enough behind an even burn —
executes the first `STATUS: todo` section of the prompt queue via `claude -p`.

Every exit path that is not "a prompt ran" returns 0, because launchd treating a
deliberate no-op as a failure is just noise in the system log.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIRECTORY.parent

# Sibling module, importable because Python puts this script's directory on
# sys.path. It owns the settings the Chrome extension mirrors to disk.
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import autonomous_work_settings  # noqa: E402  (must follow the sys.path line above)

MILLISECONDS_PER_HOUR = 3_600_000

STATUS_TODO = "todo"
STATUS_COMPLETED = "completed"
STATUS_ERROR = "error"

SECTION_SEPARATOR_PREFIX = "==="
STATUS_FIELD_PREFIX = "STATUS:"
REPOSITORY_FIELD_PREFIX = "REPO:"


def environment_path(name: str, default: Path) -> Path:
    """Read a path from the environment, expanding `~`, falling back to `default`."""
    raw_value = os.environ.get(name)
    return Path(os.path.expanduser(raw_value)) if raw_value else default


def environment_int(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if not raw_value:
        return default
    try:
        return int(raw_value)
    except ValueError:
        return default


# All tunable without rebuilding the extension or editing this file.
# Written by the native-messaging host (`usage-host.py`), not by a download.
USAGE_SNAPSHOT_FILE = environment_path(
    "AUTONOMOUS_WORK_USAGE_FILE", SCRIPT_DIRECTORY / "claude-usage.json"
)
# At the repository root rather than beside this script: the queue is the one
# file in the whole setup a user is expected to edit regularly.
QUEUE_FILE = environment_path("AUTONOMOUS_WORK_QUEUE_FILE", PROJECT_ROOT / "prompts.txt")
LOG_FILE = environment_path("AUTONOMOUS_WORK_LOG_FILE", SCRIPT_DIRECTORY / "autonomous-work.log")
# Every raw stream-json event, kept beside the readable log for when a summary
# line is not enough to work out what happened.
RAW_EVENT_FILE = environment_path(
    "AUTONOMOUS_WORK_EVENT_FILE", SCRIPT_DIRECTORY / "autonomous-work.jsonl"
)
# Where a prompt with no REPO: line starts a *new* repository. Set in the
# extension's settings screen, which mirrors it to disk through the native host;
# the environment variable still wins, for a one-off run.
NEW_PROJECTS_DIRECTORY = environment_path(
    "AUTONOMOUS_WORK_NEW_PROJECTS_DIR", autonomous_work_settings.read_settings().new_projects_path
)
# Negative milliseconds: how far behind an even weekly burn we must be to act.
PACE_THRESHOLD_MS = environment_int("AUTONOMOUS_WORK_PACE_THRESHOLD_MS", -2 * MILLISECONDS_PER_HOUR)
# A wedged unattended session must not run until morning.
CLAUDE_TIMEOUT_SECONDS = environment_int("AUTONOMOUS_WORK_TIMEOUT_SECONDS", 3600)
# Pinned because an unpinned `claude` inherits `model` from ~/.claude/settings.json,
# which is tuned for interactive use and has already silently switched a nightly
# run to Haiku. The whole point is to spend the weekly window, so the model this
# job runs on should not be a side effect of an unrelated interactive preference.
# Only the main thread is pinned — a subagent that names its own model keeps it.
CLAUDE_MODEL = os.environ.get("AUTONOMOUS_WORK_MODEL") or "claude-opus-5"

# Deliberately *not* `--bare`, which would authenticate with ANTHROPIC_API_KEY
# instead of the subscription session — spending the wrong budget defeats the
# whole point. A plain run keeps subscription auth and its CLAUDE.md context.
# `stream-json` (which requires `--verbose`) emits an event per step, so the log
# can be followed live. Plain `json` would withhold everything until the end.
CLAUDE_BASE_ARGUMENTS = [
    "--model",
    CLAUDE_MODEL,
    "--permission-mode",
    "auto",
    "--output-format",
    "stream-json",
    "--verbose",
]


def log_message(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"{timestamp}: {message}"
    print(line, flush=True)
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as log_handle:
            log_handle.write(line + "\n")
    except OSError as error:
        print(f"{timestamp}: (could not write to {LOG_FILE}: {error})", flush=True)


# --------------------------------------------------------------------------- #
# Pace snapshot
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PaceSnapshot:
    weekly_pace_delta_ms: float
    weekly_pace_status: str | None
    """How old the figures are. Reported, never enforced — see `read_pace_snapshot`."""
    age_seconds: float | None


def snapshot_age_seconds(fetched_at_value: object) -> float | None:
    """How long ago the snapshot was taken, or None if it does not say."""
    if not isinstance(fetched_at_value, str):
        return None
    try:
        fetched_at = datetime.fromisoformat(fetched_at_value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - fetched_at).total_seconds()


def describe_age(age_seconds: float | None) -> str:
    if age_seconds is None:
        return "age unknown"
    if age_seconds < 90 * 60:
        return f"{age_seconds / 60:.0f} min old"
    if age_seconds < 48 * 3600:
        return f"{age_seconds / 3600:.1f}h old"
    return f"{age_seconds / 86_400:.1f} days old"


def read_pace_snapshot() -> PaceSnapshot | None:
    """Load the extension's export, or None if it is absent, unreadable or has no pace.

    The newest snapshot is used however old it is. There is no freshness gate,
    because the extension can only refresh while Chrome is running: gating on age
    would mean the nightly job almost never fires on a machine whose browser is
    closed at 2 AM. The age is logged so a run against week-old figures is at
    least visible in the log.
    """
    if not USAGE_SNAPSHOT_FILE.exists():
        log_message(f"No usage snapshot at {USAGE_SNAPSHOT_FILE} — is the extension running?")
        return None

    try:
        snapshot_data = json.loads(USAGE_SNAPSHOT_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        log_message(f"Could not read usage snapshot: {error}")
        return None

    if not isinstance(snapshot_data, dict):
        log_message("Usage snapshot is not a JSON object")
        return None

    # An unreadable timestamp costs us a log line, not the run.
    age_seconds = snapshot_age_seconds(snapshot_data.get("fetchedAt"))

    pace_delta = snapshot_data.get("weeklyPaceDeltaMs")
    if not isinstance(pace_delta, (int, float)):
        # Null is the honest answer when the weekly window is not currently
        # running; acting on a guess of zero would be worse than doing nothing.
        log_message("Usage snapshot has no weekly pace delta (weekly window inactive) — skipping")
        return None

    weekly_pace_status = snapshot_data.get("weeklyPaceStatus")
    return PaceSnapshot(
        weekly_pace_delta_ms=float(pace_delta),
        weekly_pace_status=weekly_pace_status if isinstance(weekly_pace_status, str) else None,
        age_seconds=age_seconds,
    )


def describe_pace(pace_delta_ms: float) -> str:
    hours = abs(pace_delta_ms) / MILLISECONDS_PER_HOUR
    direction = "behind" if pace_delta_ms < 0 else "ahead of"
    return f"{hours:.1f}h {direction} an even weekly burn"


# --------------------------------------------------------------------------- #
# Prompt queue
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class QueueEntry:
    status: str
    """Index into the file's line list, so the status can be rewritten in place."""
    status_line_index: int
    """The REPO: line as a path, or None to start a new project — see `resolve_working_directory`."""
    repository_path: Path | None
    prompt: str


def _parse_section(first_line_index: int, section_lines: list[str]) -> QueueEntry | None:
    status: str | None = None
    status_line_index = -1
    repository_text: str | None = None
    prompt_lines: list[str] = []

    for offset, line in enumerate(section_lines):
        stripped_line = line.strip()

        if status is None:
            if not stripped_line:
                continue
            if not stripped_line.startswith(STATUS_FIELD_PREFIX):
                return None  # A section without a STATUS header is not a work item.
            status = stripped_line[len(STATUS_FIELD_PREFIX) :].strip().lower()
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
        status_line_index=status_line_index,
        repository_path=repository_path,
        prompt=prompt,
    )


def parse_queue(lines: list[str]) -> list[QueueEntry]:
    """Split the queue into entries, remembering where each STATUS line lives."""
    entries: list[QueueEntry] = []
    section_start_index = 0
    section_lines: list[str] = []

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


def read_queue_lines() -> list[str] | None:
    if not QUEUE_FILE.exists():
        log_message(f"No prompt queue at {QUEUE_FILE}")
        return None
    try:
        return QUEUE_FILE.read_text(encoding="utf-8").split("\n")
    except OSError as error:
        log_message(f"Could not read prompt queue: {error}")
        return None


def find_next_todo(entries: list[QueueEntry]) -> QueueEntry | None:
    for entry in entries:
        if entry.status == STATUS_TODO and entry.prompt:
            return entry
    return None


def write_queue_status(status_line_index: int, new_status: str) -> None:
    """Rewrite one STATUS line, replacing the file atomically.

    Targeting the line by index rather than by string replacement keeps the
    update correct even when a prompt body happens to contain the word STATUS,
    and the temp-file swap means a queue edited mid-run is never left truncated.
    """
    lines = read_queue_lines()
    if lines is None:
        return
    if not 0 <= status_line_index < len(lines):
        log_message(f"Queue changed while running; not updating status to {new_status}")
        return

    lines[status_line_index] = f"{STATUS_FIELD_PREFIX} {new_status}"

    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=QUEUE_FILE.parent, delete=False
        ) as temp_handle:
            temp_handle.write("\n".join(lines))
            temporary_path = Path(temp_handle.name)
        os.replace(temporary_path, QUEUE_FILE)
        log_message(f"Queue entry marked '{new_status}'")
    except OSError as error:
        log_message(f"Could not update prompt queue: {error}")


# --------------------------------------------------------------------------- #
# Execution
# --------------------------------------------------------------------------- #


def shorten(text: str, limit: int = 160) -> str:
    """One line, bounded — the log is meant to be followed, not waded through."""
    collapsed = " ".join(text.split())
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1] + "…"


def describe_tool_input(tool_name: str, tool_input: object) -> str:
    """The one field that says what a tool call is actually doing."""
    if not isinstance(tool_input, dict):
        return ""

    for interesting_field in ("command", "file_path", "pattern", "path", "url", "description"):
        value = tool_input.get(interesting_field)
        if isinstance(value, str) and value:
            return value

    return ", ".join(sorted(tool_input)[:3])


def summarise_stream_event(event: dict) -> list[str]:
    """Human-readable lines for one stream-json event; empty to stay quiet."""
    event_type = event.get("type")

    if event_type == "system" and event.get("subtype") == "init":
        session_id = str(event.get("session_id") or "")[:8]
        return [f"claude started (model {event.get('model')}, session {session_id})"]

    if event_type == "assistant":
        lines = []
        content = event.get("message", {}).get("content", [])
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = str(block.get("text", "")).strip()
                if text:
                    lines.append(f"  claude: {shorten(text)}")
            elif block.get("type") == "tool_use":
                tool_name = str(block.get("name", "?"))
                detail = describe_tool_input(tool_name, block.get("input"))
                lines.append(f"  → {tool_name}({shorten(detail, 120)})")
        return lines

    if event_type == "result":
        duration_seconds = float(event.get("duration_ms") or 0) / 1000
        cost = event.get("total_cost_usd")
        cost_text = f", ${cost:.2f}" if isinstance(cost, (int, float)) else ""
        outcome = "error" if event.get("is_error") else str(event.get("subtype", "done"))
        return [
            f"claude finished: {outcome} "
            f"({event.get('num_turns')} turns, {duration_seconds:.0f}s{cost_text})"
        ]

    return []


def slugify_prompt(prompt: str, word_limit: int = 6) -> str:
    """A few words from the prompt, safe as a directory name.

    The directory is the only lasting trace of which queue entry produced a
    project, so it is named after the prompt rather than given a bare timestamp —
    `~/code` stays readable months later.
    """
    words = re.findall(r"[a-z0-9]+", prompt.lower())
    slug = "-".join(words[:word_limit])
    return slug or "prompt"


def resolve_working_directory(entry: QueueEntry) -> tuple[Path, bool]:
    """Where this entry runs, and whether that is a project we are about to create.

    An entry with a REPO: line runs there. Without one it gets a brand-new
    repository under the configured new-projects directory, because a queue of
    unrelated "build me an X" prompts sharing one working copy just makes each
    run contend with the leftovers of the last.
    """
    if entry.repository_path is not None:
        return entry.repository_path, False

    dated_name = f"{datetime.now().strftime('%Y-%m-%d')}-{slugify_prompt(entry.prompt)}"

    # Two prompts on one night, or a re-queued entry, must not land on top of an
    # existing project.
    candidate = NEW_PROJECTS_DIRECTORY / dated_name
    suffix_number = 2
    while candidate.exists():
        candidate = NEW_PROJECTS_DIRECTORY / f"{dated_name}-{suffix_number}"
        suffix_number += 1

    return candidate, True


def prepare_working_directory(working_directory: Path, is_new_project: bool) -> bool:
    """Create the directory, and initialise a repository when it is a new project."""
    try:
        working_directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        log_message(f"Could not prepare working directory {working_directory}: {error}")
        return False

    if not is_new_project:
        return True

    try:
        git_result = subprocess.run(
            ["git", "init", "--quiet"],
            cwd=working_directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except OSError as error:
        # Worth the run anyway: an uninitialised directory still gets the work
        # done, and the user can `git init` afterwards.
        log_message(f"Could not run git init in {working_directory}: {error}")
        return True

    if git_result.returncode != 0:
        log_message(f"git init failed: {git_result.stdout.decode().strip()}")
    return True


def run_claude(entry: QueueEntry, working_directory: Path, is_new_project: bool) -> int:
    if not prepare_working_directory(working_directory, is_new_project):
        return 1

    log_message(
        f"Running queued prompt in {working_directory}"
        + (" (new project)" if is_new_project else "")
    )

    try:
        # Streamed rather than captured, so `just autonomous-log` shows progress
        # as it happens. `--output-format json` emits a single blob only once the
        # run is over, which is useless to follow; `stream-json` emits an event
        # per step. stderr is merged in so nothing is lost or deadlocks on a
        # second unread pipe.
        process = subprocess.Popen(
            ["claude", "-p", entry.prompt, *CLAUDE_BASE_ARGUMENTS],
            cwd=working_directory,
            # Without this `claude` spends three seconds waiting on an inherited
            # stdin that is never going to produce anything, and warns about it.
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        log_message("`claude` not found on PATH — check the launchd PATH setting")
        return 1

    # A wedged session must not run until morning, and `Popen` has no timeout of
    # its own once we are reading its output line by line.
    timed_out = False

    def stop_for_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        process.kill()

    watchdog = threading.Timer(CLAUDE_TIMEOUT_SECONDS, stop_for_timeout)
    watchdog.daemon = True
    watchdog.start()

    try:
        with RAW_EVENT_FILE.open("a", encoding="utf-8") as raw_handle:
            for line in process.stdout or []:
                raw_handle.write(line)
                raw_handle.flush()

                stripped_line = line.strip()
                if not stripped_line:
                    continue

                try:
                    event = json.loads(stripped_line)
                except json.JSONDecodeError:
                    log_message(f"  {shorten(stripped_line)}")  # plain stderr text
                    continue

                if isinstance(event, dict):
                    for summary in summarise_stream_event(event):
                        log_message(summary)

        exit_code = process.wait()
    finally:
        watchdog.cancel()

    if timed_out:
        log_message(f"Prompt timed out after {CLAUDE_TIMEOUT_SECONDS}s and was killed")
        return 1

    log_message(f"Prompt finished with exit code {exit_code}")
    return exit_code


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument(
        "--force",
        action="store_true",
        help="Run the next queued prompt regardless of pace.",
    )
    argument_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would run without invoking claude or touching the queue.",
    )
    arguments = argument_parser.parse_args()

    if arguments.force:
        log_message("Pace gate bypassed (--force)")
    else:
        pace_snapshot = read_pace_snapshot()
        if pace_snapshot is None:
            return 0

        snapshot_description = (
            f"{describe_pace(pace_snapshot.weekly_pace_delta_ms)} "
            f"(snapshot {describe_age(pace_snapshot.age_seconds)})"
        )

        if pace_snapshot.weekly_pace_delta_ms > PACE_THRESHOLD_MS:
            log_message(
                f"On pace — {snapshot_description}, "
                f"threshold is {describe_pace(PACE_THRESHOLD_MS)}"
            )
            return 0

        log_message(f"Behind pace — {snapshot_description}")

    queue_lines = read_queue_lines()
    if queue_lines is None:
        return 0

    next_entry = find_next_todo(parse_queue(queue_lines))
    if next_entry is None:
        log_message("No todo prompts in queue (all completed, errored or empty)")
        return 0

    working_directory, is_new_project = resolve_working_directory(next_entry)

    if arguments.dry_run:
        destination = f"{working_directory}{' (new project)' if is_new_project else ''}"
        log_message(f"Dry run — would execute in {destination}:\n{next_entry.prompt}")
        return 0

    exit_code = run_claude(next_entry, working_directory, is_new_project)
    write_queue_status(
        next_entry.status_line_index,
        STATUS_COMPLETED if exit_code == 0 else STATUS_ERROR,
    )
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
