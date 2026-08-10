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
- After every successful usage fetch, write a normalized JSON file to `.claude-usage.json` (repo root)
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
- Overwrite on each refresh (not append — the script reads the latest)

**Git configuration:**
- Add `.claude-usage.json` to `.gitignore` (runtime artifact)

**Why this way:**
- Decouples the extension from the scheduler (no IPC/HTTP needed)
- File is co-located with code that depends on it
- Simple to debug (just look at `.claude-usage.json` in the project)
- Pace delta already computed by the extension's pace engine, just needs exposure

---

## 2. Shell script: Check pace and invoke Claude Code

Create `~/.claude-scripts/run-autonomous-work.sh`:

```bash
#!/bin/bash
set -eu

PROJECT_ROOT="$(pwd)"
USAGE_FILE="$PROJECT_ROOT/.claude-usage.json"
LOG_FILE="$PROJECT_ROOT/.claude-scripts-log"
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

# Behind pace — run autonomous Claude Code work
HOURS_BEHIND=$(echo "scale=1; $PACE_DELTA / -3600000" | bc)
echo "$(date): Starting autonomous work (${HOURS_BEHIND}h behind pace)" >> "$LOG_FILE"

claude -p "$(cat <<'PROMPT'
You have full shell and file access. Do useful work to help catch up on weekly quota burn.

You are behind pace by multiple hours. Do something productive with this session:
- Analyze recent code and suggest/implement improvements
- Run tests and fix failures
- Review open TODOs and tackle one
- Refactor or optimize something

Work autonomously. Aim for 30-60 min of focused work.
PROMPT
)" \
  --permission-mode auto \
  --bare \
  --output-format json >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
echo "$(date): Work completed with exit code $EXIT_CODE" >> "$LOG_FILE"
exit $EXIT_CODE
```

**Design notes:**
- Log to `~/.claude-scripts/autonomous-work.log` — keep output for review
- Pace threshold is configurable (default 2 hours behind)
- Negative values mean behind pace; positive means on-track or ahead
- Exits silently if data is missing, stale, or pace is acceptable
- The prompt explains the context (falling behind) to help Claude understand the goal
- `--bare` flag makes it reproducible in CI (no hooks)
- `--output-format json` for structured results

---

## 3. macOS scheduling: launchd configuration

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
    <string>/Users/michaelbylstra/.claude-scripts/run-autonomous-work.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts-log</string>
  <key>StandardErrorPath</key>
  <string>/Users/michaelbylstra/code/current/claude-usage-optimizer/.claude-scripts-log</string>
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
mkdir -p ~/.claude-scripts
# (create the plist file)
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

## 4. Architecture and constraints

```
Chrome Extension                    Local Scheduling
├── src/lib/usagePace.ts            Project Root
│   └── derives pace delta           ├── .claude-usage.json (runtime, gitignored)
│                                    └── .claude-scripts-log (runtime, gitignored)
├── src/extension/usageStorage.ts   
│   └── writes usage + pace          ~/.claude-scripts/
│       to .claude-usage.json        └── run-autonomous-work.sh
│                                    
└── (5-min refresh via alarms)      ~/Library/LaunchAgents/
                                    └── com.claudeusageoptimizer.autonomouswork.plist
```

**Key design decisions:**

1. **Pace-based trigger, not credit-based** — Ensures consistent burn rate across the week. If you fall behind, Claude does work to catch up; if ahead, nothing runs. Natural equilibrium.
2. **Filesystem as IPC** — Simpler than HTTP, no extra process to manage, file serves as both contract and debugging aid.
3. **JSON format** — Human-readable, `jq` is standard on macOS, no custom parsing needed.
4. **Threshold configurable in script** — Pace target can be adjusted without rebuilding extension (default 2 hours behind).
5. **launchd, not cron** — Native to macOS, respects system sleep/wake, properly manages environment.
6. **Autonomous Claude Code, not API** — Uses subscription credits directly, full shell access, no separate API keys.
7. **No cost if on pace** — System is passive by default; work only triggers when needed.

---

## 5. Implementation phases

