# Plan: Autonomous Pace Catch-up System

## Goal

Automatically run Claude Code in the middle of the night when weekly usage is behind pace, to maintain consistent subscription burn-rate. The system should check pace delta before invoking work, requiring no manual intervention, and execute work with full computer access via the Claude Code CLI.

## Requirements

| #   | Requirement                                            | How it is met                                                                        |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | Check weekly pace before running work                  | Extension writes pace delta to `.claude-usage.json` (repo root)                      |
| 2   | Trigger Claude Code autonomously at scheduled time     | Shell script run by launchd at 2 AM daily                                            |
| 3   | Run with full shell access                             | Use `claude -p` mode with `--permission-mode auto`                                   |
| 4   | No human intervention required                         | Scheduled by OS, scripted entirely, logged to file                                   |
| 5   | Skip if not behind pace                                | Script reads pace delta and exits early if threshold not met (default 2h behind)     |

---

## 1. Data exposure: Extension writes pace data to repo

The extension's service worker already derives the pace delta for every window. To make it accessible to local scripts:

**What to add to `src/extension/usageStorage.ts`:**
- After every successful usage fetch, write a normalized JSON file to `.claude-scripts/usage.json`
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
- Create `.claude-scripts/` directory if it does not exist
- Overwrite on each refresh (not append — the script reads the latest)

**Git configuration:**
- Add `.claude-scripts/` to `.gitignore` (runtime artifacts)

**Why this way:**
- Decouples the extension from the scheduler (no IPC/HTTP needed)
- File is co-located with code that depends on it
- Simple to debug (just look at `.claude-usage.json` in the project)
- Pace delta already computed by the extension's pace engine, just needs exposure

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

## 3. Shell script: Check pace and invoke queued Claude Code

Create `.claude-scripts/run-autonomous-work.sh` in repo:

```bash
#!/bin/bash
set -eu

PROJECT_ROOT="$(pwd)"
USAGE_FILE="$PROJECT_ROOT/.claude-scripts/usage.json"
QUEUE_FILE="$PROJECT_ROOT/.claude-scripts/prompts.queue.txt"
LOG_FILE="$PROJECT_ROOT/.claude-scripts/autonomous-work.log"
PACE_THRESHOLD_MS=-7200000  # -2 hours (negative = behind)

# Exit early if usage file missing or too old (>30 min)
if [ ! -f "$USAGE_FILE" ]; then
  echo "$(date): No usage data found" >> "$LOG_FILE"
  exit 0
fi

FETCHED_AT=$(jq -r .fetchedAt "$USAGE_FILE")
FETCHED_EPOCH=$(date -f "%Y-%m-%dT%H:%M:%SZ" "+%s" <<< "$FETCHED_AT")
NOW_EPOCH=$(date "+%s")
AGE_SECS=$((NOW_EPOCH - FETCHED_EPOCH))

if [ $AGE_SECS -gt 1800 ]; then
  echo "$(date): Usage data stale (${AGE_SECS}s old)" >> "$LOG_FILE"
  exit 0
fi

PACE_DELTA=$(jq -r .weeklyPaceDeltaMs "$USAGE_FILE")
PACE_STATUS=$(jq -r .weeklyPaceStatus "$USAGE_FILE")

# Check if behind pace threshold
if [ "$PACE_DELTA" -gt "$PACE_THRESHOLD_MS" ]; then
  HOURS_BEHIND=$(echo "scale=1; $PACE_DELTA / -3600000" | bc)
  echo "$(date): Not behind pace threshold (${HOURS_BEHIND}h behind, need 2h+)" >> "$LOG_FILE"
  exit 0
fi

# Behind pace — check for prompts in queue
if [ ! -f "$QUEUE_FILE" ]; then
  echo "$(date): No prompt queue found at $QUEUE_FILE" >> "$LOG_FILE"
  exit 0
fi

HOURS_BEHIND=$(echo "scale=1; $PACE_DELTA / -3600000" | bc)
echo "$(date): Behind pace by ${HOURS_BEHIND}h, checking prompt queue" >> "$LOG_FILE"

# Extract first todo prompt from queue (skip completed and error statuses)
# Use awk to parse sections and find the first STATUS: todo
TEMP_REPO=$(mktemp)
TEMP_PROMPT=$(mktemp)
trap "rm -f $TEMP_REPO $TEMP_PROMPT" EXIT

awk -v repo_file="$TEMP_REPO" -v prompt_file="$TEMP_PROMPT" '
BEGIN { in_section = 0; found_todo = 0; current_status = ""; current_repo = "" }

/^===+$/ {
  in_section = 1
  current_status = ""
  current_repo = ""
  next
}

in_section && /^STATUS:/ {
  gsub(/^STATUS:[ ]*/, "")
  gsub(/[ ]*$/, "")
  current_status = $0
  next
}

in_section && /^REPO:/ {
  gsub(/^REPO:[ ]*/, "")
  gsub(/[ ]*$/, "")
  gsub(/~/, ENVIRON["HOME"])
  current_repo = $0
  next
}

in_section && !found_todo && current_status == "todo" && !/^[A-Z]+:/ {
  # Prompt content (not a header line)
  if (current_repo == "") {
    current_repo = ENVIRON["HOME"] "/code/auto-claude"
  }
  # Print repo and prompt only once
  if (!system("test -s " repo_file)) {
    print >> prompt_file
  } else {
    print current_repo > repo_file
    print > prompt_file
    found_todo = 1
  }
}
' "$QUEUE_FILE"

# Check if we found a todo prompt
if [ ! -s "$TEMP_REPO" ] || [ ! -s "$TEMP_PROMPT" ]; then
  echo "$(date): No todo prompts in queue (all completed or error)" >> "$LOG_FILE"
  exit 0
fi

WORK_REPO=$(head -1 "$TEMP_REPO")
WORK_PROMPT=$(cat "$TEMP_PROMPT")

echo "$(date): Found todo prompt (repo: $WORK_REPO)" >> "$LOG_FILE"
mkdir -p "$WORK_REPO"

# Run claude from the specified repo
cd "$WORK_REPO"
claude -p "$WORK_PROMPT" \
  --permission-mode auto \
  --bare \
  --output-format json >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "$(date): Prompt execution completed with exit code $EXIT_CODE" >> "$LOG_FILE"

# Update queue file: replace first "STATUS: todo" with "STATUS: completed" or "STATUS: error"
if [ $EXIT_CODE -eq 0 ]; then
  NEW_STATUS="completed"
else
  NEW_STATUS="error"
fi

TEMP_QUEUE=$(mktemp)
awk -v new_status="$NEW_STATUS" '
BEGIN { replaced = 0 }
/^STATUS: todo$/ && !replaced {
  print "STATUS: " new_status
  replaced = 1
  next
}
{ print }
' "$QUEUE_FILE" > "$TEMP_QUEUE"
mv "$TEMP_QUEUE" "$QUEUE_FILE"

echo "$(date): Queue updated (first todo → $NEW_STATUS)" >> "$LOG_FILE"
exit $EXIT_CODE
```

