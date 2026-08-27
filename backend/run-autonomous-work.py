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
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIRECTORY.parent

# Sibling modules, importable because Python puts this script's directory on
# sys.path. One owns the settings the Chrome extension mirrors to disk, one the
# morning-after digest this script writes when a session ends, and one the
# one-shot launch agent that picks the queue back up after a 5-hour reset.
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import autonomous_work_resume  # noqa: E402  (same)
import autonomous_work_settings  # noqa: E402  (must follow the sys.path line above)
import autonomous_work_summary  # noqa: E402  (same)

MILLISECONDS_PER_HOUR = 3_600_000

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

# Aliased from the summary module rather than spelled again, so the run-event
# stream the viewer reads and the day's summary can never disagree about it.
OUTCOME_SESSION_LIMIT = autonomous_work_summary.OUTCOME_SESSION_LIMIT

SECTION_SEPARATOR_PREFIX = "==="
STATUS_FIELD_PREFIX = "STATUS:"
REPOSITORY_FIELD_PREFIX = "REPO:"

# Printed by the Claude Code CLI itself (not this repo) when a turn is still
# waiting on a background task past CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS. The
# CLI kills the task and ends the turn right there, but the process still
# exits 0 — see findings/song-ratings-vinyl-prompt-stall.md. Matched as a
# substring so a differently-configured ceiling value doesn't break the check.
BACKGROUND_TASK_TIMEOUT_MARKER = "Background tasks still running after"

