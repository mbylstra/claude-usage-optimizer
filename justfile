# Claude Usage Optimizer — every command for this project lives here.

# List available recipes
default:
    @just --list

# Install dependencies
[working-directory('chrome-extension')]
install:
    pnpm install

# Everything a fresh clone needs, in one go. Safe to re-run.
setup: install install-shadcn-components build install-private-uv install-usage-host install-autonomous-work
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f prompts.txt ]; then
      echo "prompts.txt already exists — left alone"
    else
      cp prompts.example.txt prompts.txt
      echo "Created prompts.txt from prompts.example.txt"
    fi
    extension_id="$(python3 backend/extension-id.py "{{ justfile_directory() }}/chrome-extension/dist")"
    echo
    echo "Done. The nightly run is scheduled — 'just autonomous-settings' for the"
    echo "time, 'just uninstall-autonomous-work' to unschedule it."
    echo
    echo "One step is left, because only you can click through chrome://extensions:"
    echo
    echo "   Load the extension. chrome://extensions, enable Developer mode,"
    echo "   'Load unpacked', and choose:"
    echo "       {{ justfile_directory() }}/chrome-extension/dist"
    echo "   Then reload it, so it picks up the native host."
    echo "   If the popup cannot reach the host, re-run 'just install-usage-host'"
    echo "   (safe any time). Still stuck? Chrome is showing an ID other than"
    echo "   $extension_id — pass the one it shows:"
    echo "       just install-usage-host THE_ID_CHROME_SHOWS"
    echo
    echo "Then put some work in prompts.txt and try: just autonomous-dry-run"
    echo
    echo "Prefer to queue work from your phone? The queue can live on a Jira"
    echo "board instead of prompts.txt — reorder it by dragging a card, and read"
    echo "what each run did in the card's comments. It needs a free Atlassian"
    echo "account, and setup is not run here because it has to ask you things:"
    echo "       just install-jira-queue"
    echo
    echo "If your prompts will read ~/Documents, ~/Desktop or ~/Downloads: click"
    echo "the extension's toolbar icon in Chrome, open Settings, press 'Grant"
    echo "folder access', and allow the macOS dialogs that appear."
    echo "To check afterwards: just check-folder-access"

# The UI primitives that come from shadcn rather than being hand-written. Listed
# here because the recipe below only manages these — the rest of components/ui/
# predates shadcn being wired up and is ours to maintain.
shadcn_components := "select"

# Adds only what is missing, and never overwrites — so it is safe to re-run at
# any point, like every other install-* recipe. `refresh-shadcn-components` is
# the deliberate way to take upstream's newer version of one.

# Fetch any shadcn component this project uses but does not have
[working-directory('chrome-extension')]
install-shadcn-components:
    #!/usr/bin/env bash
    set -euo pipefail
    for component in {{ shadcn_components }}; do
      if [ -f "components/ui/$component.tsx" ]; then
        echo "shadcn $component already present — left alone"
      else
        echo "Adding shadcn $component…"
        pnpm exec shadcn add "$component" --yes
      fi
    done

# Re-fetch them from upstream, discarding any local edits. Rarely what you want.
[working-directory('chrome-extension')]
refresh-shadcn-components:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "This overwrites components/ui/ from upstream shadcn, so any local edit"
    echo "to one of these is lost: {{ shadcn_components }}"
    echo "Check 'git diff' afterwards before committing."
    pnpm exec shadcn add {{ shadcn_components }} --overwrite --yes

# Vite dev server for the popup UI (no chrome.* APIs available)
[working-directory('chrome-extension')]
dev:
    pnpm exec vite

# The run-log window UI, driven by fixture events — no extension, no host, no run
[working-directory('chrome-extension')]
run-log-preview:
    pnpm exec vite --open /run-log-preview.html

# Production build of the unpacked extension into chrome-extension/dist/
[working-directory('chrome-extension')]
build:
    pnpm exec vite build
    pnpm exec vite build --config vite.config.serviceWorker.ts

# Lint
[working-directory('chrome-extension')]
lint:
    pnpm exec eslint .

# Rewrite files with Prettier
[working-directory('chrome-extension')]
format:
    pnpm exec prettier --write .

# Fail if anything is not Prettier-formatted
[working-directory('chrome-extension')]
format-check:
    pnpm exec prettier --check .

# Type-check without emitting
[working-directory('chrome-extension')]
typecheck:
    pnpm exec tsc --noEmit

# Regenerate the toolbar icons in public/icons/
[working-directory('chrome-extension')]
icons:
    pnpm exec node scripts/generateIcons.js

