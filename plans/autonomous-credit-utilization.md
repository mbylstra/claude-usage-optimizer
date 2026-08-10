# Plan: Autonomous Pace Catch-up System

## Goal

Automatically run Claude Code in the middle of the night when weekly usage is behind pace, to maintain consistent subscription burn-rate. The system should check pace delta before invoking work, requiring no manual intervention, and execute work with full computer access via the Claude Code CLI.

## Requirements

| #   | Requirement                                        | How it is met                                                                       |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Check weekly pace before running work              | Extension writes pace delta to `~/Downloads/claude-usage.json` via chrome.downloads |
| 2   | Trigger Claude Code autonomously at scheduled time | Shell script run by launchd at 2 AM daily                                           |
| 3   | Run with full shell access                         | Use `claude -p` mode with `--permission-mode auto`                                  |
| 4   | No human intervention required                     | Scheduled by OS, scripted entirely, logged to file                                  |
| 5   | Skip if not behind pace                            | Script reads pace delta and exits early if threshold not met (default 2h behind)    |

---

## 1. Data exposure: Extension downloads pace data to ~/Downloads

The extension's service worker already derives the pace delta for every window. To make it accessible to the cron script:

**What to add to `src/extension/usageStorage.ts`:**

- After every successful usage fetch, call `downloadUsageSnapshot()`
- Function creates a JSON blob and uses `chrome.downloads.download()` to write to `~/Downloads/claude-usage.json`
- File format:
  ```json
  {
    "fetchedAt": "2026-08-10T08:15:00Z",
    "weeklyPaceDeltaMs": -7200000,
    "weeklyPaceStatus": "behind",
    "fiveHourPercent": 45,
    "sevenDayPercent": 62
  }
  ```
  - `weeklyPaceDeltaMs`: negative = behind pace (e.g., -7200000 = 2 hours behind)
  - `weeklyPaceStatus`: one of `"behind"`, `"onTrack"`, `"ahead"`
- Use `conflictAction: 'overwrite'` to replace the file on each refresh

**Implementation sketch:**

```typescript
async function downloadUsageSnapshot(data: UsageSnapshot) {
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url: url,
    filename: 'claude-usage.json',
    saveAs: false,
    conflictAction: 'overwrite',
  });

  URL.revokeObjectURL(url);
}
```

**Why this way:**

- Decouples extension from scheduler (no IPC/HTTP/native messaging needed)
- Uses standard MV3 `chrome.downloads` API (no extra permissions)
- Simple to debug (file is at a well-known path: `~/Downloads/claude-usage.json`)
- Pace delta already computed by extension's pace engine, just needs exposure

**Caveat:**

- File lives in `~/Downloads`, not project-local
- User should avoid deleting/moving Downloads folder (would break scheduler)
- If needed later, could move to proper location with native messaging or HTTP server

---

## 2a. Demo queue file

Create `.claude-scripts/prompts.queue.txt` with starter prompts. Users can edit this file to add/remove work items:

```
===
STATUS: todo
REPO: ~/code/current/claude-usage-optimizer
Analyze recent code changes in this project and suggest improvements.
Look for opportunities to refactor, simplify, or optimize.
Report findings and implement high-value changes.

===
STATUS: todo
REPO: ~/code/auto-claude
Review and update project documentation.
Check for outdated links, missing sections, or unclear explanations.
Make improvements where you see them.

===
STATUS: todo
Clean up and organize project files.
Look for dead code, unused dependencies, or obsolete configs.
Remove what's no longer needed and update build/test scripts as needed.

===
STATUS: todo
REPO: ~/code/current/claude-usage-optimizer
Run `just check` to verify project health.
Fix any lint, type, or format errors.
Commit fixes if appropriate.
```

**Notes:**

- Each prompt can specify a `REPO` (defaults to `~/code/auto-claude` if omitted)
- Prompts can span multiple lines; everything after `REPO` (or first non-header line) is the prompt
- Users add prompts by creating new sections, edit/remove by deleting sections
- Status auto-updates: `todo` → `completed` (on success) or `error` (on failure)
- Scheduler picks first `todo` and runs it; if it fails, changes status to `error` and waits for user to fix