# The CLI's own account of hitting a subscription limit, e.g. "You've hit your
# session limit · resets 3:50am (Australia/Melbourne)". It arrives as a
# synthetic assistant message carrying `error: "rate_limit"`, and the process
# then exits 1 having done nothing at all — which is why it must not be recorded
# as a failed prompt. See `session_limit_message`.
SESSION_LIMIT_ERROR_CODE = "rate_limit"
# Matched only against messages the CLI has already flagged as an API error or a
# failed result, never against ordinary prose — otherwise a prompt about this
# very feature would look like a rate limit. Substrings, because the exact
# wording differs between the session, weekly and Opus-specific limits.
SESSION_LIMIT_TEXT_MARKERS = (
    "session limit",
    "usage limit",
    "weekly limit",
    "rate limit",
    "limit reached",
)


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
# The morning-after digest: one file per day, one section per session. At the
# repository root rather than beside this script, for the same reason
# `prompts.txt` is — it is written for a person to read, not for the machinery.
SUMMARIES_DIRECTORY = environment_path(
    "AUTONOMOUS_WORK_SUMMARIES_DIR", PROJECT_ROOT / "summaries"
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

    def resume_scheduled(self, pending: autonomous_work_resume.PendingResume) -> None:
        """A one-shot agent is now holding the queue's next attempt.

        Emitted after the run's terminal event, so the viewer's footer can end
        on "Resuming at 6:17am" rather than on the run simply stopping.
        """
        self.emit(
            "resumeScheduled",
            scheduledFor=pending.scheduled_for.astimezone().isoformat(),
            reason=pending.reason,
            source=pending.source,
        )


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
    """When the 5-hour window next refills, if the extension reported it.

    Optional with a default because an extension built before this field
    existed writes a snapshot without it, and a scheduler that refused to read
    that file would stop working until Chrome was rebuilt and restarted. Absent
    means "unknown", which `choose_resume_time` handles by falling through to
    its last source.
    """
    five_hour_resets_at: datetime | None = None


def parse_iso_timestamp(value: object) -> datetime | None:
    """An aware `datetime` from an ISO 8601 string the extension wrote, or None.

    The extension writes `Z`-suffixed UTC, which `fromisoformat` did not accept
    before 3.11. A naive reading is assumed UTC for the same reason: everything
    on the extension's side of this contract is `Date.toISOString()`.
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def snapshot_age_seconds(fetched_at_value: object) -> float | None:
    """How long ago the snapshot was taken, or None if it does not say."""
    fetched_at = parse_iso_timestamp(fetched_at_value)
    if fetched_at is None:
        return None
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
        five_hour_resets_at=parse_iso_timestamp(snapshot_data.get("fiveHourResetsAt")),
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
    """The snapshot the decision was made against, for whoever needs more of it.

    Filled in by `check_pace_gate`, not by the pure `evaluate_pace_gate` — it is
    a passenger, not an input to the decision. `schedule_resume_if_warranted`
    is the one reader, and it would otherwise have to re-read and re-log the
    same file a second later.
    """
    snapshot: PaceSnapshot | None = None


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

    return replace(result, snapshot=pace_snapshot)


# --------------------------------------------------------------------------- #
# Resuming after the 5-hour window resets
# --------------------------------------------------------------------------- #

# The CLI's notice names a wall-clock time and no date, e.g.
# "You've hit your session limit · resets 3:50am (Australia/Melbourne)". The
# minute, the meridiem and the zone are each optional, because the only sample
# we have is one wording out of an interface that is not ours — a shape we
# cannot read must produce None rather than a wrong time, and fall through to a
# later source in `choose_resume_time`.
RESET_TIME_PATTERN = re.compile(
    r"resets\s+(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(?:at\s+)?)?"
    r"(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?",
    re.IGNORECASE,
)
# Read out of the notice only to place the time on a day, never to classify
# which limit was hit — that is the clamp's job. A weekly or Opus notice is
# expected to name one ("resets Thursday 9am"), which is exactly what lets the
# clamp see that the reset is days out and refuse it.
WEEKDAY_NUMBERS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

# The nominal span of a session window, and so the last-resort guess at when the
# current one refills. Wrong by at most one window, and wrong *late*, which is
# the harmless direction: a late resume idles, an early one is refused and burns
# the day's only resume.
FIVE_HOUR_WINDOW_SECONDS = 5 * 3600
# launchd's calendar granularity is a minute, so firing in the same minute the
# window resets is asking to be refused a second time.
RESUME_BUFFER_SECONDS = environment_int("AUTONOMOUS_WORK_RESUME_BUFFER_SECONDS", 120)
# Anything further out than one window plus a little slack is not this window.
# This is what discards a weekly or Opus limit — both of which arrive by the
# same route as a session limit — without having to tell their wording apart.
RESUME_MAX_DELAY_SECONDS = FIVE_HOUR_WINDOW_SECONDS + 15 * 60

RESUME_SOURCE_CLI_NOTICE = "cliNotice"
RESUME_SOURCE_SNAPSHOT = "snapshot"
RESUME_SOURCE_FALLBACK = "fallback"

RESUME_SOURCE_DESCRIPTIONS = {
    RESUME_SOURCE_CLI_NOTICE: "from the CLI's notice",
    RESUME_SOURCE_SNAPSHOT: "from the usage snapshot",
    RESUME_SOURCE_FALLBACK: "guessed as five hours from now",
}


def describe_clock_time(moment: datetime) -> str:
    """"6:17am" — the form the CLI's own notice uses, so the log echoes it back."""
    return moment.strftime("%-I:%M%p").lower()


def parse_reset_time(notice: str | None, now: datetime) -> datetime | None:
    """The reset instant named in the CLI's limit notice, or None if it names none.

    The notice gives a wall-clock time and, at most, a weekday, so the **next**
    occurrence is taken — a limit hit at 1 AM naming "3:50am" means later this
    morning, one hit at 5 PM naming "3:50am" means tomorrow, and one naming
    "Thursday 9am" means the coming Thursday. A zone in parentheses is used if
    `zoneinfo` recognises it; otherwise the time is read in `now`'s own zone,
    which is the right guess because the CLI reports in the machine's zone and
    this runs on that machine.

    Returns None on anything unrecognised rather than guessing: a wrong time
    spends the day's only resume, where None falls through to a source that is
    merely imprecise.
    """
    if not notice:
        return None

    match = RESET_TIME_PATTERN.search(notice)
    if match is None:
        return None

    weekday_name, hour_text, minute_text, meridiem, zone_name = match.groups()
    hour = int(hour_text)
    minute = int(minute_text) if minute_text else 0
    if not 0 <= minute <= 59:
        return None

    if meridiem:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if meridiem.lower() == "pm" else 0)
    elif not 0 <= hour <= 23:
        return None

    zone = None
    if zone_name:
        try:
            from zoneinfo import ZoneInfo

            zone = ZoneInfo(zone_name.strip())
        except Exception:
            # An unknown zone is not a reason to discard an otherwise readable
            # time — the machine's own zone is the same one in every case we
            # expect, and being wrong here costs at most a few idle hours.
            zone = None

    reference = now.astimezone(zone) if zone is not None else now
    candidate = reference.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if weekday_name is None:
        if candidate <= reference:
            candidate += timedelta(days=1)
        return candidate

    days_ahead = (WEEKDAY_NUMBERS[weekday_name.lower()] - candidate.weekday()) % 7
    candidate += timedelta(days=days_ahead)
    if candidate <= reference:
        candidate += timedelta(days=7)
    return candidate


@dataclass(frozen=True)
class ResumeTime:
    """When to come back, and how sure we are about it."""

    fire_at: datetime
    """The unbuffered reset this was derived from — what the log quotes."""
    resets_at: datetime
    source: str


