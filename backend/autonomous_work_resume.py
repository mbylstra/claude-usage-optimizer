#!/usr/bin/env python3
"""The one-shot launch agent that picks the queue back up after a 5-hour reset.

A session that runs into the 5-hour session window stops, because that window
does not refill early and waiting it out would hold a process idle for hours.
But the window *does* refill, at a knowable time, often only two or three hours
away — so instead of waiting, the run asks launchd to start it again shortly
afterwards. Design and rationale: `plans/resume-after-five-hour-reset.md`.

This module owns two things and nothing else knows either: the shape of
`backend/autonomous-work-resume.json`, and the lifecycle of the third launch
agent, `com.claudeusageoptimizer.autonomouswork.resume`.

**One resume per day, and never from a resume.** A resumed run schedules
nothing further, so a stale snapshot cannot start a chain that walks through the
following day — see the plan's §3 before relaxing that. Enforcing it is why a
served resume is *stamped* rather than deleted: the record that today already
had one has to outlive the schedule it describes.

Stdlib-only and 3.9-compatible, like its siblings — `cancel-autonomous-work.py`
imports it and runs under whatever `python3` the machine has. Underscores rather
than the hyphens the sibling scripts use, because a hyphen makes a module
unimportable.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIRECTORY))

import autonomous_work_settings  # noqa: E402  (must follow the sys.path line above)

RESUME_LAUNCH_AGENT_LABEL = autonomous_work_settings.LAUNCH_AGENT_LABEL + ".resume"

RESUME_LAUNCH_AGENT_TEMPLATE_FILE = SCRIPT_DIRECTORY / (RESUME_LAUNCH_AGENT_LABEL + ".plist")
# Defaults beside the nightly agent rather than to a path of its own, so a test
# that redirects that one carries this out of the real LaunchAgents folder too —
# the same arrangement the on-demand agent uses.
INSTALLED_RESUME_LAUNCH_AGENT_FILE = autonomous_work_settings.environment_path(
    "AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST",
    autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.parent
    / (RESUME_LAUNCH_AGENT_LABEL + ".plist"),
)
RESUME_STATE_FILE = autonomous_work_settings.environment_path(
    "AUTONOMOUS_WORK_RESUME_STATE_FILE", SCRIPT_DIRECTORY / "autonomous-work-resume.json"
)

# How long after its scheduled moment a pending resume is still worth serving.
# Past that it is a stray fire — a machine that was asleep or powered off, or a
# year-old agent nobody cleaned up — and the nightly run picks the queue up as
# it always would.
STALE_RESUME_GRACE_SECONDS = 3600


@dataclass(frozen=True)
class PendingResume:
    """A resume this machine has been asked to run, served or not."""

    scheduled_for: datetime
    scheduled_at: datetime
    """Why the run ended: "sessionLimit" or "fiveHourExhausted"."""
    reason: str
    """Where the reset time came from: "cliNotice", "snapshot" or "fallback"."""
    source: str
    """Set when a resume run consumed this, which is also the record that today already had one."""
    served_at: datetime | None = None


@dataclass(frozen=True)
class ResumeUpdate:
    """Whether launchd is now holding the resume, and why not if it is not."""

    applied: bool
    detail: str


@dataclass(frozen=True)
class ResumeConsumption:
    """What `--resume` found waiting for it, and a sentence for the log if nothing was.

    The detail matters: "no state file", "already served" and "scheduled for
    hours ago" are three different situations, and a run that logged one line
    for all three would make a genuine bug look like a stray fire.
    """

    pending: PendingResume | None
    detail: str


# --------------------------------------------------------------------------- #
# The state file
# --------------------------------------------------------------------------- #


def _parse_moment(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _format_moment(moment: datetime) -> str:
    """Local wall-clock with an offset, so a file read months later is unambiguous."""
    return (moment if moment.tzinfo is not None else moment.astimezone()).isoformat()


def parse_resume_state(state_data: object) -> PendingResume | None:
    """A record from decoded JSON, or None if the file cannot be believed.

    Both timestamps are required. A record missing either cannot be checked
    against the clock, and every guard in this module is a clock comparison.
    """
    if not isinstance(state_data, dict):
        return None

    scheduled_for = _parse_moment(state_data.get("scheduledFor"))
    scheduled_at = _parse_moment(state_data.get("scheduledAt"))
    if scheduled_for is None or scheduled_at is None:
        return None

    reason = state_data.get("reason")
    source = state_data.get("source")
    return PendingResume(
        scheduled_for=scheduled_for,
        scheduled_at=scheduled_at,
        reason=reason if isinstance(reason, str) else "unknown",
        source=source if isinstance(source, str) else "unknown",
        served_at=_parse_moment(state_data.get("servedAt")),
    )


def read_resume_state() -> PendingResume | None:
    """The recorded resume, served or not — `read_pending_resume` for only the live one."""
    try:
        return parse_resume_state(json.loads(RESUME_STATE_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None


def write_resume_state(pending: PendingResume) -> None:
    """Replace the state file atomically.

    A resume run may be reading it at the moment a scheduling run writes, and a
    torn read would surface as corrupt JSON rather than as an obvious race —
    the same reason `write_settings` does this.
    """
    payload = {
        "scheduledFor": _format_moment(pending.scheduled_for),
        "scheduledAt": _format_moment(pending.scheduled_at),
        "reason": pending.reason,
        "source": pending.source,
        "servedAt": None if pending.served_at is None else _format_moment(pending.served_at),
    }

    temporary_path = None
    try:
        RESUME_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(RESUME_STATE_FILE.parent), delete=False
        ) as temp_handle:
            json.dump(payload, temp_handle, indent=2)
            temp_handle.write("\n")
            temporary_path = Path(temp_handle.name)
        os.replace(str(temporary_path), str(RESUME_STATE_FILE))
    except BaseException:
        if temporary_path is not None:
            try:
                os.unlink(str(temporary_path))
            except OSError:
                pass
        raise


def read_pending_resume() -> PendingResume | None:
    """The resume still waiting to be served — None once one has been."""
    state = read_resume_state()
    return None if state is None or state.served_at is not None else state


def resume_scheduled_today(now: datetime) -> bool:
    """Has today already had its one resume — whether or not it has run yet?

    Served or pending both count. The rule is one *scheduling decision* per day,
    not one firing: a resume scheduled at 2 AM and served at 6 AM has spent the
    day's allowance either way.
    """
    state = read_resume_state()
    if state is None:
        return False
    return state.scheduled_at.astimezone().date() == now.astimezone().date()


def consume_pending_resume(now: datetime) -> ResumeConsumption:
    """Claim the pending resume for a run starting now, stamping it served.

    Stamped rather than deleted, because the stamp is half of the one-per-day
    rule (see the module docstring). Three things make a `--resume` a no-op, and
    each is named in the detail so the log can tell them apart: no state at all,
    one already served, and one whose moment is long past — a Mac that was
    asleep, or the year-later firing of an agent nobody cleaned up.
    """
    state = read_resume_state()
    if state is None:
        return ResumeConsumption(None, "no resume was pending")
    if state.served_at is not None:
        return ResumeConsumption(
            None, "the pending resume was already served at {}".format(state.served_at)
        )
    if now - state.scheduled_for > timedelta(seconds=STALE_RESUME_GRACE_SECONDS):
        return ResumeConsumption(
            None,
            "the pending resume was due at {} — too long ago to act on".format(state.scheduled_for),
        )

    served = PendingResume(
        scheduled_for=state.scheduled_for,
        scheduled_at=state.scheduled_at,
        reason=state.reason,
        source=state.source,
        served_at=now,
    )
    try:
        write_resume_state(served)
    except OSError as error:
        # Better to run the work than to refuse it over a bookkeeping failure —
        # the worst case is that a later stray fire is not recognised as one,
        # and its own pace gate still applies.
        return ResumeConsumption(served, "could not stamp the resume as served: {}".format(error))

    return ResumeConsumption(served, "serving the resume scheduled at {}".format(state.scheduled_at))


# --------------------------------------------------------------------------- #
# The launch agent
# --------------------------------------------------------------------------- #


def render_resume_launch_agent_plist(fire_at: datetime) -> str:
    """Expand the template, pinned to one date and minute — see the template's comment."""
    return autonomous_work_settings.render_template(
        RESUME_LAUNCH_AGENT_TEMPLATE_FILE,
        autonomous_work_settings.DEFAULT_SETTINGS,
        extra_replacements={
            "__MONTH__": str(fire_at.month),
            "__DAY__": str(fire_at.day),
            "__HOUR__": str(fire_at.hour),
            "__MINUTE__": str(fire_at.minute),
        },
    )


