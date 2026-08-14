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
import signal
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

# Printed by the Claude Code CLI itself (not this repo) when a turn is still
# waiting on a background task past CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS. The
# CLI kills the task and ends the turn right there, but the process still
# exits 0 — see findings/song-ratings-vinyl-prompt-stall.md. Matched as a
# substring so a differently-configured ceiling value doesn't break the check.
BACKGROUND_TASK_TIMEOUT_MARKER = "Background tasks still running after"


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


def environment_int_override(name: str) -> int | None:
    """Like `environment_int`, but with no static default — the caller computes one."""
    raw_value = os.environ.get(name)
    if not raw_value:
        return None
    try:
        return int(raw_value)
    except ValueError:
        return None


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
# The structured, run-scoped stream the extension's live view consumes. Neither
# of the two files above will do: the `.log` is prose meant for humans, and
# scraping our own formatting back into structure would break on every wording
# change; the `.jsonl` has no run boundaries and no record of which prompt, repo
# or working directory a run used.
RUN_EVENT_FILE = environment_path(
    "AUTONOMOUS_WORK_RUN_EVENT_FILE", SCRIPT_DIRECTORY / "autonomous-run-events.jsonl"
)
# How many runs the file keeps. Trimmed on each start rather than by a separate
# rotation job, since a run start is the only moment the boundaries are known to
# be complete.
RUN_EVENT_HISTORY_LIMIT = environment_int("AUTONOMOUS_WORK_RUN_EVENT_HISTORY", 5)
# Where a prompt with no REPO: line starts a *new* repository. Set in the
# extension's settings screen, which mirrors it to disk through the native host;
# the environment variable still wins, for a one-off run.
NEW_PROJECTS_DIRECTORY = environment_path(
    "AUTONOMOUS_WORK_NEW_PROJECTS_DIR", autonomous_work_settings.read_settings().new_projects_path
)
# Signed milliseconds: how far ahead of (positive) or behind (negative) an
# even weekly burn still counts as on pace. Set in the extension's settings
# screen in hours, mirrored to disk through the native host and converted to
# milliseconds here; the environment variable still wins, for a one-off run —
# same precedence as NEW_PROJECTS_DIRECTORY above.
PACE_THRESHOLD_MS = environment_int_override("AUTONOMOUS_WORK_PACE_THRESHOLD_MS")
if PACE_THRESHOLD_MS is None:
    PACE_THRESHOLD_MS = round(
        autonomous_work_settings.read_settings().pace_threshold_hours * MILLISECONDS_PER_HOUR
    )
# The scheduler works through the queue while behind weekly pace, but a
# five-hour session window does not refill early — once it reports at or above
# this percentage, waiting it out would mean sitting idle for up to five hours,
# so the run ends instead.
FIVE_HOUR_EXHAUSTED_PERCENT = environment_int("AUTONOMOUS_WORK_FIVE_HOUR_EXHAUSTED_PERCENT", 100)
# The environment variable wins first, then the settings (set by the extension
# in hours), then the default — same precedence as the model, just below.
_settings = autonomous_work_settings.read_settings()
# A single wedged `claude` call must not run until morning — this bounds one
# prompt's invocation, not the nightly session, which can run many prompts in a
# row and is bounded separately above, by pace and the usage window. There is no
# way to tell a stuck prompt from a slow one, so this is a flat ceiling on
# wall-clock time, not an inactivity timeout.
CLAUDE_MAX_PROMPT_DURATION_SECONDS = environment_int_override(
    "AUTONOMOUS_WORK_MAX_PROMPT_DURATION_SECONDS"
) or int(_settings.max_prompt_duration_hours * 3600)
# Pinned because an unpinned `claude` inherits `model` from ~/.claude/settings.json,
# which is tuned for interactive use and has already silently switched a nightly
# run to Haiku. The whole point is to spend the weekly window, so the model this
# job runs on should not be a side effect of an unrelated interactive preference.
# Only the main thread is pinned — a subagent that names its own model keeps it.
_model_name = os.environ.get("AUTONOMOUS_WORK_MODEL") or _settings.model
# Tacked onto every queued prompt before it reaches `claude -p` — see
# `build_prompt`. Naming and logging of the *queue entry* still use its own
# prompt unappended; only the invocation sees this.
APPEND_TO_ALL_PROMPTS = _settings.append_to_all_prompts
_MODEL_ID_MAP = {
    "haiku": "claude-haiku-4-5-20251001",
    "sonnet": "claude-sonnet-5",
    "opus": "claude-opus-5",
}
CLAUDE_MODEL = _MODEL_ID_MAP.get(_model_name, _MODEL_ID_MAP["opus"])

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
    "--chrome",
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
# Run event stream
# --------------------------------------------------------------------------- #

