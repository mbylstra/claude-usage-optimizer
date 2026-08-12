#!/usr/bin/env python3
"""Stop any in-flight autonomous work run.

Killing the scheduler alone is not enough. It spawns `claude` as a child, and
the host starts the scheduler in its own session (so the run survives Chrome
tearing the native host down), which means a group signal aimed at the scheduler
does not reliably reach `claude` — it has been observed to outlive one and keep
working. So both are matched by command line, signalled, and then verified.

Stdlib-only and 3.9-compatible for the same reason as `usage-host.py`: this may
be run from contexts where `uv` is not on PATH.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import time

# Matched against full command lines. The scheduler first, so that it does not
# outlive its child and mark the queue entry as an error on the way out.
PROCESS_PATTERNS = [
    re.compile(r"run-autonomous-work\.py"),
    re.compile(r"claude-usage-autonomous-work"),
    re.compile(r"^claude -p |/claude -p "),
]

TERM_GRACE_SECONDS = 3.0
POLL_INTERVAL_SECONDS = 0.25


def running_processes() -> list[tuple[int, str]]:
    """Every process matching a pattern, as (pid, command line)."""
    listing = subprocess.run(
        ["ps", "-Ao", "pid=,command="], capture_output=True, text=True
    ).stdout

    own_pid = str(os.getpid())
    matches: list[tuple[int, str]] = []
    for line in listing.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        pid_text, _, command = stripped.partition(" ")
        if pid_text == own_pid or not pid_text.isdigit():
            continue
        # Never match this script itself, or the shell that launched it.
        if "cancel-autonomous-work" in command:
            continue
        if any(pattern.search(command) for pattern in PROCESS_PATTERNS):
            matches.append((int(pid_text), command))
    return matches


def signal_process(pid: int, which_signal: int) -> None:
    try:
        os.kill(pid, which_signal)
    except ProcessLookupError:
        pass
    except PermissionError:
        print("  not permitted to signal pid {}".format(pid))


def main() -> int:
    targets = running_processes()
    if not targets:
        print("No autonomous work running.")
        return 0

    for pid, command in targets:
        print("Stopping {}  {}".format(pid, command[:90]))
        signal_process(pid, signal.SIGTERM)

    deadline = time.monotonic() + TERM_GRACE_SECONDS
    while time.monotonic() < deadline:
        if not running_processes():
            print("Stopped.")
            return 0
        time.sleep(POLL_INTERVAL_SECONDS)

    # `claude` in particular has been seen to ignore SIGTERM here.
    survivors = running_processes()
    for pid, command in survivors:
        print("Force-killing {}  {}".format(pid, command[:90]))
        signal_process(pid, signal.SIGKILL)

    time.sleep(POLL_INTERVAL_SECONDS * 2)
    remaining = running_processes()
    if remaining:
        print("Still running after SIGKILL: {}".format([pid for pid, _ in remaining]))
        return 1

    print("Stopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
