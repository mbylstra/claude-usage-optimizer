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

Two ways in. `sendNativeMessage` spawns a process per message for the snapshot
and settings writes; `connectNative` holds one open for as long as the run-log
window is, and `tailAutonomousRun` then pushes events up that port unsolicited.
Chrome spawns a separate process per connection, so the two never interfere.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
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
# "Run now" asks launchd to start the job rather than spawning it here, so that
# the run is not a descendant of Chrome — see start_autonomous_work. Overridable
# so that path can be exercised without starting a real (and billable) Claude
# session — see test-usage-host.py.
LAUNCHCTL_COMMAND = os.environ.get("USAGE_HOST_LAUNCHCTL", "/bin/launchctl")
ON_DEMAND_LAUNCH_AGENT_LABEL = autonomous_work_settings.ON_DEMAND_LAUNCH_AGENT_LABEL
# `launchctl kickstart` for a label launchd has never been given. Worth telling
# apart from a real failure: it means the agent was never installed.
LAUNCHCTL_NO_SUCH_SERVICE = 113
# The structured record `run-autonomous-work.py` writes, and the only channel
# between a run on disk and a window in the browser: MV3 has no filesystem API.
RUN_EVENT_FILE = Path(
    os.environ.get("USAGE_HOST_RUN_EVENT_FILE", str(HOST_DIRECTORY / "autonomous-run-events.jsonl"))
)
# Reads each protected folder in turn so macOS raises its permission dialog for
# each one. Spawned from here rather than run by `just`, because a prompt only
# appears when Chrome is in the chain — see README, "Protected folders".
FOLDER_ACCESS_SCRIPT = os.environ.get(
    "USAGE_HOST_FOLDER_ACCESS_SCRIPT", str(HOST_DIRECTORY / "check-folder-access.py")
)
# Run with this interpreter rather than executed, so the same path works whether
# or not the file happens to be marked executable. The override is a Python
# script too, for the same reason.
CANCEL_SCRIPT = os.environ.get(
    "USAGE_HOST_CANCEL_COMMAND", str(HOST_DIRECTORY / "cancel-autonomous-work.py")
)

MESSAGE_TYPE_SNAPSHOT = "snapshot"
MESSAGE_TYPE_RUN_WORK = "runAutonomousWork"
MESSAGE_TYPE_SET_SETTINGS = "setAutonomousWorkSettings"
MESSAGE_TYPE_TAIL_RUN = "tailAutonomousRun"
MESSAGE_TYPE_CANCEL_WORK = "cancelAutonomousWork"
MESSAGE_TYPE_PRIME_FOLDERS = "primeFolderAccess"

# A stat loop rather than a filesystem-watch API: stdlib-only and 3.9-compatible
# is non-negotiable here, and kqueue plumbing would be an order of magnitude more
# code than this for a file that grows a few times a second at most.
RUN_EVENT_POLL_SECONDS = 0.25
# Replaying a long run on connect can be thousands of events, and one enormous
# message is both a memory spike and a stall; the viewer appends batches happily.
RUN_EVENT_BATCH_SIZE = 200
# The two events that begin a run: one for work that ran, one for a night the
# pace gate declined to.
RUN_BOUNDARY_EVENT_TYPES = ("runStarted", "runSkipped")
# Cancelling SIGTERMs, waits, then SIGKILLs, so it is not instant — but it must
# not hang the host either.
CANCEL_TIMEOUT_SECONDS = 30

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


# Until the tail existed only the main thread wrote replies. Two threads writing
# a length-prefixed frame each would interleave them, and a corrupt stream is
# indistinguishable — from the extension's side — from the host crashing.
STDOUT_LOCK = threading.Lock()


def write_message(message):
    # type: (dict) -> None
    encoded = json.dumps(message).encode("utf-8")
    with STDOUT_LOCK:
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
    # type: () -> dict
    """Ask launchd to start the run, rather than spawning it here.

    Spawning it here is fewer moving parts and was how this worked first, but
    everything this host starts is a descendant of Chrome, and macOS stamps
    com.apple.quarantine on files written by any descendant of a quarantine-aware
    app. That catches the ad-hoc-signed .node module `claude` unpacks the first
    time a prompt touches an image: loading it then needs an "Apple could not
    verify..." dialog dismissed, and the run stalls until somebody does.

    Handing the job to launchd costs a second launch agent — one cannot pass
    --force to `launchctl kickstart`, so the on-demand definition carries it —
    and in exchange the run has launchd as its parent, exactly like the nightly
    one. Same ancestry, same quarantine (none), same folder permissions, so what
    the button does is what 2 AM does.

    It reports only whether the run *started*; the work outlives this reply by up
    to an hour and reports into autonomous-work.log and the run event stream,
    which the run-log window tails regardless of who started the run.
    """
    target = "gui/{}/{}".format(os.getuid(), ON_DEMAND_LAUNCH_AGENT_LABEL)
    try:
        completed = subprocess.run(
            [LAUNCHCTL_COMMAND, "kickstart", target],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=spawn_environment(),
        )
    except OSError as error:
        return {"ok": False, "error": "could not run launchctl: {}".format(error)}

    if completed.returncode == 0:
        return {"ok": True, "started": True}

    detail = completed.stdout.decode("utf-8", "replace").strip()
    if completed.returncode == LAUNCHCTL_NO_SUCH_SERVICE:
        return {
            "ok": False,
            "error": "the on-demand launch agent is not installed — "
            "run 'just install-autonomous-work'",
        }
    return {"ok": False, "error": detail or "launchctl kickstart failed"}