---

## 2. Prompt queue file

Create `.claude-scripts/prompts.queue.txt` in repo to define work items:

```
===
STATUS: todo
REPO: ~/code/claude-usage-optimizer
Analyze recent code changes and suggest optimizations.
Run the test suite with `just check` and fix any failures.

===
STATUS: todo
REPO: ~/code/some-other-project
Refactor the authentication module to improve clarity.

===
STATUS: todo
Clean up unused dependencies and update docs.
(no REPO line defaults to ~/code/auto-claude)
```

**Format:**

- Sections separated by 3+ `=` on their own line
- Each section starts with `STATUS: <status>` (one of: `todo`, `completed`, `error`)
- Optional `REPO: <path>` field (defaults to `~/code/auto-claude` if omitted)
- Everything after the REPO line (or first non-header line) is the multi-line prompt
- `~` in paths expands to `$HOME`

**Status values:**

- `todo` — queued for execution
- `completed` — ran successfully (exit code 0)
- `error` — ran but failed (non-zero exit code); skipped by scheduler

**Git configuration:**

- Add `.claude-scripts/prompts.queue.txt` to repo (checked in, user-editable)
- Runtime state files (usage.json, logs) stay in `.gitignore`

---

## 3. Python script: Check pace and invoke queued Claude Code

Create `.claude-scripts/run-autonomous-work.py` in repo to read pace data, find next todo prompt, and execute it.

**Python version management:**

- Use `uv` to manage Python version and dependencies
- Create `pyproject.toml` in `.claude-scripts/` to declare dependencies (e.g., `requests` if needed for future features)
- Script uses `#!/usr/bin/env uv run` shebang to ensure it runs with correct Python version when scheduled

**Create `.claude-scripts/pyproject.toml`:**

```toml
[project]
name = "autonomous-work"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = []

[build-system]
build-backend = "hatchling.build"
build-requires = ["hatchling"]
```

**Create `.claude-scripts/run-autonomous-work.py`:**