# A run boundary. Both start a run's worth of events: one for work that ran, one
# for a night where the gate declined to.
RUN_BOUNDARY_EVENT_TYPES = ("runStarted", "runSkipped")


def utc_now_iso() -> str:
    """An unambiguous instant. The viewer renders it in the reader's timezone."""
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run_event_boundary_indices(lines: list[str]) -> list[int]:
    """Where each run begins in the event file. Unreadable lines are not boundaries."""
    indices = []
    for line_index, line in enumerate(lines):
        stripped_line = line.strip()
        if not stripped_line:
            continue
        try:
            event = json.loads(stripped_line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get("type") in RUN_BOUNDARY_EVENT_TYPES:
            indices.append(line_index)
    return indices


class RunEventStream:
    """The run's own structured record, for the extension's live view.

    Every write is best-effort: this file exists so a window can watch the run,
    and losing that is never worth losing the run itself.
    """

    def __init__(self, run_id: str, enabled: bool = True) -> None:
        self.run_id = run_id
        self.enabled = enabled
        self._has_reported_failure = False
        if enabled:
            self._trim_to_recent_runs(RUN_EVENT_HISTORY_LIMIT - 1)

    def _trim_to_recent_runs(self, keep_runs: int) -> None:
        """Drop all but the most recent `keep_runs` runs, before this one is added.

        Replaced rather than rewritten in place: a viewer may be tailing the file
        at this moment, and the swap gives it a clean shrink to detect instead of
        a half-written file to parse.
        """
        if keep_runs < 0 or not RUN_EVENT_FILE.exists():
            return

        try:
            lines = RUN_EVENT_FILE.read_text(encoding="utf-8").splitlines()
        except OSError as error:
            self._report_failure(error)
            return

        boundary_indices = run_event_boundary_indices(lines)
        if len(boundary_indices) <= keep_runs:
            return

        first_kept_line = boundary_indices[len(boundary_indices) - keep_runs] if keep_runs else None
        remaining_lines = [] if first_kept_line is None else lines[first_kept_line:]

        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=RUN_EVENT_FILE.parent, delete=False
            ) as temp_handle:
                for line in remaining_lines:
                    temp_handle.write(line + "\n")
                temporary_path = Path(temp_handle.name)
            os.replace(temporary_path, RUN_EVENT_FILE)
        except OSError as error:
            self._report_failure(error)

    def _report_failure(self, error: OSError) -> None:
        if self._has_reported_failure:
            return
        self._has_reported_failure = True
        log_message(f"Could not write run events to {RUN_EVENT_FILE}: {error}")

    def emit(self, event_type: str, **fields: object) -> None:
        if not self.enabled:
            return
        envelope = {"type": event_type, "runId": self.run_id, "at": utc_now_iso()}
        envelope.update(fields)

        try:
            RUN_EVENT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with RUN_EVENT_FILE.open("a", encoding="utf-8") as event_handle:
                event_handle.write(json.dumps(envelope) + "\n")
        except OSError as error:
            self._report_failure(error)

    def started(
        self,
        working_directory: Path,
        is_new_project: bool,
        prompt: str,
        forced: bool,
    ) -> None:
        self.emit(
            "runStarted",
            forced=forced,
            workingDirectory=str(working_directory),
            projectName=working_directory.name,
            isNewProject=is_new_project,
            prompt=prompt,
            model=CLAUDE_MODEL,
        )

    def claude_event(self, event: dict) -> None:
        """One stream-json event, verbatim, so the viewer sees exactly what claude said."""
        self.emit("claudeEvent", event=event)

    def claude_output(self, text: str) -> None:
        """A line claude emitted that was not JSON — merged stderr, usually."""
        self.emit("claudeOutput", text=text)

    def finished(self, outcome: str, exit_code: int, queue_status: str | None = None) -> None:
        self.emit("runFinished", outcome=outcome, exitCode=exit_code, queueStatus=queue_status)

    def skipped(self, reason: str, detail: str) -> None:
        self.emit("runSkipped", reason=reason, detail=detail)