# Pre-commit gate: everything that must pass before work is considered done
check: typecheck lint format-check

### Autonomous work — see plans/autonomous-credit-utilization.md

# The same entry point launchd uses, so a manual run exercises the real path
autonomous_script := "backend/claude-usage-autonomous-work"
launch_agent_label := "com.claudeusageoptimizer.autonomouswork"
launch_agent_plist := home_directory() / "Library/LaunchAgents" / launch_agent_label + ".plist"
# The unscheduled twin the popup's "Run now" kickstarts, so that run belongs to
# launchd rather than to Chrome — see CLAUDE.md, "Triggering a run from the popup"
on_demand_label := launch_agent_label + ".ondemand"
on_demand_plist := home_directory() / "Library/LaunchAgents" / on_demand_label + ".plist"
# The one-shot agent a run writes for itself when it hits the 5-hour window, so
# the queue is picked back up once that window resets — see
# plans/resume-after-five-hour-reset.md. Written by runs, never by setup.
resume_label := launch_agent_label + ".resume"
resume_plist := home_directory() / "Library/LaunchAgents" / resume_label + ".plist"

# The uv this job runs, so the folder grants attach to a binary nothing else
# uses. Named for the project rather than "uv" because System Settings lists an
# unbundled binary by its filename, and two rows both called "uv" are
# indistinguishable. Measured to make no difference to what is readable — kept because the
# grant lands somewhere regardless, and here is no worse. See CLAUDE.md.
private_uv := justfile_directory() / "backend/bin/claude-usage-optimizer-uv"

# Copy uv into backend/bin/, once, with its own code-signing identity
install-private-uv:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -x "{{ private_uv }}" ]; then
      echo "Private uv already installed — frozen at $("{{ private_uv }}" --version)"
      exit 0
    fi
    source_uv="$(command -v uv)" || { echo "uv not found on PATH"; exit 1; }
    mkdir -p "$(dirname "{{ private_uv }}")"
    cp "$source_uv" "{{ private_uv }}"
    # Its own identifier, so macOS sees a separate client rather than a
    # byte-identical twin sharing the original's signature.
    codesign --force --sign - \
      --identifier com.claudeusageoptimizer.autonomouswork.uv \
      "{{ private_uv }}" 2>/dev/null
    echo "Copied $source_uv -> {{ private_uv }}"

# Replace the frozen uv with whatever is on PATH now. Rarely what you want.
refresh-private-uv:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Replacing the private uv changes its code signature, and any folder"
    echo "permissions you granted are attached to that signature — macOS may ask"
    echo "about ~/Documents and ~/Desktop again after this."
    rm -f "{{ private_uv }}"
    just install-private-uv

# What the *nightly* run can actually read. Must go through launchd: run from a
# terminal and the answer is Terminal's permissions, not the job's.
[no-exit-message]
check-folder-access:
    #!/usr/bin/env bash
    set -euo pipefail
    label="com.claudeusageoptimizer.folderaccesscheck"
    uv_path="{{ private_uv }}"
    [ -x "$uv_path" ] || uv_path="$(command -v uv)" || { echo "uv not found"; exit 1; }
    work="$(mktemp -d)"
    trap 'launchctl unload "$work/job.plist" 2>/dev/null || true; rm -rf "$work"' EXIT
    cat > "$work/job.plist" <<PLIST
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>Label</key><string>$label</string>
      <key>ProgramArguments</key><array>
        <string>$uv_path</string><string>run</string><string>--script</string>
        <string>{{ justfile_directory() }}/backend/check-folder-access.py</string>
      </array>
      <key>StandardOutPath</key><string>$work/report.txt</string>
      <key>StandardErrorPath</key><string>$work/report.txt</string>
      <key>EnvironmentVariables</key><dict>
        <key>PATH</key><string>{{ home_directory() }}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>HOME</key><string>{{ home_directory() }}</string>
      </dict>
      <key>RunAtLoad</key><false/>
    </dict></plist>
    PLIST
    launchctl unload "$work/job.plist" 2>/dev/null || true
    launchctl load "$work/job.plist"
    launchctl start "$label"
    for _ in $(seq 1 40); do
      grep -q "Mobile Documents" "$work/report.txt" 2>/dev/null && break
      sleep 1
    done
    echo "What the nightly run can read (measured through launchd):"
    echo
    cat "$work/report.txt"


# Run the next queued prompt now, if weekly usage is behind pace
[no-exit-message]
trigger-autonomous-work *args:
    {{ autonomous_script }} {{ args }}

# Show what would run next, without invoking Claude or touching the queue
[no-exit-message]
autonomous-dry-run:
    {{ autonomous_script }} --force --dry-run

