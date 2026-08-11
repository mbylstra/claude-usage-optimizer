#!/usr/bin/env python3
"""Chrome native-messaging host: persists the usage snapshot next to this file.

Chrome spawns this with stdin/stdout wired to the extension. The protocol is a
native-byte-order uint32 length followed by that many bytes of UTF-8 JSON, in
both directions.

**stdout belongs to the protocol.** A stray `print` corrupts the stream and the
extension sees the host die for no visible reason, so everything diagnostic goes
to `usage-host.log` instead.

Deliberately stdlib-only and 3.9-compatible: Chrome starts this process with an
environment we do not control, so depending on `uv` or any installed package
would make it fail in ways that are painful to debug from inside a browser.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# A sibling module, and importable only because Python puts this script's own
# directory on sys.path. Chrome may spawn us from anywhere, so nothing here can
# rely on the working directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

import autonomous_work_settings  # noqa: E402  (must follow the sys.path line above)

HOST_DIRECTORY = Path(__file__).resolve().parent
SNAPSHOT_FILE = HOST_DIRECTORY / "claude-usage.json"
LOG_FILE = HOST_DIRECTORY / "usage-host.log"
# Overridable so the spawn path can be exercised without starting a real (and
# billable) Claude session — see test-usage-host.py.
SCHEDULER_COMMAND = os.environ.get(
    "USAGE_HOST_SCHEDULER_COMMAND", str(HOST_DIRECTORY / "claude-usage-autonomous-work")
)

MESSAGE_TYPE_SNAPSHOT = "snapshot"
MESSAGE_TYPE_RUN_WORK = "runAutonomousWork"
MESSAGE_TYPE_SET_SETTINGS = "setAutonomousWorkSettings"

# Chrome spawns this process with its own environment, which will not have the
# user's shell PATH. `uv` and `claude` live in these directories.
EXTRA_PATH_DIRECTORIES = [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin"]

# A usage snapshot is a few hundred bytes; anything near this is a bug or an
# attempt to exhaust memory, and reading it would be the wrong move either way.
MAX_MESSAGE_BYTES = 1024 * 1024


def log_message(message):
    # type: (str) -> None
    try:
        with LOG_FILE.open("a", encoding="utf-8") as log_handle:
            log_handle.write("{:%Y-%m-%d %H:%M:%S}: {}\n".format(datetime.now(), message))
    except OSError:
        pass  # There is nowhere left to complain to; stdout is not ours.


def read_message():
    # type: () -> object
    """Return the next message, or None at end of stream."""
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None

    (payload_length,) = struct.unpack("=I", header)
    if payload_length > MAX_MESSAGE_BYTES:
        log_message("Refusing oversized message ({} bytes)".format(payload_length))
        return None

    payload = sys.stdin.buffer.read(payload_length)
    if len(payload) < payload_length:
        log_message("Truncated message")
        return None

    return json.loads(payload.decode("utf-8"))


def write_message(message):
    # type: (dict) -> None
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def write_snapshot(snapshot):
    # type: (object) -> None
    """Replace the snapshot file atomically.

    The scheduler may read this at any moment, and a torn read would look like
    corrupt JSON rather than an obvious race, so the write goes to a temp file in
    the same directory and is renamed over the target.
    """
    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(HOST_DIRECTORY), delete=False
        ) as temp_handle:
            json.dump(snapshot, temp_handle, indent=2)
            temp_handle.write("\n")
            temporary_path = Path(temp_handle.name)
        os.replace(str(temporary_path), str(SNAPSHOT_FILE))
    except BaseException:
        if temporary_path is not None:
            try:
                os.unlink(str(temporary_path))
            except OSError:
                pass
        raise


def spawn_environment():
    # type: () -> dict
    environment = dict(os.environ)
    existing_path = environment.get("PATH", "")
    search_path = list(EXTRA_PATH_DIRECTORIES)
    if existing_path:
        search_path.append(existing_path)
    environment["PATH"] = os.pathsep.join(search_path)
    return environment


def start_autonomous_work():
    # type: () -> None
    """Launch the scheduler detached, and return without waiting for it.

    Chrome tears this host down as soon as it has its reply, and the work can run
    for the better part of an hour, so the child gets its own session and its own
    log rather than inheriting a pipe that is about to close.
    """
    log_handle = LOG_FILE.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [SCHEDULER_COMMAND, "--force"],
            cwd=str(HOST_DIRECTORY.parent),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
            env=spawn_environment(),
        )
    finally:
        log_handle.close()


def apply_autonomous_work_settings(message):
    # type: (dict) -> dict
    """Mirror the extension's settings to disk and reschedule the launchd job.

    Reports `launchAgentUpdated` separately from `ok`: settings are always
    stored, but a machine that never ran `just install-autonomous-work` has no
    job to reschedule, and the popup says so rather than implying the new time
    will be honoured.
    """
    settings = autonomous_work_settings.parse_settings(message.get("settings"))
    result = autonomous_work_settings.apply_settings(settings)

    log_message(
        "Settings updated: run at {}, new projects in {} ({})".format(
            settings.describe_schedule(), settings.new_projects_directory, result.detail
        )
    )

    return {
        "ok": True,
        "launchAgentUpdated": result.applied,
        "detail": result.detail,
        "scheduledFor": settings.describe_schedule(),
    }


def handle_message(message):
    # type: (dict) -> dict
    message_type = message.get("type")

    if message_type == MESSAGE_TYPE_SET_SETTINGS:
        return apply_autonomous_work_settings(message)

    if message_type == MESSAGE_TYPE_RUN_WORK:
        start_autonomous_work()
        log_message("Started autonomous work on request from the popup")
        return {"ok": True, "started": True}

    if message_type == MESSAGE_TYPE_SNAPSHOT:
        write_snapshot(message.get("snapshot"))
        return {"ok": True, "path": str(SNAPSHOT_FILE)}

    log_message("Ignoring unknown message type {!r}".format(message_type))
    return {"ok": False, "error": "unknown message type"}


def main():
    # type: () -> int
    while True:
        try:
            message = read_message()
        except (ValueError, struct.error) as error:
            log_message("Unreadable message: {}".format(error))
            return 1

        if message is None:
            return 0  # Clean end of stream — Chrome closed the pipe.

        if not isinstance(message, dict):
            write_message({"ok": False, "error": "message was not an object"})
            continue

        try:
            write_message(handle_message(message))
        except Exception as error:  # noqa: BLE001 — see below
            # Deliberately broad. Dying here costs the extension its connection
            # and shows up as nothing more than "host disconnected", so any
            # failure is worth more as a logged reply than as a traceback into a
            # stderr nobody reads.
            log_message("Failed handling message: {!r}".format(error))
            write_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    sys.exit(main())
