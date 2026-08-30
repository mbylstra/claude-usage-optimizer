#!/usr/bin/env python3
"""Speak the native-messaging protocol to usage-host.py, without Chrome.

Chrome gives almost no diagnostics when a native host misbehaves — the extension
just sees the connection fail — so being able to exercise the host directly is
the difference between a two-minute fix and an afternoon.

The `runAutonomousWork` and `runFullAutonomousWork` cases point the host at a
harmless stand-in `launchctl` and a stand-in `ps` (so the "a run is already in
flight" guard sees a known state), so running these checks never starts a
billable Claude session. The `setAutonomousWorkSettings` case likewise redirects the
settings file, the LaunchAgent path and `launchctl` itself into a temporary
directory, so it never touches the job actually installed on this machine.
`cancelAutonomousWork` gets the same treatment, and `tailAutonomousRun` runs
against a synthetic events file — including the one genuine race in the design,
where a starting run replaces that file while the tail is reading it.
"""

from __future__ import annotations

import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HOST_SCRIPT = Path(__file__).resolve().parent / "usage-host.py"

REPLY_TIMEOUT_SECONDS = 10

SAMPLE_SNAPSHOT = {
    "fetchedAt": "2026-08-10T02:00:00Z",
    "weeklyPaceDeltaMs": -10_800_000,
    "weeklyPaceStatus": "behind",
    "fiveHourPercent": 45,
    "sevenDayPercent": 62,
    "sevenDayOpusPercent": 10,
}


def ask_host(message: dict, environment_overrides: dict | None = None) -> dict | None:
    """Send one message, return the decoded reply."""
    request = json.dumps(message).encode("utf-8")
    environment = dict(os.environ)
    environment.update(environment_overrides or {})

    host_process = subprocess.run(
        [sys.executable, str(HOST_SCRIPT)],
        input=struct.pack("=I", len(request)) + request,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )

    if host_process.stderr:
        print(f"  host stderr: {host_process.stderr.decode().strip()}")
    if len(host_process.stdout) < 4:
        print("  host sent no reply — check backend/usage-host.log")
        return None

    (reply_length,) = struct.unpack("=I", host_process.stdout[:4])
    return json.loads(host_process.stdout[4 : 4 + reply_length])