# --------------------------------------------------------------------------- #
# Pace snapshot
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PaceSnapshot:
    weekly_pace_delta_ms: float
    weekly_pace_status: str | None
    """None when the API did not report a current session — treated as "not exhausted"."""
    five_hour_percent: float | None
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
    five_hour_percent = snapshot_data.get("fiveHourPercent")
    return PaceSnapshot(
        weekly_pace_delta_ms=float(pace_delta),
        weekly_pace_status=weekly_pace_status if isinstance(weekly_pace_status, str) else None,
        five_hour_percent=(
            float(five_hour_percent) if isinstance(five_hour_percent, (int, float)) else None
        ),
        age_seconds=age_seconds,
    )


def describe_pace(pace_delta_ms: float) -> str:
    hours = abs(pace_delta_ms) / MILLISECONDS_PER_HOUR
    direction = "behind" if pace_delta_ms < 0 else "ahead of"
    return f"{hours:.1f}h {direction} an even weekly burn"


@dataclass(frozen=True)
class GateResult:
    ok: bool
    """A stable code for the run-event stream, e.g. "onPace" or "fiveHourExhausted"."""
    reason: str | None = None
    detail: str | None = None


def evaluate_pace_gate(
    pace_snapshot: PaceSnapshot | None,
    *,
    force: bool,
    pace_threshold_ms: float,
    five_hour_exhausted_percent: float,
) -> GateResult:
    """Pure decision logic behind `check_pace_gate` — no I/O, no logging.

    Split out so the threshold arithmetic (the part most worth getting right)
    can be unit-tested against explicit snapshots and thresholds, without
    needing a real usage-snapshot file or the module's own env-configured
    constants.
    """
    if force:
        return GateResult(ok=True)

    if pace_snapshot is None:
        return GateResult(False, "noSnapshot", f"No usable pace snapshot at {USAGE_SNAPSHOT_FILE}")

    snapshot_description = (
        f"{describe_pace(pace_snapshot.weekly_pace_delta_ms)} "
        f"(snapshot {describe_age(pace_snapshot.age_seconds)})"
    )

    if pace_snapshot.weekly_pace_delta_ms > pace_threshold_ms:
        return GateResult(
            False,
            "onPace",
            f"{snapshot_description}, threshold is {describe_pace(pace_threshold_ms)}",
        )

    if (
        pace_snapshot.five_hour_percent is not None
        and pace_snapshot.five_hour_percent >= five_hour_exhausted_percent
    ):
        return GateResult(
            False,
            "fiveHourExhausted",
            f"5-hour session window at {pace_snapshot.five_hour_percent:.0f}% "
            "— ending the run rather than waiting for it to reset",
        )

    return GateResult(True, detail=snapshot_description)


def check_pace_gate(force: bool) -> GateResult:
    """Whether another queued prompt should run right now.

    Called once per prompt, not once per invocation: usage moves while the
    queue is being worked through, so a session that starts behind pace with
    room in the five-hour window can still need to stop partway — either
    because the extra runs closed the weekly gap, or because the session
    window itself filled up. The latter does not refill early, so filling it
    ends the run rather than leaving it to wait out the reset.
    """
    if force:
        log_message("Pace gate bypassed (--force)")
        return GateResult(ok=True)

    pace_snapshot = read_pace_snapshot()
    result = evaluate_pace_gate(
        pace_snapshot,
        force=False,
        pace_threshold_ms=PACE_THRESHOLD_MS,
        five_hour_exhausted_percent=FIVE_HOUR_EXHAUSTED_PERCENT,
    )

    if pace_snapshot is None:
        return result  # read_pace_snapshot() already logged why

    if result.reason == "onPace":
        log_message(f"On pace — {result.detail}")
    elif result.reason == "fiveHourExhausted":
        log_message(result.detail)
    elif result.ok:
        log_message(f"Behind pace — {result.detail}")

    return result


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


