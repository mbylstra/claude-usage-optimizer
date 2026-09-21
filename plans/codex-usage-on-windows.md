# Plan: Codex usage on Windows

## Goal

Make the popup's Codex/ChatGPT usage section (`plans/codex-subscription-usage.md`)
work when Chrome and the native host run on Windows. Out of scope, explicitly:
the autonomous-work scheduler, the three launch agents, the run-log window's
"Do next todo" / "Trigger a full run" buttons, folder-access priming — all of
that stays macOS-only, per the root `CLAUDE.md`'s "The scheduler and executor
does not need to work in Windows." If a Windows user presses one of those
buttons, the host should reply with a clean "not supported on this platform"
error, not crash or hang. The only message type this plan makes work end to
end is `getCodexUsage`; `snapshot` and `setAutonomousWorkSettings` must keep
degrading gracefully since they fire on every refresh/settings-save regardless
of platform (see §5).

## Two different Windows setups — this plan assumes one, names the other

"Windows" splits into two shapes with very different plumbing, because Chrome
itself is always a Windows process (there is no WSL Chrome), but the Codex CLI
credential can be on either side of the WSL boundary:

- **A. Native Windows.** `codex login` was run in a Windows shell (PowerShell/
  cmd), so the credential is at `%USERPROFILE%\.codex\auth.json`. The native
  host should be a native Windows Python process. Fewest moving parts.