```python
#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.10"
# ///

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# Configuration
PROJECT_ROOT = Path.cwd()
USAGE_FILE = Path.home() / "Downloads" / "claude-usage.json"
QUEUE_FILE = PROJECT_ROOT / ".claude-scripts" / "prompts.queue.txt"
LOG_FILE = PROJECT_ROOT / ".claude-scripts" / "autonomous-work.log"
PACE_THRESHOLD_MS = -7200000  # -2 hours (negative = behind)
DATA_STALENESS_THRESHOLD_SECS = 1800  # 30 minutes


def log_message(msg: str) -> None:
    """Log a message with timestamp."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    log_msg = f"{timestamp}: {msg}"
    print(log_msg)
    with open(LOG_FILE, "a") as f:
        f.write(log_msg + "\n")


def check_pace_data() -> dict | None:
    """Read and validate pace data from usage file."""
    if not USAGE_FILE.exists():
        log_message(f"No usage data found at {USAGE_FILE} (extension not running?)")
        return None

    try:
        with open(USAGE_FILE) as f:
            data = json.load(f)
    except Exception as e:
        log_message(f"Failed to read usage file: {e}")
        return None

    # Check if data is fresh
    fetched_at_str = data.get("fetchedAt")
    if not fetched_at_str:
        log_message("No fetchedAt field in usage data")
        return None

    try:
        fetched_at = datetime.fromisoformat(fetched_at_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        age_secs = (now - fetched_at).total_seconds()

        if age_secs > DATA_STALENESS_THRESHOLD_SECS:
            log_message(f"Usage data stale ({age_secs}s old)")
            return None
    except Exception as e:
        log_message(f"Failed to parse timestamp: {e}")
        return None

    return data


def parse_queue_file() -> tuple[str, str] | None:
    """Parse queue file and return (repo, prompt) for first todo, or None."""
    if not QUEUE_FILE.exists():
        log_message(f"No prompt queue found at {QUEUE_FILE}")
        return None

    try:
        with open(QUEUE_FILE) as f:
            content = f.read()
    except Exception as e:
        log_message(f"Failed to read queue file: {e}")
        return None

    # Split by separator (3+ equals signs on a line)
    sections = []
    current_section = []

    for line in content.split("\n"):
        if line.startswith("==="):
            if current_section:
                sections.append("\n".join(current_section))
            current_section = []
        else:
            current_section.append(line)

    if current_section:
        sections.append("\n".join(current_section))

    # Parse each section
    for section in sections:
        lines = section.strip().split("\n")
        if not lines:
            continue

        status = None
        repo = None
        prompt_lines = []

        for line in lines:
            if line.startswith("STATUS:"):
                status = line.split("STATUS:")[1].strip()
            elif line.startswith("REPO:"):
                repo = line.split("REPO:")[1].strip()
                repo = repo.replace("~", str(Path.home()))
            elif status is not None and line.strip():
                # Accumulate prompt content
                prompt_lines.append(line)

        # Check if this is a todo section
        if status == "todo" and prompt_lines:
            if repo is None:
                repo = str(Path.home() / "code" / "auto-claude")
            prompt = "\n".join(prompt_lines)
            return repo, prompt

    log_message("No todo prompts in queue (all completed or error)")
    return None


def update_queue_status(new_status: str) -> None:
    """Update first todo status to completed or error."""
    try:
        with open(QUEUE_FILE) as f:
            content = f.read()

        # Replace first "STATUS: todo" with new status
        updated = content.replace("STATUS: todo", f"STATUS: {new_status}", 1)

        with open(QUEUE_FILE, "w") as f:
            f.write(updated)

        log_message(f"Queue updated (first todo → {new_status})")
    except Exception as e:
        log_message(f"Failed to update queue: {e}")


def main() -> int:
    """Main entry point."""
    # Ensure log file exists
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    # Check pace data
    pace_data = check_pace_data()
    if not pace_data:
        return 0

    pace_delta_ms = pace_data.get("weeklyPaceDeltaMs", 0)

    # Check if behind pace threshold
    if pace_delta_ms > PACE_THRESHOLD_MS:
        hours_behind = pace_delta_ms / -3600000
        log_message(f"Not behind pace threshold ({hours_behind:.1f}h behind, need 2h+)")
        return 0

    # Behind pace — find and run next todo prompt
    hours_behind = pace_delta_ms / -3600000
    log_message(f"Behind pace by {hours_behind:.1f}h, checking prompt queue")

    result = parse_queue_file()
    if not result:
        return 0

    work_repo, work_prompt = result

    try:
        repo_path = Path(work_repo)
        repo_path.mkdir(parents=True, exist_ok=True)
        log_message(f"Found todo prompt (repo: {work_repo})")

        # Run claude from the specified repo
        result = subprocess.run(
            [
                "claude",
                "-p",
                work_prompt,
                "--permission-mode",
                "auto",
                "--output-format",
                "json",
            ],
            cwd=work_repo,
            capture_output=True,
            text=True,
        )

        # Log output
        if result.stdout:
            log_message(f"Claude stdout: {result.stdout}")
        if result.stderr:
            log_message(f"Claude stderr: {result.stderr}")

        exit_code = result.returncode
        log_message(f"Prompt execution completed with exit code {exit_code}")

        # Update queue status
        new_status = "completed" if exit_code == 0 else "error"
        update_queue_status(new_status)

        return exit_code

    except Exception as e:
        log_message(f"Error running prompt: {e}")
        update_queue_status("error")
        return 1


if __name__ == "__main__":
    sys.exit(main())
```

**Design notes:**