def start_folder_access_prompts():
    # type: () -> dict
    """Touch each protected folder so macOS asks the user about it, once.

    Detached and unwaited like a work run: every folder that is not already
    granted puts up a dialog, and the user may take as long as they like over
    them. The reply says only that the prompting started.
    """
    # The frozen copy first: the dialogs this raises attach a permission to
    # whichever binary macOS decides to name, and that copy is the one the
    # nightly job will still be running after uv is next upgraded.
    private_uv = HOST_DIRECTORY / "bin" / "claude-usage-optimizer-uv"
    if private_uv.is_file() and os.access(str(private_uv), os.X_OK):
        uv_command = str(private_uv)
    else:
        uv_command = shutil.which("uv", path=spawn_environment()["PATH"])
    if uv_command is None:
        return {"ok": False, "error": "uv not found on PATH"}

    log_handle = LOG_FILE.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [uv_command, "run", "--script", FOLDER_ACCESS_SCRIPT],
            cwd=str(HOST_DIRECTORY.parent),
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=log_handle,
            start_new_session=True,
            env=spawn_environment(),
        )
    finally:
        log_handle.close()
    return {"ok": True, "started": True}


def cancel_autonomous_work():
    # type: () -> dict
    """Stop an in-flight run, reporting what was actually killed.

    A plain kill of the scheduler is not enough — see `cancel-autonomous-work.py`
    — so this defers to that script rather than signalling anything itself.
    """
    try:
        cancel_process = subprocess.run(
            [sys.executable, CANCEL_SCRIPT],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=CANCEL_TIMEOUT_SECONDS,
            env=spawn_environment(),
        )
    except subprocess.TimeoutExpired:
        log_message("Cancel script timed out")
        return {"type": "cancelResult", "ok": False, "error": "cancelling timed out"}

    detail = cancel_process.stdout.decode("utf-8", "replace").strip()
    # The script says so in as many words when it found nothing to stop, and the
    # difference matters to the button: "stopped" and "nothing was running" are
    # different answers to the same click.
    stopped = cancel_process.returncode == 0 and "No autonomous work running" not in detail

    log_message("Cancel requested: {}".format(detail.replace("\n", " / ") or "(no output)"))
    return {"type": "cancelResult", "ok": True, "stopped": stopped, "detail": detail}


# --------------------------------------------------------------------------- #
# Tailing the run event stream
# --------------------------------------------------------------------------- #


