#!/usr/bin/env python3
"""Autonomous-work settings shared between the extension and the scheduler.

The Chrome extension owns these settings — they are edited in its Settings
screen — but launchd and `run-autonomous-work.py` cannot read `chrome.storage`,
so the native-messaging host mirrors them into
`backend/autonomous-work-settings.json` and this module is the one place
that file's shape is known.

Two consumers with incompatible needs meet here, which is why this module is
importable rather than a CLI:

* `usage-host.py` imports it to apply a settings change the moment the popup
  makes one. That host is spawned by Chrome with an environment we do not
  control, so this module is **stdlib-only and 3.9-compatible**, exactly like
  the host itself. Adding a dependency here breaks the extension in a way that
  is near-undebuggable from inside a browser.
* `run-autonomous-work.py` imports it to find the base directory for new
  projects.

`just install-autonomous-work` runs it as a script, so the launchd job and the
extension always agree on the scheduled time.

Underscores rather than the hyphens the sibling scripts use: this one is
imported, and a hyphen makes that impossible.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field as dataclass_field
from pathlib import Path

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIRECTORY.parent

LAUNCH_AGENT_LABEL = "com.claudeusageoptimizer.autonomouswork"
# The same work with no schedule and --force baked in, for the popup's "Run now"
# to kickstart. launchd takes no arguments when starting a job, so an on-demand
# run that skips the pace gate needs a job definition of its own.
ON_DEMAND_LAUNCH_AGENT_LABEL = LAUNCH_AGENT_LABEL + ".ondemand"

DEFAULT_SCHEDULE_HOUR = 2
DEFAULT_SCHEDULE_MINUTE = 0
# Where a queue prompt with no REPO: line starts its new repository. A parent of
# projects rather than a project, which is why the default is not the old
# `~/code/auto-claude`.
DEFAULT_NEW_PROJECTS_DIRECTORY = "~/code"
DEFAULT_MODEL = "opus"
# Hours, not seconds: the settings screen speaks in hours, and
# `run-autonomous-work.py` is the one place that converts to seconds. A cap on a
# single `claude` call, not on the nightly session — a session can run many
# prompts in a row and is bounded separately, by pace and the usage window.
DEFAULT_MAX_PROMPT_DURATION_HOURS = 5.0
# Appended to every queued prompt before it is sent to `claude -p`. Empty by
# default -- most installs run the queue's prompts unmodified.
DEFAULT_APPEND_TO_ALL_PROMPTS = ""
# Hours, signed: how far ahead of (positive) or behind (negative) an even
# weekly burn still counts as on pace. `run-autonomous-work.py` is the one
# place that converts to milliseconds.
DEFAULT_PACE_THRESHOLD_HOURS = 0.0

# Where the queue lives. `file` is `prompts.txt` at the repository root, which
# needs no account, no network and no third party, and is what a fresh clone
# works with; `jira` is a board — see plans/work-queue-as-a-jira-board.md. The
# two are alternatives and never both live: mirroring one into the other would
# make a stale copy indistinguishable from a real queue, and the run would
# happily execute a prompt deleted from the board yesterday.
QUEUE_SOURCE_FILE = "file"
QUEUE_SOURCE_JIRA = "jira"
QUEUE_SOURCE_NAMES = (QUEUE_SOURCE_FILE, QUEUE_SOURCE_JIRA)
DEFAULT_QUEUE_SOURCE = QUEUE_SOURCE_FILE
DEFAULT_JIRA_PROJECT_KEY = ""
# Per-column overrides for anyone who renamed a column in Jira. Empty means "the
# five names the plan creates". The *credential* deliberately does not travel
# this path — see `queue_source_jira.CREDENTIALS_FILE`.
DEFAULT_JIRA_STATUS_NAMES = {}


def environment_path(name: str, default: Path) -> Path:
    """A path from the environment, expanding `~`, falling back to `default`.

    Public because `autonomous_work_resume.py` declares its own two file paths
    the same overridable way, and the tests rely on every path in this system
    being redirectable.
    """
    raw_value = os.environ.get(name)
    return Path(os.path.expanduser(raw_value)) if raw_value else default


# Overridable so the tests can exercise the real code paths without touching the
# user's actual LaunchAgents directory or spawning a real launchctl.
SETTINGS_FILE = environment_path(
    "AUTONOMOUS_WORK_SETTINGS_FILE", SCRIPT_DIRECTORY / "autonomous-work-settings.json"
)
LAUNCH_AGENT_TEMPLATE_FILE = SCRIPT_DIRECTORY / (LAUNCH_AGENT_LABEL + ".plist")
INSTALLED_LAUNCH_AGENT_FILE = environment_path(
    "AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST",
    Path.home() / "Library" / "LaunchAgents" / (LAUNCH_AGENT_LABEL + ".plist"),
)
ON_DEMAND_LAUNCH_AGENT_TEMPLATE_FILE = SCRIPT_DIRECTORY / (ON_DEMAND_LAUNCH_AGENT_LABEL + ".plist")
# Defaults beside the nightly agent rather than to a path of its own, so the
# tests' override of that one carries both out of the real LaunchAgents folder.
INSTALLED_ON_DEMAND_LAUNCH_AGENT_FILE = environment_path(
    "AUTONOMOUS_WORK_ON_DEMAND_LAUNCH_AGENT_PLIST",
    INSTALLED_LAUNCH_AGENT_FILE.parent / (ON_DEMAND_LAUNCH_AGENT_LABEL + ".plist"),
)
LAUNCHCTL_COMMAND = os.environ.get("AUTONOMOUS_WORK_LAUNCHCTL", "/bin/launchctl")


@dataclass(frozen=True)
class AutonomousWorkSettings:
    """Local wall-clock hour/minute of the nightly run, where new work lands, and which model to use."""

    schedule_hour: int = DEFAULT_SCHEDULE_HOUR
    schedule_minute: int = DEFAULT_SCHEDULE_MINUTE
    new_projects_directory: str = DEFAULT_NEW_PROJECTS_DIRECTORY
    model: str = DEFAULT_MODEL
    max_prompt_duration_hours: float = DEFAULT_MAX_PROMPT_DURATION_HOURS
    append_to_all_prompts: str = DEFAULT_APPEND_TO_ALL_PROMPTS
    pace_threshold_hours: float = DEFAULT_PACE_THRESHOLD_HOURS
    queue_source: str = DEFAULT_QUEUE_SOURCE
    jira_project_key: str = DEFAULT_JIRA_PROJECT_KEY
    """Column key (`todo`, `inReview`, …) to the status name in Jira, where the
    user renamed one. Only the columns actually renamed appear here."""
    jira_status_names: dict = dataclass_field(default_factory=dict)

    @property
    def new_projects_path(self) -> Path:
        """The directory as a usable path — the stored form keeps the user's `~`."""
        return Path(os.path.expanduser(self.new_projects_directory))

    def describe_schedule(self) -> str:
        return "{:02d}:{:02d}".format(self.schedule_hour, self.schedule_minute)