### Phase 0 — Data exposure
- Add `writeCurrentUsageSnapshot()` to `usageStorage.ts`
  - Derives `weeklyPaceDeltaMs` and `weeklyPaceStatus` from existing pace engine
  - Writes to `.claude-usage.json` in project root
- Call it after every successful usage fetch in `serviceWorker.ts`
- Add `.claude-usage.json` and `.claude-scripts-log` to `.gitignore`
- **Exit criterion:** `.claude-usage.json` is written on every refresh, contains valid JSON with pace delta

### Phase 1 — Script scaffolding
- Create `~/.claude-scripts/run-autonomous-work.sh` with stub work (just logs)
- Test that `bash ~/.claude-scripts/run-autonomous-work.sh` runs without error
- Verify that log output lands in `~/.claude-scripts/autonomous-work.log`
- **Exit criterion:** script runs, logs successful execution, correct credits read from JSON

### Phase 2 — Claude Code integration
- Replace stub with real `claude -p` invocation
- Define actual work prompt (adjust the example as needed)
- Test manually: `bash ~/.claude-scripts/run-autonomous-work.sh`
- Verify Claude Code runs and logs output correctly
- **Exit criterion:** Claude Code executes autonomously, output is captured in log

### Phase 3 — Scheduling
- Create the launchd plist file
- Install via `launchctl load`
- Verify via `launchctl list`
- Wait for next 2 AM or manually trigger for testing
- Review logs in `~/.claude-scripts/launchd.log` and `~/.claude-scripts/autonomous-work.log`
- **Exit criterion:** launchd fires at scheduled time, script runs, output is logged

### Phase 4 — Polish
- Add config file for threshold (or make it hardcoded)
- Document the setup in `CLAUDE.md`
- Provide install/uninstall instructions
- **Exit criterion:** User can install in one copy-paste, understand what is running, easily disable

---

## 6. Open decisions

1. **Work definition** — What should the autonomous Claude Code session actually do?
   - Analyze recent changes and suggest improvements?
   - Run project maintenance tasks (rebuild, test, lint)?
   - Process external data or generate reports?
   - **Recommend:** Start broad ("do something productive"). Make it easy to customize per repo/user. Prompt in the script, not the extension.

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

5. **Session length** — How long should autonomous work run?
   - Currently: no limit (script runs until Claude finishes)
   - Could add: timeout, or prompt Claude to work for N minutes
   - **Recommend:** No time limit initially. Logs show actual duration. Can add timeout later if needed.

---

## 7. Risks and unknowns

1. **Claude Code in non-interactive mode** — The `-p` flag is documented but not heavily tested with full autonomous work. Early runs should be monitored.

2. **launchd timing** — If the machine is asleep at 2 AM, the job fires when it wakes. This is probably fine but worth noting.

3. **Pace calculation accuracy** — Pace is derived from API assumptions (e.g., fixed 7-day window). If weekly window is actually rolling, pace will drift. Mitigated by extension already collecting history data for verification.

4. **Prompt quality** — The example prompt is generic. Real value comes from defining useful work — this will likely iterate based on actual results.

5. **Interaction with user sessions** — If the user is actively working at 2 AM and Claude Code is running autonomously, there could be conflicts (file edits, directory changes, etc.). Mitigated by running at night but worth documenting.

6. **Over-correction** — If pace threshold is too aggressive, Claude may run work frequently even when not beneficial. Mitigated by starting conservative (2h) and user being able to adjust.

---

## 8. Success criteria

- Extension computes weekly pace delta via existing pace engine ✅
- Extension writes pace data to `.claude-usage.json` (repo root) on every refresh ✅
- Shell script reads pace delta and exits if on-pace (not behind threshold) ✅
- Shell script triggers when behind by 2+ hours ✅
- `claude -p` invocation runs successfully and logs output ✅
- launchd fires at 2 AM and script executes automatically ✅
- User can enable/disable the feature easily (install/uninstall launchd plist) ✅
- User can adjust pace threshold in script without rebuilding ✅
- Logs are human-readable and useful for debugging ✅
- System enters natural equilibrium: behind pace → work runs → catches up → work stops ✅