# Stop any in-flight run, and clear any resume it had scheduled for itself
[no-exit-message]
cancel-autonomous-work:
    @python3 backend/cancel-autonomous-work.py

# Is a resume pending, and is launchd holding it?
[no-exit-message]
autonomous-resume-status:
    @python3 backend/autonomous_work_resume.py
    @echo
    @launchctl list | grep {{ resume_label }} || echo "launchd is not holding a resume"

# Unschedule a pending resume without touching anything else
[no-exit-message]
cancel-autonomous-resume:
    @python3 backend/autonomous_work_resume.py --cancel

# Is a run in flight right now?
[no-exit-message]
autonomous-running:
    @pgrep -fl "run-autonomous-work|claude -p" || echo "nothing running"

# Follow the run log live (ctrl-C to stop watching; the run keeps going)
[no-exit-message]
autonomous-log lines="40":
    @touch backend/autonomous-work.log
    @tail -n {{ lines }} -f backend/autonomous-work.log

# The morning-after digest for a day (default: the most recent one written)
[no-exit-message]
autonomous-summary day="":
    #!/usr/bin/env bash
    set -euo pipefail
    summaries_directory="{{ justfile_directory() }}/summaries"
    if [ -n "{{ day }}" ]; then
      summary_file="$summaries_directory/{{ day }}.md"
    else
      # `|| true` because pipefail would otherwise make an empty (or absent)
      # summaries folder exit the recipe silently, before the message below.
      summary_file="$(ls -1 "$summaries_directory"/*.md 2>/dev/null | tail -n 1 || true)"
    fi
    if [ -z "${summary_file:-}" ] || [ ! -f "$summary_file" ]; then
      echo "No summary to show. One is written whenever a session runs at least"
      echo "one prompt — 'ls summaries/' for the days that have one."
      exit 0
    fi
    echo "$summary_file"
    echo
    cat "$summary_file"

# Follow the raw stream-json events, for when a summary line is not enough
[no-exit-message]
autonomous-log-raw lines="10":
    @touch backend/autonomous-work.jsonl
    @tail -n {{ lines }} -f backend/autonomous-work.jsonl

# Start a run and follow it in one go
[no-exit-message]
autonomous-run-and-watch:
    #!/usr/bin/env bash
    set -euo pipefail
    touch backend/autonomous-work.log
    tail -n 0 -f backend/autonomous-work.log &
    tail_pid=$!
    trap 'kill $tail_pid 2>/dev/null || true' EXIT
    {{ autonomous_script }} --force || true
    sleep 0.5