- Written in Python with `uv run` shebang for reproducible execution (works in scheduled contexts)
- `uv` manages Python version (3.10+) and future dependencies via `pyproject.toml`
- Reads from `.claude-scripts/prompts.queue.txt` instead of hardcoded prompt
- Finds first `STATUS: todo` section (skips `completed` and `error`)
- Extracts repo path (defaults to `~/code/auto-claude`) and multi-line prompt text
- Runs `claude -p` from the specified repo directory, creating it if needed
- Automatically updates the first todo's status to `completed` (exit 0) or `error` (non-zero)
- Logs all activity to `.claude-scripts/autonomous-work.log` for debugging
- Exits silently (exit code 0) if pace OK, queue missing, or no todo prompts
- `--permission-mode auto` auto-approves permission requests (necessary for unattended execution)
- `--output-format json` for structured results
- Handles edge cases: missing usage file, stale data, malformed JSON, file I/O errors

---

## 4. macOS scheduling: launchd configuration

Create `~/Library/LaunchAgents/com.claudeusageoptimizer.autonomouswork.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claudeusageoptimizer.autonomouswork</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>uv</string>
    <string>run</string>
    <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts/run-autonomous-work.py</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts/system.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts/system.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>/Users/michaelbylstra</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer</string>
</dict>
</plist>
```

**Important: Ensure PATH includes uv and claude**

Before installing, verify that both `uv` and `claude` are in the PATH that launchd will see:

```bash
# Check where uv is installed
which uv  # e.g., /usr/local/bin/uv

# Check where claude is installed
which claude  # e.g., /usr/local/bin/claude
```

If either is in a non-standard location, update the `PATH` in the plist accordingly. The default PATH in the plist includes `/usr/local/bin`, which covers most Homebrew installations.

**To install:**

```bash
# Script is already in repo at .claude-scripts/run-autonomous-work.py
# Create the plist file and install it:
launchctl load ~/Library/LaunchAgents/com.claudeusageoptimizer.autonomouswork.plist
```

**To verify:**

```bash
launchctl list | grep claudeusageoptimizer
```

**To uninstall:**

```bash
launchctl unload ~/Library/LaunchAgents/com.claudeusageoptimizer.autonomouswork.plist
```

---

## 5. Architecture and constraints

```
Chrome Extension                    Home Directory & Project Root
├── src/lib/usagePace.ts            ~/Downloads/
│   └── derives pace delta           └── claude-usage.json (runtime, auto-updated by extension)
│
├── src/extension/usageStorage.ts   Project Root/
│   └── downloads usage + pace       .claude-scripts/
│       to ~/Downloads/              ├── run-autonomous-work.sh (executable script)
│       claude-usage.json            ├── prompts.queue.txt (checked in, user-editable)
│       via chrome.downloads         │   ├── STATUS: todo|completed|error (auto-updated)
│                                    │   ├── REPO: ~/path/to/project
└── (5-min refresh via alarms)       │   └── prompt text (multiline)
                                     ├── autonomous-work.log (runtime, gitignored)
                                     └── system.log (runtime, gitignored)

                                    ~/Library/LaunchAgents/
                                    └── com.claudeusageoptimizer.autonomouswork.plist
```

**Key design decisions:**

1. **Pace-based trigger, not credit-based** — Ensures consistent burn rate across the week. If you fall behind, Claude does work to catch up; if ahead, nothing runs. Natural equilibrium.
2. **Filesystem as IPC** — Usage data exposed via JSON file, prompt queue as plain text. Simpler than HTTP, no extra process to manage, files serve as both contract and debugging aid.
3. **Prompt queue is user-editable** — Define work items once in `prompts.queue.txt`, checked into repo. Status auto-updates as items run (`todo` → `completed` or `error`). Easy to add, remove, or re-queue work.
4. **Status field prevents retry-on-error** — Failed prompts marked `error` are skipped. Allows review before re-queuing.
5. **Per-prompt repo routing** — Each prompt can run in a different project directory (or default to `~/code/auto-claude`). Enables bulk work across multiple repos.
6. **Threshold configurable in script** — Pace target can be adjusted without rebuilding extension (default 2 hours behind).
7. **launchd, not cron** — Native to macOS, respects system sleep/wake, properly manages environment.
8. **Autonomous Claude Code, not API** — Uses subscription credits directly, full shell access, no separate API keys.
9. **No cost if on pace** — System is passive by default; work only triggers when needed.