def parse_event_lines(text):
    # type: (str) -> list
    """Whole events from a block of the file, dropping anything unreadable.

    A partially written last line is the normal case when tailing, so a line that
    does not parse is skipped rather than treated as an error.
    """
    events = []
    for line in text.splitlines():
        stripped_line = line.strip()
        if not stripped_line:
            continue
        try:
            event = json.loads(stripped_line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def most_recent_run(events):
    # type: (list) -> list
    """Just the last run's events — the viewer shows one run, never a history."""
    for index in range(len(events) - 1, -1, -1):
        if events[index].get("type") in RUN_BOUNDARY_EVENT_TYPES:
            return events[index:]
    # No boundary at all: a file written by an older build, or one trimmed to
    # nothing. Showing what is there beats showing nothing.
    return events


def send_run_events(events, replace):
    # type: (list, bool) -> None
    """Push events to the extension, batched, `replace` set on the first batch only."""
    batches = [
        events[start : start + RUN_EVENT_BATCH_SIZE]
        for start in range(0, len(events), RUN_EVENT_BATCH_SIZE)
    ]
    if not batches:
        # Still worth one message when replacing: it is how the viewer is told
        # the file is now empty, rather than being left showing a stale run.
        if not replace:
            return
        batches = [[]]

    for batch_index, batch in enumerate(batches):
        write_message(
            {"type": "runEvents", "events": batch, "replace": replace and batch_index == 0}
        )


def read_new_text(offset):
    # type: (int) -> tuple
    """Complete lines from `offset` onwards, and the offset just past them."""
    with RUN_EVENT_FILE.open("rb") as event_handle:
        event_handle.seek(offset)
        block = event_handle.read()

    last_newline = block.rfind(b"\n")
    if last_newline < 0:
        return "", offset  # only a partially written line so far

    complete = block[: last_newline + 1]
    return complete.decode("utf-8", "replace"), offset + len(complete)


def tail_run_events():
    # type: () -> None
    """Stream the current run to the extension until this process is torn down.

    Runs on a daemon thread, so it ends when Chrome closes the port and the main
    loop returns. The file being *replaced* underneath us is the ordinary case —
    every run start trims it — so a shrink or a new inode means "start again from
    the top", not an error.
    """
    offset = 0
    identity = None
    has_reported_error = False

    while True:
        try:
            status = RUN_EVENT_FILE.stat()
        except OSError:
            # No file yet: nothing has ever run. Wait for one rather than
            # complaining — this is an ordinary state, not a failure.
            if identity is not None:
                identity, offset = None, 0
                send_run_events([], replace=True)
            time.sleep(RUN_EVENT_POLL_SECONDS)
            continue

        current_identity = (status.st_dev, status.st_ino)
        start_from_top = (
            identity is None or current_identity != identity or status.st_size < offset
        )

        try:
            if start_from_top:
                identity, offset = current_identity, 0
                text, offset = read_new_text(0)
                send_run_events(most_recent_run(parse_event_lines(text)), replace=True)
            elif status.st_size > offset:
                text, offset = read_new_text(offset)
                send_run_events(parse_event_lines(text), replace=False)
            has_reported_error = False
        except OSError as error:
            # Once, not every 250ms: a file we cannot read stays unreadable.
            if not has_reported_error:
                has_reported_error = True
                log_message("Could not read run events: {}".format(error))
                write_message({"type": "tailError", "error": str(error)})

        time.sleep(RUN_EVENT_POLL_SECONDS)


TAIL_THREAD = None
TAIL_REQUESTED = False


def request_run_event_tail():
    # type: () -> dict
    """Acknowledge the request; the stream itself starts once the reply is out.

    Starting the thread here would let the backfill overtake this acknowledgement
    on the wire, and a client that waits for the ack before listening would lose
    the beginning of the run it opened the window to watch.
    """
    global TAIL_REQUESTED

    TAIL_REQUESTED = True
    return {"type": "tailStarted", "ok": True, "path": str(RUN_EVENT_FILE)}


def start_requested_tail():
    # type: () -> None
    """Begin streaming, once per connection however many times we are asked.

    Only the main loop calls this, so the check needs no lock: a second request
    on the same port is a duplicate, not a second stream.
    """
    global TAIL_THREAD

    if not TAIL_REQUESTED or TAIL_THREAD is not None:
        return

    TAIL_THREAD = threading.Thread(target=tail_run_events, name="run-event-tail")
    TAIL_THREAD.daemon = True
    TAIL_THREAD.start()
    log_message("Streaming run events from {}".format(RUN_EVENT_FILE))


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
        "Settings updated: run at {}, new projects in {}, model {}, max {}h per prompt, ({})".format(
            settings.describe_schedule(),
            settings.new_projects_directory,
            settings.model,
            settings.max_prompt_duration_hours,
            result.detail,
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

    if message_type == MESSAGE_TYPE_TAIL_RUN:
        return request_run_event_tail()

    if message_type == MESSAGE_TYPE_CANCEL_WORK:
        return cancel_autonomous_work()

    if message_type == MESSAGE_TYPE_RUN_WORK:
        result = start_autonomous_work()
        if result.get("ok"):
            log_message("Asked launchd to start autonomous work, on request from the popup")
        else:
            log_message("Could not start autonomous work: {}".format(result.get("error")))
        return result

    if message_type == MESSAGE_TYPE_PRIME_FOLDERS:
        result = start_folder_access_prompts()
        log_message("Started folder-access prompts on request from the popup")
        return result

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
            # After the reply, never before — see `request_run_event_tail`.
            start_requested_tail()
        except Exception as error:  # noqa: BLE001 — see below
            # Deliberately broad. Dying here costs the extension its connection
            # and shows up as nothing more than "host disconnected", so any
            # failure is worth more as a logged reply than as a traceback into a
            # stderr nobody reads.
            log_message("Failed handling message: {!r}".format(error))
            write_message({"ok": False, "error": str(error)})


if __name__ == "__main__":
    sys.exit(main())
