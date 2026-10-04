#!/usr/bin/env python3
"""Register the native-messaging host — the cross-platform half.

See `plans/codex-usage-on-windows.md`. macOS/Linux installation stays the
`just install-usage-host` recipe (drop a rendered manifest into Chrome's
`NativeMessagingHosts` folder) — that path already works and this script does
not touch it. This script is the Windows path, which is structurally
different in two ways Chrome itself imposes:

* **No shebang execution.** `path` in the manifest must name something the
  OS can `CreateProcess` directly, so a `usage-host.bat` wrapper is generated
  alongside the manifest, pointing at this machine's own `python.exe`.
* **No folder-drop registration.** Chrome finds the manifest on Windows via
  a registry value
  (`HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name>`)
  that points at the manifest file's path, wherever that file happens to
  live — so `winreg` (stdlib, Windows-only) is used instead of a folder copy.

Deliberately stdlib-only and dependency-free, matching every other script in
`backend/` — nothing here is spawned by Chrome, but it inherits the same rule
because a fresh Windows machine has nothing else installed to run this with.

**Must be run from a Windows Python, on the Windows-side copy of this
repository.** The generated `.bat`, and the manifest's `path`, are both
derived from this script's own `Path(__file__).resolve().parent` — never
from a translated `/mnt/c/...` or `\\\\wsl$\\...` path — so if the repository
lives in WSL, deploy `backend/*.py` to a native Windows path first (see
`just deploy-windows` and the plan's "Two different Windows setups" section)
and run this script from *that* copy. Running it from inside WSL would bake
the WSL Python interpreter into the `.bat` and silently produce a host Chrome
cannot launch — refused outright, below, rather than producing that trap.

Usage: python install_usage_host.py <extension-id>

The extension ID is required here (unlike the macOS recipe's optional,
autocomputed argument) because `extension-id.py`'s path-hash trick is
unreliable across the WSL/Windows boundary — see the plan's §3. Read it
directly from `chrome://extensions` with Developer mode on.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MANIFEST_NAME = "com.claudeusageoptimizer.usagehost"
MANIFEST_TEMPLATE_NAME = MANIFEST_NAME + ".json"
REGISTRY_KEY_PATH = r"Software\Google\Chrome\NativeMessagingHosts\{}".format(MANIFEST_NAME)

BATCH_WRAPPER_TEMPLATE = """@echo off
"{python_executable}" "%~dp0usage-host.py" %*
"""


def _project_root():
    # type: () -> Path
    """This script's own directory — see the module docstring on why."""
    return Path(__file__).resolve().parent


def write_batch_wrapper(project_root, python_executable):
    # type: (Path, str) -> Path
    """`usage-host.bat`, generated fresh every run — see the module docstring.

    `@echo off` is load-bearing: stdout is the native-messaging wire
    protocol, and any stray echoed line corrupts the length-prefixed frame
    the same way a stray `print` would in the Python host itself.
    """
    batch_path = project_root / "usage-host.bat"
    batch_path.write_text(
        BATCH_WRAPPER_TEMPLATE.format(python_executable=python_executable),
        encoding="utf-8",
    )
    return batch_path


def write_manifest(project_root, extension_id, batch_path):
    # type: (Path, str, Path) -> Path
    """The manifest JSON, `path` pointing at the `.bat` instead of the `.py`.

    Written next to `usage-host.py` rather than into a Chrome-owned folder —
    Windows has no folder-drop step; the registry value (`register_host`,
    below) is what tells Chrome where to find this file.
    """
    template = (project_root / MANIFEST_TEMPLATE_NAME).read_text(encoding="utf-8")
    manifest = json.loads(template)
    # `str(batch_path)` on Windows is backslash-separated (`C:\Users\...`), and
    # a raw substitution into the template text (rather than through `json`,
    # which escapes it) produced invalid JSON that Chrome silently refused to
    # parse — the manifest never even attempted to spawn a process, which is
    # why this showed up as HOST_UNAVAILABLE with no usage-host.log at all.
    manifest["path"] = str(batch_path)
    manifest["allowed_origins"] = ["chrome-extension://{}/".format(extension_id)]
    manifest_path = project_root / (MANIFEST_NAME + ".windows.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest_path


def register_host(manifest_path):
    # type: (Path) -> None
    """Point Chrome at the manifest via the registry — see the module docstring."""
    import winreg  # Windows-only stdlib module; only reached after the os.name guard below.

    key = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, REGISTRY_KEY_PATH)
    try:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))
    finally:
        winreg.CloseKey(key)


def main(argv):
    # type: (list) -> int
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    if sys.platform != "win32":
        print(
            "install_usage_host.py registers the Windows native host and must "
            "be run with a Windows Python (not WSL's), from the Windows-side "
            "copy of this repository — see the module docstring. On "
            "macOS/Linux, use `just install-usage-host` instead.",
            file=sys.stderr,
        )
        return 1

    extension_id = argv[1]
    project_root = _project_root()

    batch_path = write_batch_wrapper(project_root, sys.executable)
    manifest_path = write_manifest(project_root, extension_id, batch_path)
    register_host(manifest_path)

    print("Wrote {}".format(batch_path))
    print("Wrote {}".format(manifest_path))
    print(
        "Registered {} for extension {} at HKCU\\{}".format(
            MANIFEST_NAME, extension_id, REGISTRY_KEY_PATH
        )
    )
    print("Check that ID matches chrome://extensions, then reload the extension.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