def rewrite_status_line(lines: list[str], status_line_index: int, new_status: str) -> list[str] | None:
    """The queue lines with one STATUS line replaced, or None if the index no longer lines up.

    Pure line-rewriting, split out from the file I/O around it. Targeting the
    line by index rather than by string replacement keeps the update correct
    even when a prompt body happens to contain the word STATUS.
    """
    if not 0 <= status_line_index < len(lines):
        return None
    updated_lines = list(lines)
    updated_lines[status_line_index] = f"{STATUS_FIELD_PREFIX} {new_status}"
    return updated_lines


def write_queue_status(status_line_index: int, new_status: str) -> None:
    """Rewrite one STATUS line, replacing the file atomically.

    The temp-file swap means a queue edited mid-run is never left truncated.
    """
    lines = read_queue_lines()
    if lines is None:
        return

    updated_lines = rewrite_status_line(lines, status_line_index, new_status)
    if updated_lines is None:
        log_message(f"Queue changed while running; not updating status to {new_status}")
        return

    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=QUEUE_FILE.parent, delete=False
        ) as temp_handle:
            temp_handle.write("\n".join(updated_lines))
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


def build_prompt(entry_prompt: str) -> str:
    """The text actually sent to `claude -p`: the queue entry's prompt, plus the
    user's "append to all prompts" setting if one is configured.

    Project naming (`dated_project_name`) and the queue file itself keep using
    the entry's own prompt unappended — only the invocation sees this.
    """
    if not APPEND_TO_ALL_PROMPTS.strip():
        return entry_prompt
    return f"{entry_prompt}\n\n{APPEND_TO_ALL_PROMPTS}"


def slugify_prompt(prompt: str, word_limit: int = 6) -> str:
    """A few words from the prompt, safe as a directory name.

    The directory is the only lasting trace of which queue entry produced a
    project, so it is named after the prompt rather than given a bare timestamp —
    `~/code` stays readable months later.
    """
    words = re.findall(r"[a-z0-9]+", prompt.lower())
    slug = "-".join(words[:word_limit])
    return slug or "prompt"


def dated_project_name(prompt: str, today: datetime) -> str:
    """The directory name a fresh project gets — a date plus a few words of the prompt.

    The directory is the only lasting trace of which queue entry produced a
    project, so it is named after the prompt rather than given a bare timestamp —
    `~/code` stays readable months later. `today` is a parameter rather than an
    internal `datetime.now()` call so this is testable without freezing the clock.
    """
    return f"{today.strftime('%Y-%m-%d')}-{slugify_prompt(prompt)}"


def first_available_path(base_directory: Path, dated_name: str) -> Path:
    """`dated_name` under `base_directory`, suffixed until it does not already exist.

    Two prompts on one night, or a re-queued entry, must not land on top of an
    existing project.
    """
    candidate = base_directory / dated_name
    suffix_number = 2
    while candidate.exists():
        candidate = base_directory / f"{dated_name}-{suffix_number}"
        suffix_number += 1
    return candidate


def resolve_working_directory(entry: QueueEntry) -> tuple[Path, bool]:
    """Where this entry runs, and whether that is a project we are about to create.

    An entry with a REPO: line runs there. Without one it gets a brand-new
    repository under the configured new-projects directory, because a queue of
    unrelated "build me an X" prompts sharing one working copy just makes each
    run contend with the leftovers of the last.
    """
    if entry.repository_path is not None:
        return entry.repository_path, False

    dated_name = dated_project_name(entry.prompt, datetime.now())
    return first_available_path(NEW_PROJECTS_DIRECTORY, dated_name), True


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