---

## 6. Implementation phases

### Phase 0 — Data exposure

- Add `downloadUsageSnapshot()` to `usageStorage.ts`
  - Derives `weeklyPaceDeltaMs` and `weeklyPaceStatus` from existing pace engine
  - Creates JSON blob and downloads to `~/Downloads/claude-usage.json` via `chrome.downloads.download()`
  - Uses `conflictAction: 'overwrite'` to replace on each refresh
- Call it after every successful usage fetch in `serviceWorker.ts`
- Add `downloads` permission to `manifest.json` if not already present
- **Exit criterion:** `~/Downloads/claude-usage.json` is written on every refresh, contains valid JSON with pace delta

### Phase 1 — Python script scaffolding

- Create `.claude-scripts/pyproject.toml` with Python 3.10+ requirement
- Create `.claude-scripts/run-autonomous-work.py` with `#!/usr/bin/env uv run` shebang
- Implement pace checks (usage file freshness, threshold comparison)
- Implement queue parsing logic (read first `STATUS: todo` section)
- Extract REPO and prompt text correctly
- Make it executable: `chmod +x .claude-scripts/run-autonomous-work.py`
- Test manually: `uv run .claude-scripts/run-autonomous-work.py` runs without error
- Test with launchd PATH: ensure `uv` and `claude` are available in launchd environment
- Verify logs appear in `.claude-scripts/autonomous-work.log`
- **Exit criterion:** Script parses queue correctly, exits cleanly (logs "no todo prompts" if queue missing/empty)

### Phase 2 — Prompt queue and status tracking

- Create `.claude-scripts/prompts.queue.txt` with demo todo prompts (see section 2a)
- Verify script correctly finds and extracts first `STATUS: todo` prompt
- Verify script correctly updates status: `STATUS: todo` → `STATUS: completed` (on success) or `STATUS: error` (on failure)
- Test with a simple prompt that logs something and exits 0
- Test error case: run with a prompt that exits non-zero, verify status becomes `error`
- Test queue progression: run twice, verify first prompt completes and second runs
- Verify queue file can be edited to add/remove prompts and requeue failed items (change `error` back to `todo`)
- **Exit criterion:** Queue parsing and status updates work correctly; prompts run in the specified directories; queue is user-editable

### Phase 3 — Claude Code integration

- Replace test prompts with real work prompts (analyze code, run tests, etc.)
- Test manually: `bash .claude-scripts/run-autonomous-work.sh` from project root
- Verify `claude -p` runs autonomously and output is captured
- Test that status updates persist across runs
- **Exit criterion:** Claude Code executes with real prompts, logs are readable, status tracking works end-to-end

### Phase 4 — Scheduling

- Verify `uv` and `claude` are in PATH (in a location visible to launchd, typically `/usr/local/bin`)
- Create the launchd plist file with correct PATH
- Install via `launchctl load ~/Library/LaunchAgents/com.claudeusageoptimizer.autonomouswork.plist`
- Verify via `launchctl list | grep claudeusageoptimizer`
- Test manually by adjusting launchd time to next minute, waiting, then checking logs
- Review logs in `.claude-scripts/system.log` and `.claude-scripts/autonomous-work.log`
- Verify queue status updates automatically
- Check that Python environment is correctly resolved (no "uv: command not found" errors in system.log)
- **Exit criterion:** launchd fires at scheduled time, script runs with correct PATH, queue progresses

### Phase 5 — Polish

- Document the setup in `CLAUDE.md` (queue format, adding prompts, monitoring)
- Provide install/uninstall instructions
- Consider: make pace threshold configurable, add notification support (future)
- **Exit criterion:** User can install in one copy-paste, understand what is running, easily manage/disable

---

## 7. Open decisions