def choose_resume_time(
    now: datetime,
    *,
    limit_notice: str | None,
    snapshot_resets_at: datetime | None,
    buffer_seconds: int = RESUME_BUFFER_SECONDS,
    max_delay_seconds: int = RESUME_MAX_DELAY_SECONDS,
) -> ResumeTime | None:
    """When the 5-hour window next refills, from the best source available.

    Three sources in order of how much they know: the CLI's notice (seconds
    old, and names the answer), the extension's snapshot (can be hours stale),
    and five hours from now (always available, wrong by at most one window).

    Every candidate is buffered and then clamped into `(now, now + 5h + slack]`.
    The clamp is what silently rejects a weekly or Opus limit, which reaches
    this function by exactly the same route as a session limit but names a reset
    days away. So a notice that fails the clamp yields **no resume at all**
    rather than falling through — it is not this window, and nothing about it
    suggests this window is spent. A notice we merely could not parse does fall
    through, since it tells us nothing either way.
    """
    latest_acceptable = now + timedelta(seconds=max_delay_seconds)
    buffer = timedelta(seconds=buffer_seconds)

    notice_resets_at = parse_reset_time(limit_notice, now)
    if notice_resets_at is not None:
        fire_at = notice_resets_at + buffer
        if now < fire_at <= latest_acceptable:
            return ResumeTime(fire_at, notice_resets_at, RESUME_SOURCE_CLI_NOTICE)
        return None

    if snapshot_resets_at is not None:
        fire_at = snapshot_resets_at + buffer
        if now < fire_at <= latest_acceptable:
            return ResumeTime(fire_at, snapshot_resets_at, RESUME_SOURCE_SNAPSHOT)

    fallback_resets_at = now + timedelta(seconds=FIVE_HOUR_WINDOW_SECONDS)
    return ResumeTime(fallback_resets_at + buffer, fallback_resets_at, RESUME_SOURCE_FALLBACK)


# --------------------------------------------------------------------------- #
# Prompt queue
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class QueueEntry:
    # The status as `normalise_status` leaves it, so it may carry a `:detail`.
    # Compare against `status_name`, never against the raw string.
    status: str
    """Index into the file's line list, so the status can be rewritten in place."""
    status_line_index: int
    """The REPO: line as a path, or None to start a new project — see `resolve_working_directory`."""
    repository_path: Path | None
    prompt: str

    @property
    def status_name(self) -> str:
        """The status word on its own — `unmerged` out of `unmerged:add-widget`."""
        return status_name_of(self.status)


def status_name_of(status: str) -> str:
    return status.partition(STATUS_DETAIL_SEPARATOR)[0]


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
    return f"{status_name}{STATUS_DETAIL_SEPARATOR}{detail}"


def unmerged_status(branch_name: str) -> str:
    return f"{STATUS_UNMERGED}{STATUS_DETAIL_SEPARATOR}{branch_name}"


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
        if entry.status_name == STATUS_TODO and entry.prompt:
            return entry
    return None


def status_on_line(lines: list[str], status_line_index: int) -> str | None:
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


def rewrite_status_line(lines: list[str], status_line_index: int, new_status: str) -> list[str] | None:
    """The queue lines with one STATUS line replaced, or None if the index no longer lines up.

    Pure line-rewriting, split out from the file I/O around it. Targeting the
    line by index rather than by string replacement keeps the update correct
    even when a prompt body happens to contain the word STATUS.
    """
    if status_on_line(lines, status_line_index) is None:
        return None
    updated_lines = list(lines)
    updated_lines[status_line_index] = f"{STATUS_FIELD_PREFIX} {new_status}"
    return updated_lines


def write_queue_status(status_line_index: int, new_status: str) -> str:
    """Rewrite one STATUS line, replacing the file atomically. Returns the status
    the entry is left holding, which is what the run event and the day's summary
    then report.

    The temp-file swap means a queue edited mid-run is never left truncated.

    An `unmerged:<branch>` already on the line wins over anything this run would
    write. Only the run itself can have put it there — it is the one party that
    knows it left work on a branch — and overwriting it with `completed` would
    throw away the branch name, the single thing that status exists to carry.
    """
    lines = read_queue_lines()
    if lines is None:
        return new_status

    status_already_there = status_on_line(lines, status_line_index)
    if status_already_there is not None and status_name_of(status_already_there) == STATUS_UNMERGED:
        log_message(f"Queue entry already marked '{status_already_there}' by the run itself")
        return status_already_there

    updated_lines = rewrite_status_line(lines, status_line_index, new_status)
    if updated_lines is None:
        log_message(f"Queue changed while running; not updating status to {new_status}")
        return new_status

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
    return new_status


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