**Design notes:**
- Reads from `.claude-scripts/prompts.queue.txt` instead of hardcoded prompt
- Finds first `STATUS: todo` section (skips `completed` and `error`)
- Extracts repo path (defaults to `~/code/auto-claude`) and multi-line prompt text
- Runs `claude -p` from the specified repo directory, creating it if needed
- Automatically updates the first todo's status to `completed` (exit 0) or `error` (non-zero)
- Logs all activity to `.claude-scripts/autonomous-work.log` for debugging
- Exits silently if queue is missing, empty, or no todo prompts remain
- `--bare` flag makes it reproducible in CI (no hooks)
- `--output-format json` for structured results

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
    <string>/bin/bash</string>
    <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts/run-autonomous-work.sh</string>
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
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer</string>
</dict>
</plist>
```

**To install:**
```bash
# Script is already in repo at .claude-scripts/run-autonomous-work.sh
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
Chrome Extension                    Project Root
├── src/lib/usagePace.ts            .claude-scripts/
│   └── derives pace delta           ├── run-autonomous-work.sh (executable script)
│                                    ├── usage.json (runtime, gitignored)
├── src/extension/usageStorage.ts   ├── autonomous-work.log (runtime, gitignored)
│   └── writes usage + pace          └── system.log (runtime, gitignored)
│       to .claude-scripts/usage.json
└── (5-min refresh via alarms)      prompts.queue.txt (checked in, user-editable)
                                    ├── STATUS: todo|completed|error (auto-updated)
                                    ├── REPO: ~/path/to/project
                                    └── prompt text (multiline)

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
- Add `writeCurrentUsageSnapshot()` to `usageStorage.ts`
  - Derives `weeklyPaceDeltaMs` and `weeklyPaceStatus` from existing pace engine
  - Writes to `.claude-scripts/usage.json`
  - Creates `.claude-scripts/` directory if missing
- Call it after every successful usage fetch in `serviceWorker.ts`
- Add `.claude-scripts/` to `.gitignore`
- **Exit criterion:** `.claude-scripts/usage.json` is written on every refresh, contains valid JSON with pace delta

### Phase 1 — Shell script scaffolding
- Create `.claude-scripts/run-autonomous-work.sh`
- Implement pace checks (usage file freshness, threshold comparison)
- Implement queue parsing logic (read first `STATUS: todo` section)
- Extract REPO and prompt text correctly
- Make it executable: `chmod +x .claude-scripts/run-autonomous-work.sh`
- Test manually: `bash .claude-scripts/run-autonomous-work.sh` runs without error
- Verify logs appear in `.claude-scripts/autonomous-work.log`
- **Exit criterion:** Script parses queue correctly, exits cleanly (logs "no todo prompts" if queue missing/empty)

### Phase 2 — Prompt queue and status tracking
- Create `.claude-scripts/prompts.queue.txt` with sample todo prompts
- Verify script correctly finds and extracts first `STATUS: todo` prompt
- Verify script correctly updates status: `STATUS: todo` → `STATUS: completed` (on success) or `STATUS: error` (on failure)
- Test with a simple prompt that logs something and exits 0
- Test error case: run with a prompt that exits non-zero, verify status becomes `error`
- Test queue progression: run twice, verify first prompt completes and second runs
- **Exit criterion:** Queue parsing and status updates work correctly; prompts run in the specified directories

### Phase 3 — Claude Code integration
- Replace test prompts with real work prompts (analyze code, run tests, etc.)
- Test manually: `bash .claude-scripts/run-autonomous-work.sh` from project root
- Verify `claude -p` runs autonomously and output is captured
- Test that status updates persist across runs
- **Exit criterion:** Claude Code executes with real prompts, logs are readable, status tracking works end-to-end

### Phase 4 — Scheduling
- Create the launchd plist file
- Install via `launchctl load`
- Verify via `launchctl list`
- Wait for next 2 AM or manually trigger for testing
- Review logs in `.claude-scripts/system.log` and `.claude-scripts/autonomous-work.log`
- Verify queue status updates automatically
- **Exit criterion:** launchd fires at scheduled time, script runs, queue progresses

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
- Extension writes pace data to `.claude-scripts/usage.json` on every refresh ✅
- Shell script reads pace delta and exits if on-pace (not behind threshold) ✅
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
