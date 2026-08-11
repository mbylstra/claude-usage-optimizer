# Claude Usage Optimizer — every command for this project lives here.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Everything a fresh clone needs, in one go. Safe to re-run.
setup: install build install-private-uv install-usage-host install-autonomous-work
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -f prompts.txt ]; then
      echo "prompts.txt already exists — left alone"
    else
      cp prompts.example.txt prompts.txt
      echo "Created prompts.txt from prompts.example.txt"
    fi
    extension_id="$(python3 .claude-scripts/extension-id.py "{{ justfile_directory() }}/dist")"
    echo
    echo "Done. The nightly run is scheduled — 'just autonomous-settings' for the"
    echo "time, 'just uninstall-autonomous-work' to unschedule it."
    echo
    echo "One step is left, because only you can click through chrome://extensions:"
    echo
    echo "   Load the extension. chrome://extensions, enable Developer mode,"
    echo "   'Load unpacked', and choose:"
    echo "       {{ justfile_directory() }}/dist"
    echo "   Then reload it, so it picks up the native host."
    echo "   If the popup cannot reach the host, re-run 'just install-usage-host'"
    echo "   (safe any time). Still stuck? Chrome is showing an ID other than"
    echo "   $extension_id — pass the one it shows:"
    echo "       just install-usage-host THE_ID_CHROME_SHOWS"
    echo
    echo "Then put some work in prompts.txt and try: just autonomous-dry-run"
    echo
    echo "If your prompts will read ~/Documents, ~/Desktop or ~/Downloads: click"
    echo "the extension's toolbar icon in Chrome, open Settings, press 'Grant"
    echo "folder access', and allow the macOS dialogs that appear."
    echo "To check afterwards: just check-folder-access"

# Vite dev server for the popup UI (no chrome.* APIs available)
dev:
    pnpm exec vite

# The run-log window UI, driven by fixture events — no extension, no host, no run
run-log-preview:
    pnpm exec vite --open /run-log-preview.html

# Production build of the unpacked extension into dist/
build:
    pnpm exec vite build
    pnpm exec vite build --config vite.config.serviceWorker.ts

# Lint
lint:
    pnpm exec eslint .

# Rewrite files with Prettier
format:
    pnpm exec prettier --write .

# Fail if anything is not Prettier-formatted
format-check:
    pnpm exec prettier --check .

# Type-check without emitting
typecheck:
    pnpm exec tsc --noEmit

# Regenerate the toolbar icons in public/icons/
icons:
    pnpm exec node scripts/generateIcons.js

# Pre-commit gate: everything that must pass before work is considered done
check: typecheck lint format-check

### Autonomous work — see plans/autonomous-credit-utilization.md

# The same entry point launchd uses, so a manual run exercises the real path
autonomous_script := ".claude-scripts/claude-usage-autonomous-work"
launch_agent_label := "com.claudeusageoptimizer.autonomouswork"
launch_agent_plist := home_directory() / "Library/LaunchAgents" / launch_agent_label + ".plist"

# The uv this job runs, so the folder grants attach to a binary nothing else
# uses. Named for the project rather than "uv" because System Settings lists an
# unbundled binary by its filename, and two rows both called "uv" are
# indistinguishable. Measured to make no difference to what is readable — kept because the
# grant lands somewhere regardless, and here is no worse. See CLAUDE.md.
private_uv := justfile_directory() / ".claude-scripts/bin/claude-usage-optimizer-uv"

# Copy uv into .claude-scripts/bin/, once, with its own code-signing identity
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
        <string>{{ justfile_directory() }}/.claude-scripts/check-folder-access.py</string>
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

# Stop any in-flight run (the scheduler and the claude session it spawned)
[no-exit-message]
cancel-autonomous-work:
    @python3 .claude-scripts/cancel-autonomous-work.py

# Is a run in flight right now?
[no-exit-message]
autonomous-running:
    @pgrep -fl "run-autonomous-work|claude -p" || echo "nothing running"

# Follow the run log live (ctrl-C to stop watching; the run keeps going)
[no-exit-message]
autonomous-log lines="40":
    @touch .claude-scripts/autonomous-work.log
    @tail -n {{ lines }} -f .claude-scripts/autonomous-work.log

# Follow the raw stream-json events, for when a summary line is not enough
[no-exit-message]
autonomous-log-raw lines="10":
    @touch .claude-scripts/autonomous-work.jsonl
    @tail -n {{ lines }} -f .claude-scripts/autonomous-work.jsonl

# Start a run and follow it in one go
[no-exit-message]
autonomous-run-and-watch:
    #!/usr/bin/env bash
    set -euo pipefail
    touch .claude-scripts/autonomous-work.log
    tail -n 0 -f .claude-scripts/autonomous-work.log &
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
      python3 .claude-scripts/cancel-autonomous-work.py >/dev/null 2>&1 || true
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

    touch .claude-scripts/autonomous-work.log
    tail -n 0 -f .claude-scripts/autonomous-work.log &
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
    @python3 .claude-scripts/autonomous_work_settings.py --install

# Show the scheduled time and new-projects folder the extension has stored
[no-exit-message]
autonomous-settings:
    @python3 .claude-scripts/autonomous_work_settings.py

# Unschedule the nightly run
uninstall-autonomous-work:
    launchctl unload {{ launch_agent_plist }} 2>/dev/null || true
    rm -f {{ launch_agent_plist }}
    @echo "Removed {{ launch_agent_label }}"

# Is the nightly run scheduled?
autonomous-status:
    @launchctl list | grep {{ launch_agent_label }} || echo "not loaded"

native_host_name := "com.claudeusageoptimizer.usagehost"
native_host_dir := home_directory() / "Library/Application Support/Google/Chrome/NativeMessagingHosts"

# Print the extension ID Chrome derives from dist/
[no-exit-message]
extension-id:
    @python3 .claude-scripts/extension-id.py "{{ justfile_directory() }}/dist"

# Register the native host that writes .claude-scripts/claude-usage.json.
# Rewrites the manifest from the template every time, so re-running is safe at
# any point and always produces the same file for the same dist/ path.
install-usage-host extension_id="":
    #!/usr/bin/env bash
    set -euo pipefail
    extension_id="{{ extension_id }}"
    if [ -z "$extension_id" ]; then
      extension_id="$(python3 .claude-scripts/extension-id.py "{{ justfile_directory() }}/dist")"
    fi
    mkdir -p "{{ native_host_dir }}"
    chmod +x .claude-scripts/usage-host.py
    sed -e 's|__PROJECT_ROOT__|{{ justfile_directory() }}|g' \
        -e "s|__EXTENSION_ID__|$extension_id|g" \
        ".claude-scripts/{{ native_host_name }}.json" \
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
    @python3 .claude-scripts/test-usage-host.py

# Zip dist/ for a Chrome Web Store upload
package: build
    rm -f claude-usage-optimizer.zip
    cd dist && zip -r ../claude-usage-optimizer.zip . -x '.*'
    @echo "Wrote claude-usage-optimizer.zip"