def assistant_message_text(event: dict) -> str:
    """Every text block of an assistant event, joined — "" if it carries none."""
    content = event.get("message", {}).get("content", [])
    texts = [
        str(block.get("text", "")).strip()
        for block in (content if isinstance(content, list) else [])
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return " ".join(text for text in texts if text)


def session_limit_message(event: dict) -> str | None:
    """The CLI's "you've hit your limit" notice, if this event is one.

    Hitting a subscription limit ends the turn immediately having done no work,
    so the queue entry must be left `todo` rather than marked as an error — it
    was never really attempted. Recognising that from the stream is the only
    option available: the process just exits 1, indistinguishable from a prompt
    that genuinely failed.

    The structured `error: "rate_limit"` field is the reliable signal and is
    trusted on its own. The text markers are a fallback for a CLI that stops
    setting it, and are only ever consulted for a message the CLI has *already*
    flagged as an API error or a failed result — matching them against ordinary
    assistant prose would make any prompt that discusses rate limits (this one,
    for instance) look like it hit one.
    """
    event_type = event.get("type")

    if event_type == "assistant":
        text = assistant_message_text(event)
        if event.get("error") == SESSION_LIMIT_ERROR_CODE:
            return text or f"The CLI reported {SESSION_LIMIT_ERROR_CODE}"
        if not event.get("is_api_error_message"):
            return None
    elif event_type == "result":
        if not event.get("is_error"):
            return None
        result_text = event.get("result")
        text = result_text.strip() if isinstance(result_text, str) else ""
    else:
        return None

    lowered = text.lower()
    if any(marker in lowered for marker in SESSION_LIMIT_TEXT_MARKERS):
        return text
    return None


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


# --------------------------------------------------------------------------- #
# Work left on a branch
# --------------------------------------------------------------------------- #

# Tried in order when a repository has no `origin/HEAD` naming its default
# branch. Only ever used to answer "what would this work have been merged into".
FALLBACK_DEFAULT_BRANCH_NAMES = ("main", "master")
# Every git call here is one question about a local repository. Bounded anyway,
# because this runs unattended and a wedged git would otherwise hold the whole
# session open.
GIT_QUERY_TIMEOUT_SECONDS = 15


def git_output(working_directory: Path, *arguments: str) -> str | None:
    """One git command's stdout, stripped — or None if it failed for any reason.

    Every caller is asking a question about a directory that may not be a
    repository at all, so "git said no" is an answer ("cannot tell") rather than
    an error worth reporting.
    """
    try:
        result = subprocess.run(
            ["git", *arguments],
            cwd=working_directory,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_QUERY_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.decode("utf-8", "replace").strip()


@dataclass(frozen=True)
class GitCheckpoint:
    """Where a working directory's repository stood at some moment.

    Taken before the prompt runs and again after, so "did this run leave work on
    a branch" can be answered about *this* run rather than about whatever the
    repository happened to be in the middle of already.
    """

    branch: str | None
    head_commit: str | None


def capture_git_checkpoint(working_directory: Path) -> GitCheckpoint:
    return GitCheckpoint(
        branch=checked_out_branch(working_directory),
        head_commit=git_output(working_directory, "rev-parse", "HEAD"),
    )


def checked_out_branch(working_directory: Path) -> str | None:
    """The checked-out branch, or None when there is not one.

    None covers a directory that is not a repository and a detached HEAD alike —
    neither is anybody's idea of work waiting on a branch.
    """
    return git_output(working_directory, "symbolic-ref", "--quiet", "--short", "HEAD") or None


def local_branch_exists(working_directory: Path, branch_name: str) -> bool:
    reference = f"refs/heads/{branch_name}"
    return git_output(working_directory, "rev-parse", "--verify", "--quiet", reference) is not None


def default_branch_name(working_directory: Path) -> str | None:
    """The branch finished work would have been merged into, or None if there is none.

    `origin/HEAD` first, since a repository with a remote that names one has
    already answered the question; otherwise the first of `main`/`master` that
    exists locally. A brand-new project on whatever `init.defaultBranch` says
    has nothing to be unmerged *from*, and None says exactly that.
    """
    origin_head = git_output(
        working_directory, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"
    )
    if origin_head:
        _, _, branch_name = origin_head.partition("/")
        if branch_name and local_branch_exists(working_directory, branch_name):
            return branch_name

    for candidate_name in FALLBACK_DEFAULT_BRANCH_NAMES:
        if local_branch_exists(working_directory, candidate_name):
            return candidate_name
    return None


def unmerged_branch_after_run(working_directory: Path, before: GitCheckpoint) -> str | None:
    """The branch this run left finished work on, or None if it left none.

    Read out of the repository rather than taken on trust from the run itself,
    which is what makes it work with no cooperation from the prompt: work is
    unmerged when the branch now checked out is not the default one and carries
    commits the default branch does not. A run that merged its branch and stayed
    on it reports nothing, because those commits are contained; so does one that
    committed straight to the default branch, and one that left its changes
    uncommitted for review.

    A repository this run did not move is never reported. One already sitting on
    a half-finished branch when the prompt started was not left that way by this
    prompt, and claiming its branch would put somebody else's work in the queue.
    """
    after = capture_git_checkpoint(working_directory)
    if after.branch is None:
        return None
    if after.branch == before.branch and after.head_commit == before.head_commit:
        return None

    default_branch = default_branch_name(working_directory)
    if default_branch is None or after.branch == default_branch:
        return None

    commits_ahead = git_output(
        working_directory, "rev-list", "--count", f"{default_branch}..HEAD"
    )
    if not commits_ahead or commits_ahead == "0":
        return None

    log_message(
        f"Work left on branch '{after.branch}', {commits_ahead} commit(s) "
        f"ahead of '{default_branch}'"
    )
    return after.branch


def determine_outcome(
    exit_code: int,
    ran_too_long: bool,
    background_task_timed_out: bool,
    hit_session_limit: bool = False,
) -> tuple[int, str]:
    """The exit code alone is not trustworthy — decide what actually happened.

    Three things make it lie. Two make the process exit 0 without the prompt
    having finished: the CLI's own background-task wait ceiling
    (BACKGROUND_TASK_TIMEOUT_MARKER) and this script's own max-duration
    watchdog. The third makes it exit 1 without the prompt having *started* —
    hitting a subscription limit, which is no more a failure than an empty
    queue is, and so reports exit code 0 alongside its own outcome. Split out
    from `run_claude` so the decision can be unit-tested against every
    combination without spawning a real subprocess.

    A session limit outranks the watchdog because the two answer different
    questions and only one of them decides the queue entry's fate: a
    rate-limited turn did no work whatever else happened around it, and an
    entry left `todo` can simply run again, where one marked `error` is skipped
    until somebody edits the file by hand.
    """
    if hit_session_limit:
        return 0, OUTCOME_SESSION_LIMIT
    if ran_too_long:
        return 1, "timeout"
    if exit_code == 0 and background_task_timed_out:
        return exit_code, "error"
    return exit_code, ("completed" if exit_code == 0 else "error")


def queue_status_for_outcome(outcome: str, unmerged_branch: str | None = None) -> str:
    """The queue's STATUS value for a run's outcome.

    Keyed off `outcome`, never off the exit code directly: `determine_outcome`
    can report "error" for an exit code of 0 (a background task that timed
    out, or a watchdog kill) and 0 for a session limit that exited 1, and a
    queue status derived from the exit code alone would silently undo both —
    see findings/song-ratings-vinyl-prompt-stall.md.

    A prompt that finished but left its work on a branch is `unmerged:<branch>`
    rather than `completed`, so the branch waiting on an answer is named in the
    queue instead of being lost. Only a clean finish can be unmerged: an errored
    or timed-out run says `error`, which is the more useful of the two things
    that are both true about it.
    """
    if outcome == OUTCOME_SESSION_LIMIT:
        return STATUS_TODO
    if outcome != "completed":
        return STATUS_ERROR
    return unmerged_status(unmerged_branch) if unmerged_branch else STATUS_COMPLETED


class ClaudeOutputCollector:
    """What the day's summary needs out of the stream, gathered as it goes by.

    The last assistant message is tracked as well as the `result` event, because
    a prompt that timed out, wedged or was cancelled never emits a result — and
    "how far did it get before it stopped" is exactly what the summary has to
    answer in that case. Pure: it only ever looks at events handed to it, so the
    extraction can be unit-tested against recorded stream-json.
    """

    def __init__(self) -> None:
        self.result_text: str | None = None
        self.latest_assistant_text: str | None = None
        self.turns: int | None = None
        self.cost_usd: float | None = None
        """The CLI's limit notice, if one arrived — see `session_limit_message`."""
        self.session_limit_notice: str | None = None

    def observe(self, event: dict) -> None:
        event_type = event.get("type")

        # Checked before the branches below, since the notice arrives as an
        # ordinary-looking assistant message and as the result's text.
        self.session_limit_notice = self.session_limit_notice or session_limit_message(event)

        if event_type == "assistant":
            content = event.get("message", {}).get("content", [])
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = str(block.get("text", "")).strip()
                    if text:
                        self.latest_assistant_text = text

        elif event_type == "result":
            result_text = event.get("result")
            if isinstance(result_text, str) and result_text.strip():
                self.result_text = result_text.strip()
            turns = event.get("num_turns")
            if isinstance(turns, int):
                self.turns = turns
            cost = event.get("total_cost_usd")
            if isinstance(cost, (int, float)):
                self.cost_usd = float(cost)

    @property
    def closing_text(self) -> str | None:
        return self.result_text or self.latest_assistant_text

    @property
    def hit_session_limit(self) -> bool:
        return self.session_limit_notice is not None


@dataclass(frozen=True)
class PromptRunResult:
    """One prompt's outcome, plus what the day's summary reports about it.

    It carries its own start and end times rather than leaving the caller to
    take them: only `run_claude` knows when the prompt actually began, and a
    second clock reading in `main` would drift from it for no reason.
    """

    exit_code: int
    outcome: str
    started_at: datetime
    finished_at: datetime
    result_text: str | None = None
    turns: int | None = None
    cost_usd: float | None = None
    """The branch a completed prompt left its work on — see `unmerged_branch_after_run`."""
    unmerged_branch: str | None = None


def run_claude(
    entry: QueueEntry,
    working_directory: Path,
    is_new_project: bool,
    events: RunEventStream,
    forced: bool,
    session: autonomous_work_summary.SessionSummary,
) -> PromptRunResult:
    """Execute one queued prompt, and report how it went."""
    prompt_text = build_prompt(entry.prompt)
    events.started(working_directory, is_new_project, prompt_text, forced)
    started_at = datetime.now()
    output = ClaudeOutputCollector()
    # Taken before the directory is prepared, so a new project reads as the empty
    # thing it is rather than as the repository `git init` is about to make. Any
    # repository already here is recorded as it stands, which is what keeps a
    # branch this run never touched out of the queue.
    checkpoint_before_run = capture_git_checkpoint(working_directory)

    def run_result(
        exit_code: int,
        outcome: str,
        result_text: str | None = None,
        turns: int | None = None,
        cost_usd: float | None = None,
    ) -> PromptRunResult:
        """This prompt's result, stamped with the times only this function knows."""
        return PromptRunResult(
            exit_code,
            outcome,
            started_at,
            datetime.now(),
            result_text,
            turns,
            cost_usd,
            unmerged_branch=(
                unmerged_branch_after_run(working_directory, checkpoint_before_run)
                if outcome == "completed"
                else None
            ),
        )

    if not prepare_working_directory(working_directory, is_new_project):
        return run_result(1, "error", result_text=f"Could not prepare {working_directory}")

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
        # A cancelled night is one of the nights you most want a record of, so
        # the summary is written from here too — with the entry's real status,
        # `todo`, rather than the one a completed run would have left.
        session.record_attempt(
            autonomous_work_summary.PromptAttempt(
                prompt=entry.prompt,
                working_directory=str(working_directory),
                is_new_project=is_new_project,
                outcome=autonomous_work_summary.OUTCOME_CANCELLED,
                queue_status=STATUS_TODO,
                result_text=output.closing_text,
                started_at=started_at,
                finished_at=datetime.now(),
                turns=output.turns,
                cost_usd=output.cost_usd,
            )
        )
        session.stop(autonomous_work_summary.OUTCOME_CANCELLED)
        finish_session(session)
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
            return run_result(1, "error", result_text=message)

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
                        output.observe(event)
                        for summary in summarise_stream_event(event):
                            log_message(summary)

            exit_code = process.wait()
        finally:
            watchdog.cancel()

        result_exit_code, outcome = determine_outcome(
            exit_code, ran_too_long, background_task_timed_out, output.hit_session_limit
        )

        if output.hit_session_limit:
            log_message(
                f"Subscription limit reached ({shorten(output.session_limit_notice or '')}) "
                "— the queue entry is left as todo"
            )
        elif ran_too_long:
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

        return run_result(
            result_exit_code,
            outcome,
            # The limit notice wins over the closing message where there is
            # one: it names which limit was hit and when it lifts, where the
            # result event of a refused turn carries only the CLI's own generic
            # error. That notice is the entire account of a prompt that never ran.
            result_text=output.session_limit_notice or output.closing_text,
            turns=output.turns,
            cost_usd=output.cost_usd,
        )
    finally:
        signal.signal(signal.SIGTERM, previous_termination_handler)


# --------------------------------------------------------------------------- #
# Session summary
# --------------------------------------------------------------------------- #


def remaining_todo_prompts(already_attempted: list[str]) -> list[str]:
    """Queue entries still marked `todo`, in the order they would be picked up.

    `already_attempted` is excluded because two outcomes deliberately leave an
    entry as `todo`: a cancelled prompt and one that hit a subscription limit.
    Each belongs in the summary as the prompt that was cut short, not a second
    time as one that was never reached.
    """
    queue_lines = read_queue_lines()
    if queue_lines is None:
        return []
    return [
        entry.prompt
        for entry in parse_queue(queue_lines)
        if entry.status_name == STATUS_TODO and entry.prompt and entry.prompt not in already_attempted
    ]


def queue_holds_a_todo() -> bool:
    """Is there anything to come back for?"""
    queue_lines = read_queue_lines()
    if queue_lines is None:
        return False
    return find_next_todo(parse_queue(queue_lines)) is not None


def schedule_resume_if_warranted(
    reason: str,
    *,
    limit_notice: str | None,
    snapshot_resets_at: datetime | None,
    forced: bool,
    is_resume_run: bool,
    events: RunEventStream,
    now: datetime | None = None,
) -> autonomous_work_resume.PendingResume | None:
    """Ask launchd to start the queue again once the 5-hour window refills.

    Holds every guard from the plan's §3 in one place, and logs the one that
    bit — a job that starts at 6 AM for no visible reason is worse than one that
    does not start at all, and so is a resume that silently never happens.

    The guards, and why each is here rather than somewhere more convenient:

    * **A resumed run schedules nothing.** One resume is a second attempt at
      the night's work; a chain of them is a decision from 2 AM walking through
      the following day on the strength of one possibly-stale snapshot. This is
      the guard that makes every other freshness check unnecessary.
    * **One per calendar day**, since `just trigger-autonomous-work` can also
      schedule one.
    * **Never from `--force`.** A forced run is single-shot by definition, and a
      button press is one instruction rather than a standing one.
    * **Only where the nightly job is already installed.** Writing a launch
      agent nobody asked for is not this script's call — the same rule
      `install_launch_agent(only_if_installed=True)` follows for the same
      directory.
    * **Only with work left queued.** Nothing to come back for otherwise.
    """
    now = now or datetime.now().astimezone()

    if is_resume_run:
        log_message("Not scheduling a resume — this run is itself a resume")
        return None

    if forced:
        log_message("Not scheduling a resume — a forced run is a single explicit instruction")
        return None

    if not autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.exists():
        log_message("Not scheduling a resume — the nightly job is not installed")
        return None

    if autonomous_work_resume.resume_scheduled_today(now):
        log_message("Not scheduling a resume — today has already had one")
        return None

    if not queue_holds_a_todo():
        log_message("Not scheduling a resume — nothing left queued to come back for")
        return None

    resume_time = choose_resume_time(
        now, limit_notice=limit_notice, snapshot_resets_at=snapshot_resets_at
    )
    # The notice is echoed whatever happens: its wording is not ours, and this
    # log line is the only thing that would make a change to it diagnosable.
    if limit_notice:
        log_message(
            "The CLI's limit notice read: {} (reset time read as {})".format(
                shorten(limit_notice), parse_reset_time(limit_notice, now)
            )
        )

    if resume_time is None:
        log_message(
            "Not scheduling a resume — the reset named is further out than one session window, "
            "so it is a weekly or Opus limit rather than this one"
        )
        return None

    pending = autonomous_work_resume.PendingResume(
        scheduled_for=resume_time.fire_at,
        scheduled_at=now,
        reason=reason,
        source=resume_time.source,
    )
    update = autonomous_work_resume.schedule_resume(pending)
    if not update.applied:
        log_message(f"Could not schedule a resume: {update.detail}")
        return None

    log_message(
        "Resuming at {} (5-hour window resets {}, {})".format(
            describe_clock_time(resume_time.fire_at),
            describe_clock_time(resume_time.resets_at),
            RESUME_SOURCE_DESCRIPTIONS[resume_time.source],
        )
    )
    events.resume_scheduled(pending)
    return pending


def resume_scheduled_for(
    pending: autonomous_work_resume.PendingResume | None,
) -> datetime | None:
    """The moment a scheduled resume will fire, for the day's summary — None if none was."""
    return None if pending is None else pending.scheduled_for.astimezone()


def finish_session(session: autonomous_work_summary.SessionSummary) -> None:
    """Close the session record off and append it to the day's summary file.

    Called from the end of `main` and from the cancellation handler, which are
    the only two ways a session ends. A session that ran nothing writes no file:
    the gate's decision is already in the log, and a summary every night saying
    "nothing to do" would bury the ones that describe actual work.
    """
    session.finished_at = datetime.now()
    session.not_attempted = remaining_todo_prompts(
        [attempt.prompt for attempt in session.attempts]
    )

    if not session.attempts:
        return

    summary_path = autonomous_work_summary.write_session_summary(SUMMARIES_DIRECTORY, session)
    if summary_path is None:
        log_message(f"Could not write the session summary under {SUMMARIES_DIRECTORY}")
    else:
        log_message(f"Session summary written to {summary_path}")


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
    argument_parser.add_argument(
        "--resume",
        action="store_true",
        help="Serve a resume scheduled by an earlier run that hit the 5-hour window.",
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
            log_message("No todo prompts in queue (all completed, errored, unmerged, draft or empty)")
            return 0

        working_directory, is_new_project = resolve_working_directory(next_entry)
        destination = f"{working_directory}{' (new project)' if is_new_project else ''}"
        log_message(f"Dry run — would execute in {destination}:\n{build_prompt(next_entry.prompt)}")
        return 0

    if arguments.resume:
        # A resume is only legitimate if a run actually asked for one. Three
        # things make this a no-op — no state, one already served, and one whose
        # moment is long past — and each is a real situation rather than a bug:
        # the agent is pinned to a Month and Day, so an uncleaned one fires
        # again a year later, and a Mac that was asleep runs a missed calendar
        # job when it wakes. Exit 0 either way; a deliberate no-op is not a
        # failure worth putting in the system log.
        consumption = autonomous_work_resume.consume_pending_resume(datetime.now().astimezone())
        log_message(f"Resume run — {consumption.detail}")
        if consumption.pending is None:
            return 0

    # Behind pace keeps working through the queue rather than stopping after one
    # prompt, because a single entry rarely spends a night's worth of headroom.
    # `--force` is a single explicit run — the pace gate it bypasses is exactly
    # what this loop exists to keep re-checking, so it executes one prompt and
    # stops rather than draining the queue unattended.
    prompts_run = 0
    final_exit_code = 0
    # Accumulated across every prompt in the session, and written out once at the
    # end as the day's summary — see `finish_session`.
    session = autonomous_work_summary.SessionSummary(
        started_at=datetime.now(), forced=arguments.force
    )

    while True:
        gate = check_pace_gate(arguments.force)
        # A fresh stream per prompt: `RunEventStream.__init__` trims the file and
        # replaces it atomically, which is what tells a connected viewer to reset
        # rather than append — each queued prompt is its own run to watch, the
        # same way a lone nightly prompt always has been.
        events = RunEventStream(run_id=utc_now_iso())

        if not gate.ok:
            events.skipped(gate.reason, gate.detail)
            session.stop(gate.reason, gate.detail)
            if gate.reason == "fiveHourExhausted":
                # The weak of the two endings: the snapshot said the window was
                # full, and it can be hours stale. Worth a resume anyway — the
                # week is behind, the queue is full, and the one obstacle clears
                # at a knowable time.
                session.resume_scheduled_for = resume_scheduled_for(
                    schedule_resume_if_warranted(
                        "fiveHourExhausted",
                        limit_notice=None,
                        snapshot_resets_at=(
                            gate.snapshot.five_hour_resets_at if gate.snapshot else None
                        ),
                        forced=arguments.force,
                        is_resume_run=arguments.resume,
                        events=events,
                    )
                )
            break

        queue_lines = read_queue_lines()
        if queue_lines is None:
            events.skipped("emptyQueue", f"No prompt queue at {QUEUE_FILE}")
            session.stop("emptyQueue", f"No prompt queue at {QUEUE_FILE}")
            break

        next_entry = find_next_todo(parse_queue(queue_lines))
        if next_entry is None:
            log_message("No todo prompts in queue (all completed, errored, unmerged, draft or empty)")
            events.skipped("emptyQueue", "No todo prompts in queue (all completed, errored, unmerged, draft or empty)")
            session.stop("emptyQueue")
            break

        working_directory, is_new_project = resolve_working_directory(next_entry)
        prompt_result = run_claude(
            next_entry, working_directory, is_new_project, events, arguments.force, session
        )
        # The status the file is left holding, which is not always the one asked
        # for: a run that marked itself `unmerged:<branch>` keeps that.
        queue_status = write_queue_status(
            next_entry.status_line_index,
            queue_status_for_outcome(prompt_result.outcome, prompt_result.unmerged_branch),
        )
        # Last, so the terminal event is only written once the queue reflects the
        # outcome the viewer is about to show.
        events.finished(prompt_result.outcome, prompt_result.exit_code, queue_status)

        session.record_attempt(
            autonomous_work_summary.PromptAttempt(
                prompt=next_entry.prompt,
                working_directory=str(working_directory),
                is_new_project=is_new_project,
                outcome=prompt_result.outcome,
                queue_status=queue_status,
                result_text=prompt_result.result_text,
                started_at=prompt_result.started_at,
                finished_at=prompt_result.finished_at,
                turns=prompt_result.turns,
                cost_usd=prompt_result.cost_usd,
            )
        )

        prompts_run += 1
        final_exit_code = prompt_result.exit_code

        if prompt_result.outcome == OUTCOME_SESSION_LIMIT:
            # For the same reason `fiveHourExhausted` ends a session: the limit
            # does not lift for hours, so every remaining `todo` would be picked
            # up only to be refused in a second or two, burning through the
            # queue without running any of it.
            session.stop(OUTCOME_SESSION_LIMIT, prompt_result.result_text)
            # The strong ending: the refusal is seconds old and its notice names
            # the reset. If that reset is days away it is the weekly or Opus
            # limit, which arrives by this same route — `choose_resume_time`
            # rejects it on the distance alone, without reading the wording.
            session.resume_scheduled_for = resume_scheduled_for(
                schedule_resume_if_warranted(
                    OUTCOME_SESSION_LIMIT,
                    limit_notice=prompt_result.result_text,
                    snapshot_resets_at=(
                        gate.snapshot.five_hour_resets_at if gate.snapshot else None
                    ),
                    forced=arguments.force,
                    is_resume_run=arguments.resume,
                    events=events,
                )
            )
            break

        if arguments.force:
            session.stop("forcedSingleRun")
            break

    if prompts_run > 1:
        log_message(f"Autonomous work session finished after {prompts_run} prompts")

    finish_session(session)

    return final_exit_code


if __name__ == "__main__":
    sys.exit(main())