def determine_outcome(exit_code: int, ran_too_long: bool, background_task_timed_out: bool) -> tuple[int, str]:
    """The exit code alone is not trustworthy — decide what actually happened.

    Two things can make the process exit 0 without the prompt having finished:
    the CLI's own background-task wait ceiling (BACKGROUND_TASK_TIMEOUT_MARKER)
    and this script's own max-duration watchdog. Split out from `run_claude` so
    the decision can be unit-tested against the four exit_code/ran_too_long/
    background_task_timed_out combinations without spawning a real subprocess.
    """
    if ran_too_long:
        return 1, "timeout"
    if exit_code == 0 and background_task_timed_out:
        return exit_code, "error"
    return exit_code, ("completed" if exit_code == 0 else "error")


def queue_status_for_outcome(outcome: str) -> str:
    """The queue's STATUS value for a run's outcome.

    Keyed off `outcome`, never off the exit code directly: `determine_outcome`
    can report "error" for an exit code of 0 (a background task that timed
    out, or a watchdog kill), and a queue status derived from the exit code
    alone would silently undo that — see findings/song-ratings-vinyl-prompt-stall.md.
    """
    return STATUS_COMPLETED if outcome == "completed" else STATUS_ERROR


def run_claude(
    entry: QueueEntry,
    working_directory: Path,
    is_new_project: bool,
    events: RunEventStream,
    forced: bool,
) -> tuple[int, str]:
    """Execute one queued prompt. Returns its exit code and the outcome to record."""
    prompt_text = build_prompt(entry.prompt)
    events.started(working_directory, is_new_project, prompt_text, forced)

    if not prepare_working_directory(working_directory, is_new_project):
        return 1, "error"

    log_message(
        f"Running queued prompt in {working_directory}"
        + (" (new project)" if is_new_project else "")
    )

    # Cancellation arrives here as a SIGTERM from `cancel-autonomous-work.py`,
    # which signals this process first and `claude` second. This is the only
    # chance to record that the run ended, and `os._exit` guarantees we do not
    # fall through to marking the queue entry as an error — a deliberate cancel
    # must leave the entry as todo, ready to be picked up again.
    def record_cancellation(signal_number: int, _frame: object) -> None:
        events.finished("cancelled", -signal_number)
        log_message("Cancelled (SIGTERM) — the queue entry is left as todo")
        os._exit(143)

    previous_termination_handler = signal.signal(signal.SIGTERM, record_cancellation)

    try:
        try:
            # Streamed rather than captured, so `just autonomous-log` shows
            # progress as it happens. `--output-format json` emits a single blob
            # only once the run is over, which is useless to follow;
            # `stream-json` emits an event per step. stderr is merged in so
            # nothing is lost or deadlocks on a second unread pipe.
            process = subprocess.Popen(
                ["claude", "-p", prompt_text, *CLAUDE_BASE_ARGUMENTS],
                cwd=working_directory,
                # Without this `claude` spends three seconds waiting on an
                # inherited stdin that is never going to produce anything, and
                # warns about it.
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except FileNotFoundError:
            message = "`claude` not found on PATH — check the launchd PATH setting"
            log_message(message)
            events.claude_output(message)
            return 1, "error"

        # System sleep freezes the network connection carrying claude's response
        # with no error on either side — the CLI's own background-task wait
        # ceiling only notices once the machine wakes, by which point it has
        # already been exceeded, so it kills the task and the turn ends having
        # done nothing. `-w` ties the assertion to claude's PID so it needs no
        # cleanup of its own: it exits the moment claude does, however that
        # happens. Best-effort — a missing `caffeinate` should not fail the run.
        try:
            subprocess.Popen(
                ["caffeinate", "-s", "-w", str(process.pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            log_message("`caffeinate` not found on PATH — system sleep may interrupt this run")

        # A wedged session must not run until morning, and `Popen` has no timeout
        # of its own once we are reading its output line by line.
        ran_too_long = False

        def kill_for_max_duration() -> None:
            nonlocal ran_too_long
            ran_too_long = True
            process.kill()

        watchdog = threading.Timer(CLAUDE_MAX_PROMPT_DURATION_SECONDS, kill_for_max_duration)
        watchdog.daemon = True
        watchdog.start()

        background_task_timed_out = False

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
                        events.claude_output(stripped_line)
                        if BACKGROUND_TASK_TIMEOUT_MARKER in stripped_line:
                            background_task_timed_out = True
                        continue

                    if isinstance(event, dict):
                        events.claude_event(event)
                        for summary in summarise_stream_event(event):
                            log_message(summary)

            exit_code = process.wait()
        finally:
            watchdog.cancel()

        result_exit_code, outcome = determine_outcome(exit_code, ran_too_long, background_task_timed_out)

        if ran_too_long:
            log_message(f"Prompt exceeded the {CLAUDE_MAX_PROMPT_DURATION_SECONDS}s max run time and was killed")
        elif exit_code == 0 and background_task_timed_out:
            # The CLI ends the turn (and so the process, with exit code 0) the
            # instant it kills a stuck background task — see
            # BACKGROUND_TASK_TIMEOUT_MARKER above. A 0 here means "the CLI gave
            # up," not "the model finished," so it must not read as completed.
            log_message(
                "Exit code was 0, but the CLI force-ended the turn waiting on a "
                "background task — treating as an error rather than completed"
            )
        else:
            log_message(f"Prompt finished with exit code {exit_code}")

        return result_exit_code, outcome
    finally:
        signal.signal(signal.SIGTERM, previous_termination_handler)


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

    if arguments.dry_run:
        # An inspection, so it neither records events nor trims the file — asking
        # what would happen must not disturb the record of what did. Reports only
        # the immediate next entry: what the queue looks like after it is exactly
        # what a second dry run would show.
        if not check_pace_gate(arguments.force).ok:
            return 0

        queue_lines = read_queue_lines()
        if queue_lines is None:
            log_message(f"No prompt queue at {QUEUE_FILE}")
            return 0

        next_entry = find_next_todo(parse_queue(queue_lines))
        if next_entry is None:
            log_message("No todo prompts in queue (all completed, errored or empty)")
            return 0

        working_directory, is_new_project = resolve_working_directory(next_entry)
        destination = f"{working_directory}{' (new project)' if is_new_project else ''}"
        log_message(f"Dry run — would execute in {destination}:\n{build_prompt(next_entry.prompt)}")
        return 0

    # Behind pace keeps working through the queue rather than stopping after one
    # prompt, because a single entry rarely spends a night's worth of headroom.
    # `--force` is a single explicit run — the pace gate it bypasses is exactly
    # what this loop exists to keep re-checking, so it executes one prompt and
    # stops rather than draining the queue unattended.
    prompts_run = 0
    final_exit_code = 0

    while True:
        gate = check_pace_gate(arguments.force)
        # A fresh stream per prompt: `RunEventStream.__init__` trims the file and
        # replaces it atomically, which is what tells a connected viewer to reset
        # rather than append — each queued prompt is its own run to watch, the
        # same way a lone nightly prompt always has been.
        events = RunEventStream(run_id=utc_now_iso())

        if not gate.ok:
            events.skipped(gate.reason, gate.detail)
            break

        queue_lines = read_queue_lines()
        if queue_lines is None:
            events.skipped("emptyQueue", f"No prompt queue at {QUEUE_FILE}")
            break

        next_entry = find_next_todo(parse_queue(queue_lines))
        if next_entry is None:
            log_message("No todo prompts in queue (all completed, errored or empty)")
            events.skipped("emptyQueue", "No todo prompts in queue (all completed, errored or empty)")
            break

        working_directory, is_new_project = resolve_working_directory(next_entry)
        exit_code, outcome = run_claude(
            next_entry, working_directory, is_new_project, events, arguments.force
        )
        queue_status = queue_status_for_outcome(outcome)
        write_queue_status(next_entry.status_line_index, queue_status)
        # Last, so the terminal event is only written once the queue reflects the
        # outcome the viewer is about to show.
        events.finished(outcome, exit_code, queue_status)

        prompts_run += 1
        final_exit_code = exit_code

        if arguments.force:
            break

    if prompts_run > 1:
        log_message(f"Autonomous work session finished after {prompts_run} prompts")

    return final_exit_code


if __name__ == "__main__":
    sys.exit(main())