def schedule_resume(pending: PendingResume) -> ResumeUpdate:
    """Install the one-shot agent for `pending`, then record it.

    The plist first and the state file second, because the state file is what
    makes a firing legitimate: an agent with no state behind it is a no-op,
    where state with no agent behind it would be a resume that silently never
    comes.
    """
    fire_at = pending.scheduled_for.astimezone()

    try:
        plist_text = render_resume_launch_agent_plist(fire_at)
    except OSError as error:
        return ResumeUpdate(False, "could not read the resume agent template: {}".format(error))

    load_result = autonomous_work_settings.write_and_load_agent(
        INSTALLED_RESUME_LAUNCH_AGENT_FILE, plist_text, always_reload=True
    )
    if load_result is not None:
        return ResumeUpdate(False, load_result)

    try:
        write_resume_state(pending)
    except OSError as error:
        return ResumeUpdate(False, "could not record the pending resume: {}".format(error))

    return ResumeUpdate(True, "resuming at {:%H:%M}".format(fire_at))


def cancel_resume() -> bool:
    """Unschedule any pending resume and forget it. True if there was one.

    Called by `just cancel-autonomous-resume` and by the cancel script:
    cancelling a run and then having it silently restart itself a few hours
    later is not what anybody means by cancel.
    """
    had_agent = INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists()
    had_state = RESUME_STATE_FILE.exists()

    if had_agent:
        autonomous_work_settings.run_launchctl(
            "unload", str(INSTALLED_RESUME_LAUNCH_AGENT_FILE), ignore_failure=True
        )
        try:
            INSTALLED_RESUME_LAUNCH_AGENT_FILE.unlink()
        except OSError:
            pass

    if had_state:
        try:
            RESUME_STATE_FILE.unlink()
        except OSError:
            pass

    return had_agent or had_state


