"""The end-of-session digest written to `summaries/YYYY-MM-DD.md`.

The three log files a run already writes answer "what happened, step by step".
None of them answers the question you actually have in the morning: which queued
prompts ran, how each of them went, and why the session stopped when it did.
That is what this module renders.

One file per calendar day, appended to rather than replaced, because a day can
hold more than one session — the nightly job at 2 AM and any number of "Run now"
presses afterwards. The date is the one the session *started* on, so a run that
crosses midnight stays in the file where you would look for it.

Rendering is kept pure and the file I/O is a single function at the bottom, so
the wording can be unit-tested without a filesystem. Imported by
`run-autonomous-work.py`, hence the underscores in the filename — a hyphen would
make it unimportable, the same reason `autonomous_work_settings.py` has them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# Long enough for a full "here is what I did" sign-off, short enough that one
# runaway final message cannot make the day's file unreadable.
RESULT_TEXT_CHARACTER_LIMIT = 3000
# The prompt is repeated in the summary so the file stands on its own once the
# queue entry has been edited or deleted, but a summary is a digest, not a copy
# of prompts.txt.
PROMPT_EXCERPT_CHARACTER_LIMIT = 600
TITLE_CHARACTER_LIMIT = 80

OUTCOME_COMPLETED = "completed"
OUTCOME_ERROR = "error"
OUTCOME_TIMEOUT = "timeout"
OUTCOME_CANCELLED = "cancelled"
# The prompt was refused by a subscription limit before it did anything, so the
# queue entry stays `todo`. Not a failure, and counted separately from one.
OUTCOME_SESSION_LIMIT = "sessionLimit"

# Why the session stopped. The first four are the pace gate's own reason codes,
# passed straight through, so the prose here stays in step with the gate rather
# than paraphrasing it a second time.
STOP_REASON_DESCRIPTIONS = {
    "emptyQueue": "Ran out of queued work — nothing left marked `todo`.",
    "queueUnavailable": (
        "The queue could not be read at all, so nothing ran. Deliberately not treated as an "
        "empty queue: falling back to another source would risk running work that had been "
        "deleted from this one."
    ),
    "onPace": "Caught back up to pace — running more would have spent above an even weekly burn.",
    "fiveHourExhausted": (
        "The 5-hour session window was exhausted. It does not refill early, so the run stopped "
        "there rather than sitting idle waiting for the reset."
    ),
    "noSnapshot": (
        "No usable pace snapshot, so there was no way to tell whether the week was behind pace."
    ),
    "forcedSingleRun": "A forced run (`--force`), which runs exactly one prompt and stops.",
    "cancelled": "Cancelled while a prompt was still running.",
    OUTCOME_SESSION_LIMIT: (
        "A subscription limit was reached. It does not lift for hours, so the run stopped there "
        "rather than offering the rest of the queue up to be refused one prompt at a time. "
        "Nothing was spent and the entry is still `todo`."
    ),
}

OUTCOME_LABELS = {
    OUTCOME_COMPLETED: "Completed",
    OUTCOME_ERROR: "Failed",
    OUTCOME_TIMEOUT: "Failed (ran past its time limit and was killed)",
    OUTCOME_CANCELLED: "Cancelled part-way through",
    OUTCOME_SESSION_LIMIT: "Not run (subscription limit reached — still queued)",
}

# The heading over Claude's closing message. A prompt that ran has something to
# report; one that was cut short has only got as far as it got; one refused by a
# limit never spoke at all, and the text is the CLI's notice.
RESULT_TEXT_HEADINGS = {
    OUTCOME_COMPLETED: "**What it reported**",
    OUTCOME_SESSION_LIMIT: "**What the CLI reported**",
}
DEFAULT_RESULT_TEXT_HEADING = "**Where it got to** (its last message before the run ended)"


@dataclass
class PromptAttempt:
    """One queued prompt this session picked up, and how it went."""

    prompt: str
    working_directory: str
    is_new_project: bool
    outcome: str
    """The STATUS the queue entry was left at — `todo` for a cancelled prompt."""
    queue_status: str
    """Claude's closing message, or its last message if the run never reached one."""
    result_text: str | None
    started_at: datetime
    finished_at: datetime
    turns: int | None = None
    cost_usd: float | None = None

    @property
    def succeeded(self) -> bool:
        return self.outcome == OUTCOME_COMPLETED