- **B. WSL.** `codex login` was run inside WSL, so the credential is in the
  WSL filesystem. Chrome (Windows-side) still has to spawn *something* on the
  Windows side — native messaging hosts cannot be a WSL binary — so the
  Windows-side wrapper has to shell out to `wsl.exe -e python3 usage-host.py`,
  or the Windows-native host has to be pointed at the credential across the
  `\\wsl$\` (or `\\wsl.localhost\`) path via `CODEX_USAGE_AUTH_FILE`.

**This plan targets A as the primary, supported path** — "get it working on
Windows" reads as "for a Windows user," not "for me developing under WSL2."
B is documented as a variant using the same seam (`CODEX_HOME` /
`CODEX_USAGE_AUTH_FILE`, both already read by `codex_usage.py`), not a
separately engineered path. If the actual need turns out to be B specifically
(developing this repo under WSL while Chrome runs on the Windows host), most
of §§2-4 below still apply — only the wrapper's Python invocation changes,
from a direct `python.exe` call to a `wsl.exe -e python3` call — but that
should be confirmed before building it, since it changes what "install" means.

**Resolved: A, plus a deploy step, because the repository itself lives in
WSL.** The actual case was "native Windows Chrome and native Windows Python
(setup A), but the checkout this plan is built from is under WSL" — a third
combination the two bullets above don't name, since they're about where
`codex login` ran, not where the repository lives. `wsl.exe` shelling out was
never needed: setup A's `.bat` (direct `python.exe`, no WSL involved) is
exactly right once *some* copy of `backend/*.py` sits on the Windows-visible
filesystem. `just deploy-windows` is that copy step — see §2.

## Step 0 — diagnose before touching anything

"Does not appear to be working" could mean the host never starts, or it
starts but the Codex call itself fails. These have almost disjoint fixes, so
the first step on the Windows machine is to check `backend/usage-host.log`:

- **No log file, or it never gains a line after opening the popup** → the
  host was never spawned. This is a registration/executability problem
  (§§1-2 below); nothing about the Codex code matters yet.
- **Log exists and shows `Received getCodexUsage message`** → the host runs
  and dispatches correctly; the failure is inside `codex_usage.py` or the
  network call. Prime suspect: `os.fchmod` (§4), which only fires on token
  refresh — predicted symptom is "works for about an hour after `codex
  login`, then permanently fails," because `AttributeError` there is caught
  by `read_codex_usage`'s catch-all and reported as a generic `NETWORK_ERROR`
  with no hint it was a platform bug.

Given the reported symptom ("does not appear to be working" at all, not
"stopped working after a while"), §§1-2 (the host never starting) is the more
likely branch, and should be fixed first regardless of which theory is right
— it's cheap to confirm by reading the log.

## 1. The manifest's `path` must be executable on Windows

`backend/com.claudeusageoptimizer.usagehost.json`'s `path` currently points
straight at `usage-host.py`. On macOS/Linux this works because the file is
`chmod +x`'d with a `#!/usr/bin/env python3` shebang and the OS honors it.
Windows has no shebang execution — `path` must name something the OS can
`CreateProcess` directly: an `.exe`, or a `.bat`/`.cmd` batch file.

**New: `backend/usage-host.bat`**, a thin wrapper:

```bat
@echo off
python "%~dp0usage-host.py" %*
```

Two things that will silently break the protocol if missed:

- `@echo off` is load-bearing, not cosmetic — stdout is the native-messaging
  wire protocol (see `usage-host.py`'s own docstring), and any stray echoed
  line corrupts the length-prefixed frame the same way a stray `print` does
  in the Python host.
- `python` has to resolve to something real in **Chrome's** spawn
  environment, not the interactive shell's. Don't assume the py launcher or
  `python3` alias exists there — resolve an absolute interpreter path at
  install time (§2) and bake it into the generated `.bat`, the same way the
  manifest template bakes in `__PROJECT_ROOT__`.

For the WSL variant (B), the `.bat` instead reads:

```bat
@echo off
wsl.exe -e python3 "<wsl-path-to>/usage-host.py" %*
```

with `CODEX_USAGE_AUTH_FILE`/`CODEX_HOME` set via `wsl.exe -e env … python3
…` or read from inside WSL's own environment — needs a decision once B is
confirmed as the actual target, not designed blind now.

## 2. Registration: registry pointer, not a dropped-in folder

The current `install-usage-host` justfile recipe is macOS-shaped throughout:
`native_host_dir` hardcodes `~/Library/Application Support/Google/Chrome/
NativeMessagingHosts`, and registration is "drop a file in that folder."

**Windows native messaging hosts are registered differently**: the manifest
JSON still exists as a file on disk (anywhere), but Chrome finds it via a
**registry value that points to that file's path**:

```
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.claudeusageoptimizer.usagehost
    (Default) = C:\path\to\backend\com.claudeusageoptimizer.usagehost.json
```

So Windows install is: write the same manifest JSON (with `path` now pointing
at `usage-host.bat`, not `usage-host.py`) anywhere stable under the repo, then
set that one registry value. No folder-drop step exists on Windows at all.

**Recommend moving the install logic into a small, cross-platform
`backend/install_usage_host.py`** rather than growing the `justfile` recipe
with an `if os == windows` branch in `sh`. Reasons:

- Python is already a hard dependency for the host itself, so this adds
  nothing new to "what must be installed first."
- `winreg` (stdlib, Windows-only import — guard it) is the natural way to
  write that registry value; doing it from a `just` recipe would mean
  shelling out to `reg add`, which is workable but uglier to keep correct.
- A Windows user with no bash/WSL can still run `python
  backend\install_usage_host.py` directly, without `just` being installed at
  all — `just` itself is another thing to install on a fresh Windows
  machine, and this plan should not make that a hard requirement just to see
  Codex numbers.

`just install-usage-host` becomes a thin wrapper that calls this script,
matching the existing recipe's signature (`extension_id=""` optional arg,
same rewrite-from-template-every-time safety property the root `CLAUDE.md`
requires of every `install-*` recipe).

**As implemented, §§1-2:** `backend/install_usage_host.py` was built as
described, but as a **Windows-only** script (refuses to run unless
`sys.platform == "win32"`) rather than the cross-platform wrapper originally
imagined — the existing macOS `install-usage-host` justfile recipe was left
completely untouched rather than routed through it, since the two have no
logic in common once the folder-drop-vs-registry split is taken seriously,
and a shared entry point would have meant threading a platform branch through
one script for no reuse. `just install-usage-host` was **not** changed into a
wrapper; the Windows path is a separate, explicitly-named command instead
(see below).

Because the repository lives in WSL (see the resolved setup note above), a
second piece was needed that the plan didn't anticipate: `just deploy-windows
[target]` copies `backend/*.py` (code only — never the runtime files
`usage-host.py` writes next to itself, and never `jira-credentials.json`) to
a native Windows path, defaulting to `%USERPROFILE%\programs\
claude-usage-optimizer-backend` (resolved via `cmd.exe` from inside the WSL
recipe, since there's no reliable way to ask Windows for "the current user's
profile" other than asking Windows). `install_usage_host.py` is then run from
*that* deployed copy, on the Windows side, which is what makes its
`Path(__file__).resolve().parent` a genuine Windows path with no `/mnt/c` ↔
`C:\` translation logic needed anywhere.

**A real bug, found and fixed during first manual test:** the first version
of `write_manifest` built the rendered manifest with a plain string
`.replace()` into the template's raw JSON text — `template.replace(...,
str(batch_path))` — rather than through `json.dumps`. On Windows,
`str(batch_path)` is backslash-separated (`C:\Users\...\usage-host.bat`), and
`\U`, `\p`, `\c` etc. are not valid JSON escape sequences, so the written
manifest was invalid JSON. Chrome silently refused to parse it: no log entry
at all (the host process was never spawned), surfacing only as
`HOST_UNAVAILABLE` in the popup — exactly the failure shape §0 describes for
"the host never starts," but with a cause outside anything §0 enumerates.
Fixed by parsing the template with `json.loads`, setting `path` and
`allowed_origins` as real dict values, and writing back with `json.dumps` —
letting `json` handle the escaping rather than string substitution. Confirmed
by round-tripping a real Windows-style path (with backslashes) through the
fixed function and back through `json.loads`.

## 3. `extension-id.py` cannot be trusted across the WSL/Windows boundary

`extension-id.py` SHA-256s the **absolute load path** Chrome derives the ID
from. A WSL-form path (`/home/…/chrome-extension/dist`) and the Windows-form
path Chrome actually sees for the same files produce completely different
hashes — so autocomputing the ID is unreliable here even though the script
itself is correct in isolation.

The existing recipe already has an escape hatch for this
(`just install-usage-host THE_ID_CHROME_SHOWS`) — the Windows install
instructions should lead with that path rather than the autocompute path:
read the ID directly from `chrome://extensions` (Developer mode on) and pass
it explicitly. Document this rather than trying to make `extension-id.py`
Windows-path-aware; it's a one-line instruction, not a code fix.

## 4. `codex_usage.py`: guard the one POSIX-only call

`_write_auth_file` calls `os.fchmod(handle_descriptor, 0o600)` and
`os.chmod(str(path), 0o600)` to keep the rotated credential file at `0600`
after a token refresh. `os.fchmod` does not exist on Windows — `AttributeError`
on every refresh, silently swallowed into a generic `NETWORK_ERROR` by
`read_codex_usage`'s outer catch-all (§0's second branch).

Fix: guard both calls behind `if os.name != "nt":` (matching how the rest of
the codebase already treats platform-specific calls — there's no existing
precedent in this file, but `hasattr(os, "fchmod")` or `sys.platform` are the
two idiomatic stdlib checks; either is fine).

**Be honest in the code comment about what this costs**: on Windows the
rewritten `auth.json` is left at whatever the default ACL/permissions are —
this plan does not attempt an NTFS-ACL equivalent of `0600`. That's a
reasonable scope cut (the file already carries a short-lived OAuth token, not
a long-lived secret, and it's the same file the Codex CLI itself manages) but
should be stated, not silently dropped.

Everything else in `codex_usage.py` is already portable: pure stdlib
(`urllib.request`, `json`, `base64`, `tempfile`, `datetime`), and its `Path`
usage, `CODEX_HOME`/`CODEX_USAGE_AUTH_FILE` env-var overrides, and
`tempfile.mkstemp` + `os.replace` atomic-write pattern all work unchanged on
Windows (`os.replace` is documented cross-platform-atomic since Python 3.3,
including overwriting an existing destination on Windows, unlike bare
`os.rename`).

## 5. `usage-host.py`: confirm it survives import and degrades the rest

The host imports `autonomous_work_settings`, `autonomous_work_resume`,
`queue_source_jira`, and `codex_usage` at module load, before `main()`'s
per-message try/except exists to catch anything. Inspected already:

- All module-level code in `autonomous_work_settings.py` and
  `autonomous_work_resume.py` is path/string construction
  (`Path(__file__).resolve().parent`, `environment_path(...)`, label
  strings) — nothing that shells out or touches a POSIX-only API at import
  time. `LAUNCHCTL_COMMAND = os.environ.get(..., "/bin/launchctl")` is just a
  string default; it's never executed unless `run_launchctl` is actually
  called.
- `subprocess.run(["/bin/launchctl", ...])` and friends only run inside
  functions, reached only by scheduler message types
  (`runAutonomousWork`, `runFullAutonomousWork`, `cancelAutonomousWork`,
  `setAutonomousWorkSettings`'s launch-agent-reload path).

So import should succeed unchanged on Windows — **verify this empirically**
(`python usage-host.py` on the Windows machine, confirm it blocks on
`sys.stdin.buffer.read(4)` rather than raising) rather than trusting the
inspection alone.

What needs an explicit decision, because these two message types are not
optional even with the scheduler out of scope — they fire unconditionally
every 5 minutes (`snapshot`) and on every settings save
(`setAutonomousWorkSettings`):

- **`snapshot`** → `write_snapshot`: tempfile + `os.replace`, no POSIX-only
  calls. Should already work. Verify with `just test-usage-host`-style manual
  message if that recipe itself doesn't run on Windows (it likely won't,
  being a `just` recipe — worth trying `python backend/test-usage-host.py`
  directly).
- **`setAutonomousWorkSettings`** → `apply_autonomous_work_settings`, which
  can reach `install_launch_agent(only_if_installed=True)`. On a fresh
  Windows install `INSTALLED_LAUNCH_AGENT_FILE` (a macOS `~/Library/
  LaunchAgents/*.plist` path) will never exist, so `only_if_installed` should
  make this a no-op — **verify this guard actually short-circuits before any
  `subprocess.run(["/bin/launchctl", ...])`**, since a Windows box has no
  `/bin/launchctl` at all and that call would raise `FileNotFoundError`
  (uncaught at that depth, surfacing as a generic error reply — not a crash,
  since `main()`'s outer catch-all still wraps `handle_message`, but a
  confusing one).

Scheduler-only message types (`runAutonomousWork`, `runFullAutonomousWork`,
`cancelAutonomousWork`, `primeFolderAccess`) should be left exactly as they
are — they'll hit the same `/bin/launchctl`-not-found shape and surface as a
logged error reply via the existing outer catch-all in `main()`, which is an
acceptable "not supported here" experience for buttons this plan explicitly
excludes. No new "unsupported platform" branch needs adding unless testing
turns up one of these actually hanging rather than failing fast.

## 6. Error copy: don't point Windows users at a macOS recipe

`fetchCodexUsageSnapshot`'s `HOST_UNAVAILABLE` message
(`chrome-extension/extension/codexUsageSource.ts`) reads "Install it with
`just install-usage-host`." Once §2's Windows install path exists, this
message needs to say something a Windows user without `just`/bash can follow
— either detect nothing (Chrome extensions can't detect the host OS reliably
enough to matter here) and just widen the copy to mention both, or point at a
short Windows-specific doc section. Cheapest fix: widen the one string.

## 7. Verify: binary mode on stdin/stdout

The classic Python-native-messaging-on-Windows gotcha is that the process's
stdin/stdout file descriptors can be opened in **text mode**, which mangles
`\n`/`\r\n` and corrupts the binary length-prefixed frame — the traditional
fix is `msvcrt.setmode(fd, os.O_BINARY)` before any read/write.

**Don't pre-emptively add this — verify first.** `sys.stdin.buffer` /
`sys.stdout.buffer` (which `usage-host.py` already uses exclusively for the
protocol, never the text-mode `sys.stdin`/`sys.stdout` themselves) are
documented to be the raw, non-text-translating buffer regardless of platform
in modern CPython — this may already be a non-issue. Confirm empirically: on
the Windows machine, send a message whose JSON payload contains a `0x0A`
byte inside a string value and check the reply round-trips with its length
prefix intact. If it mangles, add `msvcrt.setmode` calls guarded by
`sys.platform == "win32"` right after the `sys.path.insert` line, before any
I/O. If it doesn't, leave it alone — don't add speculative platform code for
a bug that isn't there.

## Testing

- `backend/tests/test_codex_usage.py` has a case exercising `_write_auth_file`
  with the Windows branch (`test_write_skips_chmod_on_windows`), run on Linux
  by patching a module-scoped `_SUPPORTS_POSIX_FILE_MODES` flag rather than
  `os.name` itself — patching `os.name` directly was tried first and rejected,
  since `pathlib.Path()` also reads it to choose `WindowsPath`/`PosixPath`,
  so patching it mid-test broke every `Path(...)` call in the same function
  rather than isolating the one guard under test. 23/23 tests pass.
- Manual, on an actual Windows machine (this cannot be verified from Linux/
  WSL — the whole point is Windows-specific process-spawn and registry
  behavior). **Status: verified working on a real Windows machine (WSL-hosted
  repo, native Windows Chrome and Python) as of 2026-09-21**, after fixing the
  manifest-JSON-escaping bug described above — the popup now reports real
  Codex usage numbers end to end.
  1. `codex login` on Windows (setup A) — done.
  2. Run the new install script; confirm the registry value and manifest
     both land correctly (`reg query
     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.claudeusageoptimizer.usagehost`)
     — done, after the JSON fix above; the first attempt failed exactly this
     way (invalid manifest, host never spawned, no log file at all).
  3. Reload the extension, open the popup with Codex usage enabled in
     Settings, confirm `usage-host.log` shows `Received getCodexUsage
     message` and the popup renders real numbers — confirmed working.
  4. Force a token refresh (or wait for one) and confirm no `AttributeError`
     appears in the log — **not yet separately confirmed**; worth checking
     after the credential has been live roughly an hour.
  5. Confirm the ordinary `snapshot`/settings-save paths still don't crash
     the host (open Settings, change something, save) — not yet separately
     confirmed, though `install_launch_agent(only_if_installed=True)`'s
     early-return-before-`launchctl` guard was verified by static reading of
     `autonomous_work_settings.py` (the check precedes the `subprocess.run`
     call with nothing in between).

## Explicit non-goals (repeating the constraint so it isn't scope-crept)

No Windows Task Scheduler port of the launch agents. No `ps`-equivalent
process-matching for the "run already in flight" guard. No folder-access
priming equivalent. No attempt to make the run-log window's action buttons
work. Those message types are allowed to fail on Windows with a logged error
reply — that failure is the intended, documented behavior, not a bug to
chase later under this plan.
