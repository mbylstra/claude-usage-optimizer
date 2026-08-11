#!/usr/bin/env python3
"""Speak the native-messaging protocol to usage-host.py, without Chrome.

Chrome gives almost no diagnostics when a native host misbehaves — the extension
just sees the connection fail — so being able to exercise the host directly is
the difference between a two-minute fix and an afternoon.

The `runAutonomousWork` case points the host at a harmless stand-in command
rather than the real scheduler, so running these checks never starts a billable
Claude session. The `setAutonomousWorkSettings` case likewise redirects the
settings file, the LaunchAgent path and `launchctl` itself into a temporary
directory, so it never touches the job actually installed on this machine.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HOST_SCRIPT = Path(__file__).resolve().parent / "usage-host.py"

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
        print("  host sent no reply — check .claude-scripts/usage-host.log")
        return None

    (reply_length,) = struct.unpack("=I", host_process.stdout[:4])
    return json.loads(host_process.stdout[4 : 4 + reply_length])


def check(description: str, passed: bool) -> bool:
    print(f"  {'ok  ' if passed else 'FAIL'}  {description}")
    return passed


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
        marker_file = Path(temporary_directory) / "spawned"
        stand_in = Path(temporary_directory) / "stand-in"
        stand_in.write_text(f'#!/bin/bash\ntouch "{marker_file}"\n', encoding="utf-8")
        stand_in.chmod(0o755)

        reply = ask_host(
            {"type": "runAutonomousWork"},
            {"USAGE_HOST_SCHEDULER_COMMAND": str(stand_in)},
        )
        results.append(check("host reports the run started", bool(reply and reply.get("started"))))

        # The child is detached, so give it a moment to actually exec.
        for _ in range(50):
            if marker_file.exists():
                break
            subprocess.run(["sleep", "0.1"])
        results.append(check("scheduler was actually spawned", marker_file.exists()))

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

    print("unknown message:")
    reply = ask_host({"type": "somethingElse"})
    results.append(check("host rejects it without crashing", bool(reply and not reply.get("ok"))))

    print(f"\n{sum(results)}/{len(results)} checks passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