DEFAULT_SETTINGS = AutonomousWorkSettings()


def _coerce_hour_or_minute(value: object, default: int, upper_bound: int) -> int:
    """Clamp anything the file offers into a real clock field.

    The file is user-visible and written by a browser extension, so a wrong type
    or an out-of-range number is a plausible state rather than an impossible one.
    Falling back beats refusing to schedule at all.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    whole_value = int(value)
    if not 0 <= whole_value <= upper_bound:
        return default
    return whole_value


def _coerce_positive_hours(value: object, default: float) -> float:
    """Like `_coerce_hour_or_minute`, but for a positive, possibly-fractional hour count.

    The file is user-visible and written by a browser extension, so a wrong type
    or a non-positive number is a plausible state rather than an impossible one.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    if value <= 0:
        return default
    return float(value)


def _coerce_signed_hours(value: object, default: float) -> float:
    """Like `_coerce_positive_hours`, but for a value where negative and zero are meaningful.

    Used for the pace threshold: negative means "must be behind by at least
    this much," positive means "still on pace even this far ahead." Only a
    wrong type is implausible enough to fall back — any signed value is real.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def parse_settings(settings_data: object) -> AutonomousWorkSettings:
    """Build settings from decoded JSON, falling back per field rather than wholesale."""
    if not isinstance(settings_data, dict):
        return DEFAULT_SETTINGS

    directory_value = settings_data.get("newProjectsDirectory")
    new_projects_directory = (
        directory_value.strip()
        if isinstance(directory_value, str) and directory_value.strip()
        else DEFAULT_NEW_PROJECTS_DIRECTORY
    )

    model_value = settings_data.get("model")
    model = (
        model_value
        if isinstance(model_value, str) and model_value in ("haiku", "sonnet", "opus")
        else DEFAULT_MODEL
    )

    append_to_all_prompts_value = settings_data.get("appendToAllPrompts")
    append_to_all_prompts = (
        append_to_all_prompts_value
        if isinstance(append_to_all_prompts_value, str)
        else DEFAULT_APPEND_TO_ALL_PROMPTS
    )

    queue_source_value = settings_data.get("queueSource")
    queue_source = (
        queue_source_value
        if isinstance(queue_source_value, str) and queue_source_value in QUEUE_SOURCE_NAMES
        else DEFAULT_QUEUE_SOURCE
    )

    project_key_value = settings_data.get("jiraProjectKey")
    jira_project_key = (
        project_key_value.strip().upper()
        if isinstance(project_key_value, str) and project_key_value.strip()
        else DEFAULT_JIRA_PROJECT_KEY
    )

    status_names_value = settings_data.get("jiraStatusNames")
    jira_status_names = (
        {
            column: name.strip()
            for column, name in status_names_value.items()
            if isinstance(column, str) and isinstance(name, str) and name.strip()
        }
        if isinstance(status_names_value, dict)
        else dict(DEFAULT_JIRA_STATUS_NAMES)
    )

    return AutonomousWorkSettings(
        schedule_hour=_coerce_hour_or_minute(
            settings_data.get("scheduleHour"), DEFAULT_SCHEDULE_HOUR, 23
        ),
        schedule_minute=_coerce_hour_or_minute(
            settings_data.get("scheduleMinute"), DEFAULT_SCHEDULE_MINUTE, 59
        ),
        new_projects_directory=new_projects_directory,
        model=model,
        max_prompt_duration_hours=_coerce_positive_hours(
            settings_data.get("maxPromptDurationHours"), DEFAULT_MAX_PROMPT_DURATION_HOURS
        ),
        append_to_all_prompts=append_to_all_prompts,
        pace_threshold_hours=_coerce_signed_hours(
            settings_data.get("paceThresholdHours"), DEFAULT_PACE_THRESHOLD_HOURS
        ),
        queue_source=queue_source,
        jira_project_key=jira_project_key,
        jira_status_names=jira_status_names,
    )


def read_settings() -> AutonomousWorkSettings:
    """The mirrored settings, or the defaults if the extension has never written them."""
    try:
        return parse_settings(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return DEFAULT_SETTINGS


def write_settings(settings: AutonomousWorkSettings) -> None:
    """Replace the settings file atomically.

    The scheduler may be reading it at the moment the popup writes, and a torn
    read would surface as corrupt JSON rather than as an obvious race.
    """
    payload = {
        "scheduleHour": settings.schedule_hour,
        "scheduleMinute": settings.schedule_minute,
        "newProjectsDirectory": settings.new_projects_directory,
        "model": settings.model,
        "maxPromptDurationHours": settings.max_prompt_duration_hours,
        "appendToAllPrompts": settings.append_to_all_prompts,
        "paceThresholdHours": settings.pace_threshold_hours,
        "queueSource": settings.queue_source,
        "jiraProjectKey": settings.jira_project_key,
        "jiraStatusNames": dict(settings.jira_status_names),
    }

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(SETTINGS_FILE.parent), delete=False
        ) as temp_handle:
            json.dump(payload, temp_handle, indent=2)
            temp_handle.write("\n")
            temporary_path = Path(temp_handle.name)
        os.replace(str(temporary_path), str(SETTINGS_FILE))
    except BaseException:
        if temporary_path is not None:
            try:
                os.unlink(str(temporary_path))
            except OSError:
                pass
        raise


def render_launch_agent_plist(settings: AutonomousWorkSettings) -> str:
    """Expand the checked-in template for this machine and this schedule."""
    return render_template(LAUNCH_AGENT_TEMPLATE_FILE, settings)


def render_on_demand_launch_agent_plist() -> str:
    """Expand the on-demand template — the same work, with no time in it."""
    return render_template(ON_DEMAND_LAUNCH_AGENT_TEMPLATE_FILE, DEFAULT_SETTINGS)


def render_template(
    template_file: Path,
    settings: AutonomousWorkSettings,
    extra_replacements: "dict[str, str] | None" = None,
) -> str:
    """Expand a launch-agent template for this machine.

    `extra_replacements` is for placeholders only one template has — the resume
    agent's `__MONTH__` and `__DAY__`, which pin it to a single date. Applied
    after the common ones, and never able to shadow them, since the mapping is
    merged rather than replacing.
    """
    template_text = template_file.read_text(encoding="utf-8")
    replacements = {
        "__PROJECT_ROOT__": str(PROJECT_ROOT),
        "__HOME__": str(Path.home()),
        "__HOUR__": str(settings.schedule_hour),
        "__MINUTE__": str(settings.schedule_minute),
    }
    if extra_replacements:
        replacements.update(extra_replacements)
    for placeholder, value in replacements.items():
        template_text = template_text.replace(placeholder, value)
    return template_text


@dataclass(frozen=True)
class LaunchAgentUpdate:
    """Whether the nightly job now runs at the requested time, and why not if it does not."""

    applied: bool
    detail: str


def install_launch_agent(
    settings: AutonomousWorkSettings, only_if_installed: bool = False
) -> LaunchAgentUpdate:
    """Write the LaunchAgent for `settings` and reload it.

    With `only_if_installed`, a machine that has never run
    `just install-autonomous-work` is left alone: the extension's settings screen
    can change *when* the job runs, but scheduling unattended work that the user
    never asked for is not its call to make.
    """
    if only_if_installed and not INSTALLED_LAUNCH_AGENT_FILE.exists():
        return LaunchAgentUpdate(False, "launch agent not installed")

    INSTALLED_LAUNCH_AGENT_FILE.parent.mkdir(parents=True, exist_ok=True)

    load_result = write_and_load_agent(
        INSTALLED_LAUNCH_AGENT_FILE, render_launch_agent_plist(settings), always_reload=True
    )
    if load_result is not None:
        return LaunchAgentUpdate(False, load_result)

    # The on-demand twin carries no schedule, so saving a new time never needs it
    # reloaded — and reloading it would kill a "Run now" that happened to be in
    # flight. Left alone unless its definition has actually changed.
    on_demand_result = write_and_load_agent(
        INSTALLED_ON_DEMAND_LAUNCH_AGENT_FILE,
        render_on_demand_launch_agent_plist(),
        always_reload=False,
    )
    if on_demand_result is not None:
        return LaunchAgentUpdate(False, on_demand_result)

    return LaunchAgentUpdate(True, "scheduled for {}".format(settings.describe_schedule()))


def write_and_load_agent(
    installed_file: Path, plist_text: str, always_reload: bool
) -> str | None:
    """Put one agent in place and make sure launchd is holding it.

    Public because `autonomous_work_resume.py` installs a third agent and must
    obey the same unload-before-rewrite rule — launchd holds the definition it
    was given, and an in-place edit changes the file and nothing else. That is
    the one thing about launchd easy to get wrong twice, so it is written once.

    Returns an error description, or None on success.
    """
    installed_file.parent.mkdir(parents=True, exist_ok=True)

    if not always_reload and installed_file.exists():
        try:
            unchanged = installed_file.read_text(encoding="utf-8") == plist_text
        except OSError:
            unchanged = False
        if unchanged:
            # Loading an already-loaded job fails harmlessly; unloading it to be
            # tidy would stop whatever it is doing.
            run_launchctl("load", str(installed_file), ignore_failure=True)
            return None

    # Unload before rewriting: launchd holds the job definition it was given, so
    # an in-place edit alone changes the file and nothing else.
    run_launchctl("unload", str(installed_file), ignore_failure=True)
    installed_file.write_text(plist_text, encoding="utf-8")
    return run_launchctl("load", str(installed_file))


def run_launchctl(subcommand: str, plist_path: str, ignore_failure: bool = False) -> str | None:
    """Run one launchctl subcommand; return an error description, or None on success.

    Public alongside `write_and_load_agent`, and for the same reason: it honours
    `AUTONOMOUS_WORK_LAUNCHCTL`, which is what lets the tests exercise the real
    scheduling paths without touching the jobs installed on this machine.
    """
    try:
        completed = subprocess.run(
            [LAUNCHCTL_COMMAND, subcommand, plist_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except OSError as error:
        return None if ignore_failure else "could not run launchctl: {}".format(error)

    if completed.returncode == 0 or ignore_failure:
        return None
    return "launchctl {} failed: {}".format(subcommand, completed.stdout.decode().strip())


def apply_settings(settings: AutonomousWorkSettings) -> LaunchAgentUpdate:
    """Persist settings and reschedule an already-installed nightly job to match."""
    write_settings(settings)
    return install_launch_agent(settings, only_if_installed=True)


def main() -> int:
    import argparse

    argument_parser = argparse.ArgumentParser(description="Manage autonomous-work settings.")
    argument_parser.add_argument(
        "--install",
        action="store_true",
        help="Install (or reinstall) the launchd job at the configured time.",
    )
    arguments = argument_parser.parse_args()

    settings = read_settings()

    if arguments.install:
        result = install_launch_agent(settings)
        print("{}: {}".format(LAUNCH_AGENT_LABEL, result.detail))
        return 0 if result.applied else 1

    print("Scheduled run:      {}".format(settings.describe_schedule()))
    print("New projects in:    {}".format(settings.new_projects_directory))
    print("Model for runs:     {}".format(settings.model))
    print("Max time per prompt: {} hours".format(settings.max_prompt_duration_hours))
    print("Appended to prompts: {!r}".format(settings.append_to_all_prompts))
    print("Pace threshold:      {} hours".format(settings.pace_threshold_hours))
    print("Queue source:       {}".format(settings.queue_source))
    if settings.queue_source == QUEUE_SOURCE_JIRA:
        print("Jira project:       {}".format(settings.jira_project_key or "(not set)"))
        if settings.jira_status_names:
            print("Renamed columns:    {}".format(settings.jira_status_names))
    print("Settings file:      {}".format(SETTINGS_FILE))
    print(
        "Launch agent:       {}".format(
            INSTALLED_LAUNCH_AGENT_FILE
            if INSTALLED_LAUNCH_AGENT_FILE.exists()
            else "not installed"
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