def describe_pending_resume() -> str:
    """One paragraph for `just autonomous-resume-status`."""
    state = read_resume_state()
    if state is None:
        return "No resume is scheduled."

    lines = [
        "Scheduled for: {:%Y-%m-%d %H:%M}".format(state.scheduled_for.astimezone()),
        "Decided at:    {:%Y-%m-%d %H:%M}".format(state.scheduled_at.astimezone()),
        "Because:       {} (reset time {})".format(state.reason, state.source),
        "Served:        {}".format(
            "not yet"
            if state.served_at is None
            else "{:%Y-%m-%d %H:%M}".format(state.served_at.astimezone())
        ),
        "Launch agent:  {}".format(
            INSTALLED_RESUME_LAUNCH_AGENT_FILE
            if INSTALLED_RESUME_LAUNCH_AGENT_FILE.exists()
            else "not installed"
        ),
    ]
    return "\n".join(lines)


def main() -> int:
    import argparse

    argument_parser = argparse.ArgumentParser(description="Inspect or clear a pending resume.")
    argument_parser.add_argument(
        "--cancel", action="store_true", help="Unschedule any pending resume."
    )
    arguments = argument_parser.parse_args()

    if arguments.cancel:
        print("Cleared the pending resume." if cancel_resume() else "No resume was scheduled.")
        return 0

    print(describe_pending_resume())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