class HostSession:
    """A host kept alive across several messages, the way `connectNative` does.

    `ask_host` above runs the host to completion, which cannot exercise anything
    that pushes messages *after* its reply. Replies are drained on a reader
    thread so a missing message shows up as a timeout rather than a hung test.
    """

    def __init__(self, environment_overrides: dict | None = None) -> None:
        environment = dict(os.environ)
        environment.update(environment_overrides or {})
        self.process = subprocess.Popen(
            [sys.executable, str(HOST_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        self.replies: queue.Queue = queue.Queue()
        self.reader = threading.Thread(target=self._read_replies, daemon=True)
        self.reader.start()

    def _read_replies(self) -> None:
        stream = self.process.stdout
        while stream is not None:
            header = stream.read(4)
            if len(header) < 4:
                return
            (length,) = struct.unpack("=I", header)
            payload = stream.read(length)
            if len(payload) < length:
                return
            self.replies.put(json.loads(payload.decode("utf-8")))

    def send(self, message: dict) -> None:
        request = json.dumps(message).encode("utf-8")
        assert self.process.stdin is not None
        self.process.stdin.write(struct.pack("=I", len(request)) + request)
        self.process.stdin.flush()

    def next_message(self, timeout: float = REPLY_TIMEOUT_SECONDS) -> dict | None:
        try:
            return self.replies.get(timeout=timeout)
        except queue.Empty:
            return None

    def next_message_of_type(
        self, message_type: str, timeout: float = REPLY_TIMEOUT_SECONDS
    ) -> dict | None:
        """Skip past whatever else arrives — the tail pushes on its own schedule."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.next_message(timeout=max(0.05, deadline - time.monotonic()))
            if message is None:
                return None
            if message.get("type") == message_type:
                return message
        return None

    def collected_events(self, until_type: str, timeout: float = REPLY_TIMEOUT_SECONDS) -> list:
        """Every event pushed up to and including one of `until_type`."""
        events: list = []
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            message = self.next_message(timeout=max(0.05, deadline - time.monotonic()))
            if message is None:
                break
            if message.get("type") != "runEvents":
                continue
            if message.get("replace"):
                events = []
            events.extend(message.get("events", []))
            if any(event.get("type") == until_type for event in events):
                break
        return events

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def check(description: str, passed: bool) -> bool:
    print(f"  {'ok  ' if passed else 'FAIL'}  {description}")
    return passed


def run_event_line(event_type: str, run_id: str, **fields: object) -> str:
    envelope = {"type": event_type, "runId": run_id, "at": "2026-08-11T12:44:02Z"}
    envelope.update(fields)
    return json.dumps(envelope) + "\n"


def append_line(path: Path, line: str) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.flush()


def check_tail(results: list) -> None:
    """Backfill, live append, and the file being replaced underneath the tail."""
    print("tailAutonomousRun message:")
    with tempfile.TemporaryDirectory() as temporary_directory:
        events_file = Path(temporary_directory) / "run-events.jsonl"
        # Two runs in the file: only the second should be replayed.
        events_file.write_text(
            run_event_line("runStarted", "run-1", prompt="an older run")
            + run_event_line("runFinished", "run-1", outcome="completed", exitCode=0)
            + run_event_line("runStarted", "run-2", prompt="the current run")
            + run_event_line("claudeEvent", "run-2", event={"type": "system", "subtype": "init"}),
            encoding="utf-8",
        )

        session = HostSession({"USAGE_HOST_RUN_EVENT_FILE": str(events_file)})
        try:
            session.send({"type": "tailAutonomousRun"})
            results.append(
                check(
                    "host acknowledges the tail",
                    bool(session.next_message_of_type("tailStarted")),
                )
            )

            backfilled = session.collected_events("claudeEvent")
            results.append(
                check(
                    "backfill replays only the most recent run",
                    [event.get("runId") for event in backfilled] == ["run-2", "run-2"],
                )
            )

            append_line(
                events_file,
                run_event_line("runFinished", "run-2", outcome="completed", exitCode=0),
            )
            appended = session.collected_events("runFinished")
            results.append(
                check(
                    "a new line is pushed as it is written",
                    [event.get("type") for event in appended] == ["runFinished"],
                )
            )

            # What a run start does: the file is replaced, and is shorter than
            # what the tail has already read.
            events_file.write_text(
                run_event_line("runStarted", "run-3", prompt="a new run"), encoding="utf-8"
            )
            after_truncation = session.collected_events("runStarted")
            results.append(
                check(
                    "a truncated file restarts the stream rather than duplicating it",
                    [event.get("runId") for event in after_truncation] == ["run-3"],
                )
            )
        finally:
            session.close()


def check_cancel(results: list) -> None:
    print("cancelAutonomousWork message:")
    with tempfile.TemporaryDirectory() as temporary_directory:
        marker_file = Path(temporary_directory) / "cancelled"
        stand_in = Path(temporary_directory) / "stand-in-cancel.py"
        stand_in.write_text(
            "import pathlib\n"
            f"pathlib.Path({str(marker_file)!r}).write_text('yes')\n"
            "print('Stopping 123  claude -p ...')\nprint('Stopped.')\n",
            encoding="utf-8",
        )

        reply = ask_host(
            {"type": "cancelAutonomousWork"},
            {"USAGE_HOST_CANCEL_COMMAND": str(stand_in)},
        )
        results.append(check("host ran the cancel script", marker_file.exists()))
        results.append(
            check("reply says something was stopped", bool(reply and reply.get("stopped")))
        )
        results.append(
            check(
                "reply carries what was killed",
                bool(reply) and "Stopping 123" in str(reply.get("detail")),
            )
        )

        idle_stand_in = Path(temporary_directory) / "stand-in-idle.py"
        idle_stand_in.write_text("print('No autonomous work running.')\n", encoding="utf-8")
        reply = ask_host(
            {"type": "cancelAutonomousWork"},
            {"USAGE_HOST_CANCEL_COMMAND": str(idle_stand_in)},
        )
        results.append(
            check(
                "an idle machine reports nothing stopped",
                bool(reply) and reply.get("ok") is True and not reply.get("stopped"),
            )
        )


def main() -> int:
    results = []

    print("snapshot message:")
    reply = ask_host({"type": "snapshot", "snapshot": SAMPLE_SNAPSHOT})
    results.append(check("host acknowledges the write", bool(reply and reply.get("ok"))))
    if reply and reply.get("path"):
        written = json.loads(Path(reply["path"]).read_text(encoding="utf-8"))
        results.append(check("file contents round-trip", written == SAMPLE_SNAPSHOT))

    print("runAutonomousWork message:")
    with tempfile.TemporaryDirectory() as temporary_directory:
        # A stand-in launchctl, because the host no longer spawns the scheduler
        # itself: it asks launchd to, so that the run is a child of launchd
        # rather than of Chrome and escapes Chrome's quarantine stamp.
        kickstart_log = Path(temporary_directory) / "launchctl-calls"
        stand_in = Path(temporary_directory) / "launchctl"
        stand_in.write_text(
            f'#!/bin/bash\necho "$@" >> "{kickstart_log}"\n', encoding="utf-8"
        )
        stand_in.chmod(0o755)

        # A stand-in `ps` reporting no scheduler, so the "already in flight" guard
        # does not depend on what happens to be running on the test machine.
        idle_ps = Path(temporary_directory) / "ps-idle"
        idle_ps.write_text("#!/bin/bash\necho COMMAND\n", encoding="utf-8")
        idle_ps.chmod(0o755)
        idle_environment = {
            "USAGE_HOST_LAUNCHCTL": str(stand_in),
            "USAGE_HOST_PS_COMMAND": str(idle_ps),
        }

        reply = ask_host({"type": "runAutonomousWork"}, idle_environment)
        results.append(check("host reports the run started", bool(reply and reply.get("started"))))

        kickstart_calls = kickstart_log.read_text(encoding="utf-8") if kickstart_log.exists() else ""
        results.append(
            check(
                "launchd was asked to start the on-demand job",
                "kickstart" in kickstart_calls
                and "com.claudeusageoptimizer.autonomouswork.ondemand" in kickstart_calls,
            )
        )

        # "Trigger a full run" kicks the nightly label itself, not the .ondemand
        # one, so a manual full run is pace-gated and drains the queue like 2 AM.
        full_kickstart_log = Path(temporary_directory) / "launchctl-calls-full"
        full_stand_in = Path(temporary_directory) / "launchctl-full"
        full_stand_in.write_text(
            f'#!/bin/bash\necho "$@" >> "{full_kickstart_log}"\n', encoding="utf-8"
        )
        full_stand_in.chmod(0o755)
        reply = ask_host(
            {"type": "runFullAutonomousWork"},
            {"USAGE_HOST_LAUNCHCTL": str(full_stand_in), "USAGE_HOST_PS_COMMAND": str(idle_ps)},
        )
        results.append(
            check("host reports the full run started", bool(reply and reply.get("started")))
        )
        full_kickstart_calls = (
            full_kickstart_log.read_text(encoding="utf-8") if full_kickstart_log.exists() else ""
        )
        results.append(
            check(
                "launchd was asked to start the nightly job, not the on-demand one",
                "kickstart" in full_kickstart_calls
                and "com.claudeusageoptimizer.autonomouswork" in full_kickstart_calls
                and ".ondemand" not in full_kickstart_calls,
            )
        )

        # A scheduler already running blocks both buttons: launchd only stops a
        # duplicate of one label, and the two use different labels.
        busy_ps = Path(temporary_directory) / "ps-busy"
        busy_ps.write_text(
            "#!/bin/bash\necho 'uv run --script /x/backend/run-autonomous-work.py'\n",
            encoding="utf-8",
        )
        busy_ps.chmod(0o755)
        for busy_message in ("runAutonomousWork", "runFullAutonomousWork"):
            reply = ask_host(
                {"type": busy_message},
                {"USAGE_HOST_LAUNCHCTL": str(stand_in), "USAGE_HOST_PS_COMMAND": str(busy_ps)},
            )
            results.append(
                check(
                    f"{busy_message} is refused while a run is in flight",
                    bool(
                        reply
                        and not reply.get("ok")
                        and "in flight" in reply.get("error", "")
                    ),
                )
            )

        # A label launchd has never heard of must be told apart from a real
        # failure, since it means `just install-autonomous-work` was never run.
        missing_agent_launchctl = Path(temporary_directory) / "launchctl-missing"
        missing_agent_launchctl.write_text("#!/bin/bash\nexit 113\n", encoding="utf-8")
        missing_agent_launchctl.chmod(0o755)
        reply = ask_host(
            {"type": "runAutonomousWork"},
            {
                "USAGE_HOST_LAUNCHCTL": str(missing_agent_launchctl),
                "USAGE_HOST_PS_COMMAND": str(idle_ps),
            },
        )
        results.append(
            check(
                "an uninstalled agent is reported as such",
                bool(reply and not reply.get("ok") and "not installed" in reply.get("error", "")),
            )
        )

    print("primeFolderAccess message:")
    with tempfile.TemporaryDirectory() as temporary_directory:
        marker_file = Path(temporary_directory) / "asked"
        stand_in = Path(temporary_directory) / "stand-in.py"
        # A real uv script, because the host runs this one through `uv run
        # --script` rather than executing it — the point of the check is that
        # the whole chain reaches a Python process, since that is what macOS
        # attributes the folder request to.
        stand_in.write_text(
            "# /// script\n"
            "# requires-python = \">=3.10\"\n"
            "# dependencies = []\n"
            "# ///\n"
            "import pathlib\n"
            f'pathlib.Path(r"{marker_file}").write_text("asked")\n',
            encoding="utf-8",
        )

        reply = ask_host(
            {"type": "primeFolderAccess"},
            {"USAGE_HOST_FOLDER_ACCESS_SCRIPT": str(stand_in)},
        )
        results.append(
            check("host reports the prompting started", bool(reply and reply.get("started")))
        )

        # Detached, and uv has an interpreter to resolve, so allow longer.
        for _ in range(150):
            if marker_file.exists():
                break
            subprocess.run(["sleep", "0.1"])
        results.append(check("folder check was actually spawned", marker_file.exists()))

    print("setAutonomousWorkSettings message (no launch agent installed):")
    with tempfile.TemporaryDirectory() as temporary_directory:
        settings_file = Path(temporary_directory) / "settings.json"
        plist_file = Path(temporary_directory) / "agent.plist"
        launchctl_log = Path(temporary_directory) / "launchctl-calls"
        fake_launchctl = Path(temporary_directory) / "launchctl"
        fake_launchctl.write_text(
            f'#!/bin/bash\necho "$@" >> "{launchctl_log}"\n', encoding="utf-8"
        )
        fake_launchctl.chmod(0o755)

        overrides = {
            "AUTONOMOUS_WORK_SETTINGS_FILE": str(settings_file),
            "AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST": str(plist_file),
            "AUTONOMOUS_WORK_LAUNCHCTL": str(fake_launchctl),
        }
        settings_message = {
            "type": "setAutonomousWorkSettings",
            "settings": {
                "scheduleHour": 3,
                "scheduleMinute": 30,
                "newProjectsDirectory": "~/code/experiments",
            },
        }

        reply = ask_host(settings_message, overrides)
        results.append(check("host stores the settings", bool(reply and reply.get("ok"))))
        results.append(
            check("no launch agent is created behind the user's back", not plist_file.exists())
        )
        results.append(
            check("reply says nothing was rescheduled", bool(reply) and not reply.get("launchAgentUpdated"))
        )
        if settings_file.exists():
            stored = json.loads(settings_file.read_text(encoding="utf-8"))
            results.append(
                check(
                    "settings round-trip",
                    stored
                    == {
                        "scheduleHour": 3,
                        "scheduleMinute": 30,
                        "newProjectsDirectory": "~/code/experiments",
                        # Not sent in settings_message above — parse_settings fills
                        # these in from defaults, and write_settings persists them.
                        "model": "opus",
                        "maxPromptDurationHours": 5.0,
                        "appendToAllPrompts": "",
                        "paceThresholdHours": 0.0,
                        "resumeAfterFiveHourResetEnabled": True,
                        "queueSource": "file",
                        "jiraProjectKey": "",
                        "jiraStatusNames": {},
                        "repositories": [],
                    },
                )
            )

        print("setAutonomousWorkSettings message (launch agent installed):")
        plist_file.write_text("placeholder\n", encoding="utf-8")
        reply = ask_host(settings_message, overrides)
        results.append(
            check("reply says the job was rescheduled", bool(reply and reply.get("launchAgentUpdated")))
        )
        rewritten_plist = plist_file.read_text(encoding="utf-8")
        results.append(
            check("plist carries the new time", "<integer>3</integer>" in rewritten_plist)
        )
        results.append(
            check("plist has no placeholders left", "__" not in rewritten_plist)
        )
        launchctl_calls = (
            launchctl_log.read_text(encoding="utf-8") if launchctl_log.exists() else ""
        )
        results.append(
            check(
                "launchd was told to reload",
                "unload" in launchctl_calls and "load" in launchctl_calls,
            )
        )

    check_tail(results)
    check_cancel(results)

    print("unknown message:")
    reply = ask_host({"type": "somethingElse"})
    results.append(check("host rejects it without crashing", bool(reply and not reply.get("ok"))))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