1. **Queue management UI** — How should users add/remove/reorder prompts?
   - **Current:** Direct edit of `prompts.queue.txt` (text file, checked in)
   - Could add: a CLI tool, a web UI, or an extension panel
   - **Recommend:** Start with direct text editing. Add tooling later if needed (simple to rebuild from here).

2. **Pace threshold** — How far behind is "behind"?
   - **Current:** 2 hours (default, configurable in script)
   - Could be 1h (trigger more often) or 4h (less aggressive)
   - **Recommend:** Start at 2h. User can adjust the `PACE_THRESHOLD_MS` variable in the script.

3. **Frequency** — Run nightly, or some other schedule?
   - **Current:** 2 AM daily
   - Could be multiple times a day, or weekly only
   - **Recommend:** Keep nightly. Pace naturally dampens over-execution (stops running if on track).

4. **Notification/Review** — Should the user be notified when work runs?
   - Currently: silent, logs only
   - Could add: email, Slack, or OS notification
   - **Recommend:** Logs only initially. Add notifications later if needed.

5. **Queue prioritization** — Current behavior is FIFO (first todo runs). Alternatives:
   - Add priority field: `PRIORITY: 1|2|3`
   - Run all todos in one session (vs. one per day)
   - Skip some repos if behind by less than threshold
   - **Recommend:** FIFO initially. Promotes prompt discipline. Can add priority field later if needed.

---

## 8. Risks and unknowns

1. **Claude Code in non-interactive mode** — The `-p` flag is documented but not heavily tested with full autonomous work. Early runs should be monitored.

2. **launchd timing** — If the machine is asleep at 2 AM, the job fires when it wakes. This is probably fine but worth noting.

3. **Pace calculation accuracy** — Pace is derived from API assumptions (e.g., fixed 7-day window). If weekly window is actually rolling, pace will drift. Mitigated by extension already collecting history data for verification.

4. **Prompt quality and maintenance** — Queue prompts define the actual work. Low-quality or outdated prompts → low value. Plan to review and refactor queue regularly (like a backlog).

5. **Directory-specific state** — If a prompt runs in `~/code/project-a` and makes changes, those persist. Subsequent runs see that state. Could be good (accumulation) or bad (accumulating debt). Mitigated by clear prompt design and reviewing logs.

6. **Queue editing race conditions** — If user edits `prompts.queue.txt` while the script is running, unpredictable behavior. Unlikely at 2 AM but worth documenting. Mitigated by atomic file replacement in script.

7. **Interaction with user sessions** — If the user is actively working at 2 AM and Claude Code is running autonomously, there could be conflicts (file edits, directory changes, etc.). Mitigated by running at night but worth documenting.

8. **Over-correction** — If pace threshold is too aggressive, Claude may run work frequently even when not beneficial. Mitigated by starting conservative (2h) and user being able to adjust.

---

## 9. Success criteria

- Extension computes weekly pace delta via existing pace engine ✅
- Extension downloads pace data to `~/Downloads/claude-usage.json` on every refresh ✅
- Shell script reads pace delta from `~/Downloads/claude-usage.json` ✅
- Shell script exits if on-pace (not behind threshold) ✅
- Shell script parses `.claude-scripts/prompts.queue.txt` correctly ✅
- Shell script finds first `STATUS: todo` prompt and extracts REPO and prompt text ✅
- Shell script creates REPO directory if needed and runs `claude -p` from there ✅
- `claude -p` invocation runs successfully and logs output ✅
- Shell script updates first todo's status to `completed` (exit 0) or `error` (non-zero) ✅
- Shell script skips `completed` and `error` prompts (only runs `todo`) ✅
- launchd fires at 2 AM and script executes automatically ✅
- User can define work in `prompts.queue.txt` and queue progresses ✅
- User can enable/disable the feature easily (install/uninstall launchd plist) ✅
- User can adjust pace threshold in script without rebuilding ✅
- Logs are human-readable and useful for debugging (`.claude-scripts/autonomous-work.log`) ✅
- System enters natural equilibrium: behind pace → runs prompts → catches up → stops ✅
- User can re-queue failed prompts by editing status from `error` back to `todo` ✅
