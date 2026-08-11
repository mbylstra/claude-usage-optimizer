# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Report which macOS-protected folders the nightly run can actually read.

Run this the way `just check-folder-access` does — as a launchd job — or the
answer is a lie. Started from a terminal, the read is attributed to Terminal or
iTerm, which hold their own grants and pass them down, so every folder comes
back readable whether or not the 2 AM job could touch it. launchd is the only
context that reproduces the nightly chain's permissions.

Nothing here grants anything. macOS has no scriptable way to do that, and a
denial from an unattended job is silent — `Operation not permitted`, no dialog.
"""

import os

# The folders macOS gates individually. Everything else worth protecting
# (~/Library/Mail, Safari, Messages) needs Full Disk Access, which this project
# deliberately never asks for — see README, "Protected folders".
PROTECTED_FOLDERS = [
    "~/Desktop",
    "~/Documents",
    "~/Downloads",
    "~/Library/Mobile Documents",
]


def describe_access(folder_path: str) -> str:
    expanded_path = os.path.expanduser(folder_path)
    try:
        os.listdir(expanded_path)
        return "readable"
    except PermissionError:
        return "BLOCKED by macOS"
    except FileNotFoundError:
        return "not on this machine"
    except OSError as error:
        return "unreadable ({})".format(error.strerror)


def main() -> None:
    results = [(folder, describe_access(folder)) for folder in PROTECTED_FOLDERS]
    width = max(len(folder) for folder, _ in results)
    for folder, verdict in results:
        print("{:<{width}}  {}".format(folder, verdict, width=width), flush=True)

    blocked = [folder for folder, verdict in results if verdict.startswith("BLOCKED")]
    if blocked:
        print(flush=True)
        print("A queued prompt reading {} will fail with".format(" or ".join(blocked)))
        print("'Operation not permitted' and be marked error.", flush=True)
        print(flush=True)
        print("To fix: click the extension's toolbar icon in Chrome, open", flush=True)
        print("Settings, and press 'Grant folder access'. Only a request coming", flush=True)
        print("through Chrome can raise the macOS dialog; this job cannot.", flush=True)
        print(flush=True)
        print("Nothing happens when you press it? macOS remembers a permission", flush=True)
        print("you switched off as a refusal and will not ask twice. Delete the", flush=True)
        print("row in Privacy & Security > Files and Folders with the '-' button", flush=True)
        print("rather than toggling it off, then press the button again.", flush=True)


if __name__ == "__main__":
    main()