@dataclass
class SessionSummary:
    """A single invocation of the scheduler, however many prompts it worked through."""

    started_at: datetime
    forced: bool
    attempts: list[PromptAttempt] = field(default_factory=list)
    """Prompts still marked `todo` when the session stopped — queued, never reached."""
    not_attempted: list[str] = field(default_factory=list)
    stop_reason: str | None = None
    stop_detail: str | None = None
    finished_at: datetime | None = None
    """When launchd will start the queue again, if this session scheduled a resume.

    Carried on the session rather than read back out of
    `backend/autonomous-work-resume.json` here, because of the ordering: the
    resume is scheduled inside the run loop and this file is rendered
    afterwards, so by then the state file is the right answer only by accident.
    Passing it makes the dependency explicit and keeps rendering pure.
    """
    resume_scheduled_for: datetime | None = None

    def record_attempt(self, attempt: PromptAttempt) -> None:
        self.attempts.append(attempt)

    def stop(self, reason: str, detail: str | None = None) -> None:
        self.stop_reason = reason
        self.stop_detail = detail


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #


def collapse_whitespace(text: str) -> str:
    return " ".join(text.split())


def truncate(text: str, limit: int) -> str:
    stripped_text = text.strip()
    if len(stripped_text) <= limit:
        return stripped_text
    return stripped_text[: limit - 1].rstrip() + "…"


def prompt_title(prompt: str) -> str:
    """A one-line name for a prompt that has no title of its own.

    The queue is free text, so the first non-empty line is the closest thing to
    a heading a prompt has.
    """
    for line in prompt.splitlines():
        collapsed_line = collapse_whitespace(line)
        if collapsed_line:
            return truncate(collapsed_line, TITLE_CHARACTER_LIMIT)
    return "(empty prompt)"