# "Run now" in the popup puts Chrome in the process chain, so every file the run
# writes inherits com.apple.quarantine — including the ad-hoc-signed .node module
# `claude` unpacks the first time a prompt touches an image. macOS then blocks
# loading it behind an "Apple could not verify..." dialog, and the run stalls
# until somebody clicks. launchd has no quarantine agent above it, so the nightly
# job should not see this at all. This recipe is the only way to check that:
# started from a terminal the run has no quarantine agent either, and would look
# clean whatever the truth is.
#
# Waits for the run to finish, or for the timeout argument. Ctrl-C stops the run.
#
# Run the queued prompt through launchd as the nightly job does, and check for the quarantine stamp
[no-exit-message]
test-launchd-run timeout="900":
    #!/usr/bin/env bash
    set -euo pipefail
    label="{{ launch_agent_label }}.launchdtest"
    # The module is unpacked into TMPDIR and deleted again when claude exits, so
    # it can only be caught while the run is in flight. Pinning the job's TMPDIR
    # to ours just fixes where to watch — the quarantine stamp comes from process
    # ancestry, not from the path.
    module_directory="${TMPDIR:-/tmp}"
    work="$(mktemp -d)"
    sightings="$work/native-modules.txt"
    : > "$sightings"

    if {{ autonomous_script }} --force --dry-run 2>&1 | grep -q "No todo prompts"; then
      echo "Nothing marked 'todo' in prompts.txt — there would be no run to measure."
      exit 1
    fi

    cat > "$work/job.plist" <<PLIST
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
      <key>Label</key><string>$label</string>
      <key>ProgramArguments</key><array>
        <string>{{ justfile_directory() }}/{{ autonomous_script }}</string>
        <string>--force</string>
      </array>
      <key>WorkingDirectory</key><string>{{ justfile_directory() }}</string>
      <key>StandardOutPath</key><string>$work/system.log</string>
      <key>StandardErrorPath</key><string>$work/system.log</string>
      <key>EnvironmentVariables</key><dict>
        <key>PATH</key><string>{{ home_directory() }}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key><string>{{ home_directory() }}</string>
        <key>TMPDIR</key><string>$module_directory</string>
      </dict>
      <key>RunAtLoad</key><false/>
    </dict></plist>
    PLIST

    watcher_pid=""
    tail_pid=""
    # Unloading the job SIGTERMs the scheduler but leaves the claude session it
    # spawned running — see CLAUDE.md, "Cancelling". So stop it the way the rest
    # of the project does, and only then take the job definition away.
    stop_run_if_still_going() {
      launchctl list "$label" 2>/dev/null | grep -q '"PID"' || return 0
      python3 backend/cancel-autonomous-work.py >/dev/null 2>&1 || true
    }
    cleanup() {
      [ -n "$watcher_pid" ] && kill "$watcher_pid" 2>/dev/null || true
      [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null || true
      stop_run_if_still_going
      launchctl unload "$work/job.plist" 2>/dev/null || true
    }
    trap cleanup EXIT

    while :; do
      find "$module_directory" -maxdepth 1 -name '*.node' 2>/dev/null | while read -r module; do
        printf '%s\t%s\t[%s]\n' "$(date +%T)" "$module" \
          "$(xattr "$module" 2>/dev/null | tr '\n' ' ')" >> "$sightings"
      done
      sleep 0.25
    done &
    watcher_pid=$!

    touch backend/autonomous-work.log
    tail -n 0 -f backend/autonomous-work.log &
    tail_pid=$!

    launchctl unload "$work/job.plist" 2>/dev/null || true
    launchctl load "$work/job.plist"
    launchctl start "$label"

    # `launchctl list` prints a "PID" key only while the process is alive: wait
    # for it to appear, then for it to go.
    for _ in $(seq 1 30); do
      launchctl list "$label" 2>/dev/null | grep -q '"PID"' && break
      sleep 1
    done
    deadline=$(( SECONDS + {{ timeout }} ))
    while launchctl list "$label" 2>/dev/null | grep -q '"PID"'; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "Timed out after {{ timeout }}s — stopping the run."
        stop_run_if_still_going
        break
      fi
      sleep 2
    done

    kill "$watcher_pid" 2>/dev/null || true
    kill "$tail_pid" 2>/dev/null || true
    watcher_pid=""
    tail_pid=""

    echo
    echo "Native modules unpacked during the run, in $module_directory:"
    if [ -s "$sightings" ]; then
      sort -u -t"$(printf '\t')" -k2,3 "$sightings" | while IFS= read -r sighting; do
        echo "    $sighting"
      done
    else
      echo "    none seen"
    fi
    echo

    if [ -s "$work/system.log" ]; then
      echo "Job output:"
      sed 's/^/    /' "$work/system.log"
      echo
    fi

    if [ ! -s "$sightings" ]; then
      echo "Inconclusive. claude only unpacks the module when a prompt does image"
      echo "work — reads a PNG, takes a screenshot — so queue a prompt that does."
    elif grep -q "com.apple.quarantine" "$sightings"; then
      echo "QUARANTINED under launchd. Unexpected: the nightly run would hit the"
      echo "same Gatekeeper block that 'Run now' does."
      exit 1
    else
      echo "No quarantine stamp — the nightly run raises no Gatekeeper dialog."
    fi

# Schedule the nightly run, at whatever time the extension's settings say (2 AM by default)
install-autonomous-work: install-private-uv
    @command -v claude >/dev/null || { echo "claude not found on PATH"; exit 1; }
    @python3 backend/autonomous_work_settings.py --install

# Show the scheduled time and new-projects folder the extension has stored
[no-exit-message]
autonomous-settings:
    @python3 backend/autonomous_work_settings.py

# Unschedule the nightly run
uninstall-autonomous-work:
    launchctl unload {{ launch_agent_plist }} 2>/dev/null || true
    rm -f {{ launch_agent_plist }}
    launchctl unload {{ on_demand_plist }} 2>/dev/null || true
    rm -f {{ on_demand_plist }}
    # A pending resume would otherwise fire days after unattended work was
    # switched off, which is the one thing uninstalling it must not allow.
    @python3 backend/autonomous_work_resume.py --cancel
    @echo "Removed {{ launch_agent_label }}, {{ on_demand_label }} and {{ resume_label }}"

# Is the nightly run scheduled? Lists all three jobs — nightly, "Run now", resume
autonomous-status:
    @launchctl list | grep {{ launch_agent_label }} || echo "not loaded"

native_host_name := "com.claudeusageoptimizer.usagehost"
native_host_dir := home_directory() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Print the extension ID Chrome derives from dist/
[no-exit-message]
extension-id:
    @python3 backend/extension-id.py "{{ justfile_directory() }}/chrome-extension/dist"

# Register the native host that writes backend/claude-usage.json.
# Rewrites the manifest from the template every time, so re-running is safe at
# any point and always produces the same file for the same dist/ path.
install-usage-host extension_id="":
    #!/usr/bin/env bash
    set -euo pipefail
    extension_id="{{ extension_id }}"
    if [ -z "$extension_id" ]; then
      extension_id="$(python3 backend/extension-id.py "{{ justfile_directory() }}/chrome-extension/dist")"
    fi
    mkdir -p "{{ native_host_dir }}"
    chmod +x backend/usage-host.py
    sed -e 's|__PROJECT_ROOT__|{{ justfile_directory() }}|g' \
        -e "s|__EXTENSION_ID__|$extension_id|g" \
        "backend/{{ native_host_name }}.json" \
        > "{{ native_host_dir }}/{{ native_host_name }}.json"
    echo "Registered {{ native_host_name }} for extension $extension_id"
    echo "Check that ID matches chrome://extensions, then reload the extension."

# Remove the native host registration
uninstall-usage-host:
    rm -f "{{ native_host_dir }}/{{ native_host_name }}.json"
    @echo "Removed {{ native_host_name }}"

# Exercise the native host directly, without Chrome
[no-exit-message]
test-usage-host:
    @python3 backend/test-usage-host.py

# Unit tests for the pure logic in run-autonomous-work.py and autonomous_work_settings.py
[no-exit-message]
test-autonomous-work:
    @uv run --script backend/tests/run_tests.py

### The queue as a Jira board — see plans/work-queue-as-a-jira-board.md
### and plans/company-managed-jira-project.md

jira_script := "backend/queue_source_jira.py"

# Credential, a company-managed project, its issue type scheme (defaults to
# Task), workflow statuses (with global transitions), board columns — all five —
# and the Repository and Model card dropdowns, scripted end to end. Safe to
# re-run: it creates only what is missing, and leaves an existing project
# entirely alone (use jira-configure-project to re-apply config against one).

# Set the queue up on a Jira board
[no-exit-message]
install-jira-queue project_key="":
    @python3 {{ jira_script }} --install {{ project_key }}

# Re-applies the scheme/workflow/column config and the Repository/Model card
# dropdowns against an existing project — the repair path when it has drifted
# from a hand edit, and how an existing board picks up newly added card fields.
# Touches neither the credential nor the settings mirror. --purge cascade-deletes
# the project and the workflow scheme/workflow Jira's own soft delete leaves
# behind, instead.

# Repair a project's scheme, workflow, columns and card fields (or --purge to delete it)
[no-exit-message]
jira-configure-project project_key="" *flags="":
    @python3 {{ jira_script }} --configure-project {{ project_key }} {{ flags }}

# Atlassian caps every API token at one year, so this is an annual errand.

# Rotate the API token, without touching anything else
[no-exit-message]
set-jira-credentials:
    @python3 {{ jira_script }} --set-credentials

# Site, project, credential, days to expiry, column health and queue depth
[no-exit-message]
jira-status:
    @python3 {{ jira_script }} --status

# Which queue the next run will read, and whether it can be read at all
[no-exit-message]
queue-source:
    @python3 {{ jira_script }} --source

# What the next run would pick up, in rank order
[no-exit-message]
queue-list:
    @python3 {{ jira_script }} --list

# One-shot migration of prompts.txt onto the board (the file is left untouched)
[no-exit-message]
import-prompts-to-jira:
    @python3 {{ jira_script }} --import-prompts

# The same work every settings save does, run by hand. Creates the Repository
# field and puts it on the card layout if they are missing, then makes its
# dropdown match the repositories set in the extension's Settings. Only the name
# is sent; a removed repository's option is disabled, never deleted.

# Push the configured repository list to the Jira card's Repository dropdown
[no-exit-message]
jira-sync-repositories:
    @python3 {{ jira_script }} --sync-repositories

# Creates one card on the real site, reads it back through v3 and v2, deletes it.

# Measure what a real prompt survives as through Jira's document model
[no-exit-message]
probe-jira-adf:
    @python3 {{ jira_script }} --probe-adf

# Zip dist/ for a Chrome Web Store upload
package: build
    rm -f claude-usage-optimizer.zip
    cd chrome-extension/dist && zip -r ../../claude-usage-optimizer.zip . -x '.*'
    @echo "Wrote claude-usage-optimizer.zip"