def describe_duration(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 90:
        return f"{minutes:.0f} min"
    return f"{minutes / 60:.1f}h"


def describe_stop_reason(stop_reason: str | None, stop_detail: str | None) -> str:
    """Why the session stopped, in a sentence, with the gate's own detail kept.

    An unrecognised reason is reported rather than swallowed: a new gate code
    should show up in the summary as itself, not as silence.
    """
    if stop_reason is None:
        return "The session ended without recording a reason."

    description = STOP_REASON_DESCRIPTIONS.get(stop_reason, f"Stopped: {stop_reason}.")
    if stop_detail:
        return f"{description} ({collapse_whitespace(stop_detail)})"
    return description


def render_attempt(attempt: PromptAttempt) -> list[str]:
    label = OUTCOME_LABELS.get(attempt.outcome, attempt.outcome)
    lines = [f"### {label} — {prompt_title(attempt.prompt)}", ""]

    facts = [
        f"- Ran {attempt.started_at:%H:%M}–{attempt.finished_at:%H:%M}"
        f" ({describe_duration((attempt.finished_at - attempt.started_at).total_seconds())})",
        f"- Working directory: `{attempt.working_directory}`"
        + (" (new project)" if attempt.is_new_project else ""),
        f"- Queue entry left as `{attempt.queue_status}`",
    ]
    if attempt.turns is not None:
        cost_text = f", ${attempt.cost_usd:.2f}" if attempt.cost_usd is not None else ""
        facts.append(f"- {attempt.turns} turns{cost_text}")
    lines.extend(facts)

    prompt_excerpt = truncate(collapse_whitespace(attempt.prompt), PROMPT_EXCERPT_CHARACTER_LIMIT)
    lines.extend(["", "**Prompt**", "", f"> {prompt_excerpt}", ""])

    if attempt.result_text:
        heading = RESULT_TEXT_HEADINGS.get(attempt.outcome, DEFAULT_RESULT_TEXT_HEADING)
        lines.extend([heading, "", truncate(attempt.result_text, RESULT_TEXT_CHARACTER_LIMIT), ""])
    else:
        lines.extend(
            ["Claude produced no closing message — see `backend/autonomous-work.log`.", ""]
        )

    return lines


def render_counts(summary: SessionSummary) -> str:
    """The one line you should be able to read and stop, if the night went well."""
    completed_count = sum(1 for attempt in summary.attempts if attempt.succeeded)
    cancelled_count = sum(
        1 for attempt in summary.attempts if attempt.outcome == OUTCOME_CANCELLED
    )
    # Counted apart from the failures, and subtracted from them: a prompt the
    # subscription limit refused did nothing wrong and is still queued.
    limited_count = sum(
        1 for attempt in summary.attempts if attempt.outcome == OUTCOME_SESSION_LIMIT
    )
    failed_count = len(summary.attempts) - completed_count - cancelled_count - limited_count

    breakdown = [f"{completed_count} completed", f"{failed_count} failed"]
    if cancelled_count:
        breakdown.append(f"{cancelled_count} cancelled")
    if limited_count:
        breakdown.append(f"{limited_count} stopped by the subscription limit")

    attempted = f"{len(summary.attempts)} prompt{'' if len(summary.attempts) == 1 else 's'} attempted"
    queued = (
        "Nothing left queued."
        if not summary.not_attempted
        else f"{len(summary.not_attempted)} still queued."
    )
    return f"{attempted}: {', '.join(breakdown)}. {queued}"


def render_session_summary(summary: SessionSummary) -> str:
    """One session's section of the day's file."""
    finished_at = summary.finished_at or summary.started_at
    session_kind = "run now" if summary.forced else "scheduled run"

    lines = [
        f"## {summary.started_at:%H:%M}–{finished_at:%H:%M} ({session_kind})",
        "",
        render_counts(summary),
        "",
        f"**Why it stopped:** {describe_stop_reason(summary.stop_reason, summary.stop_detail)}",
        "",
    ]

    if summary.resume_scheduled_for is not None:
        # Directly under "why it stopped", because it is the other half of that
        # answer: a job starting at 6 AM for no visible reason is worse than one
        # that stopped for no visible reason.
        lines.extend(
            [
                f"**Resuming:** {summary.resume_scheduled_for:%H:%M}, "
                "when the 5-hour session window resets.",
                "",
            ]
        )

    for attempt in summary.attempts:
        lines.extend(render_attempt(attempt))

    lines.append("### Not attempted")
    lines.append("")
    if summary.not_attempted:
        lines.append("Still `todo` in the queue, in the order they will be picked up:")
        lines.append("")
        lines.extend(f"- {prompt_title(prompt)}" for prompt in summary.not_attempted)
    else:
        lines.append("Nothing — the queue held no further `todo` entries.")
    lines.append("")

    return "\n".join(lines)


def render_day_heading(day: datetime) -> str:
    return f"# Autonomous work — {day:%A %-d %B %Y}\n"


def summary_file_path(summaries_directory: Path, day: datetime) -> Path:
    """One file per calendar day, named so the directory sorts chronologically."""
    return summaries_directory / f"{day:%Y-%m-%d}.md"


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #


def write_session_summary(
    summaries_directory: Path,
    summary: SessionSummary,
) -> Path | None:
    """Append this session to its day's file, creating the file and folder as needed.

    Returns the path written, or None if it could not be written — a summary is
    a record of work that has already happened, so failing to write one must
    never be able to fail the run.
    """
    destination = summary_file_path(summaries_directory, summary.started_at)
    is_new_file = not destination.exists()

    section = render_session_summary(summary)
    body = (render_day_heading(summary.started_at) + "\n" + section) if is_new_file else section

    try:
        summaries_directory.mkdir(parents=True, exist_ok=True)
        with destination.open("a", encoding="utf-8") as summary_handle:
            if not is_new_file:
                summary_handle.write("\n---\n\n")
            summary_handle.write(body)
    except OSError:
        return None

    return destination
