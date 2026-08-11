# Claude Usage Optimizer — every command for this project lives here.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Vite dev server for the popup UI (no chrome.* APIs available)
dev:
    pnpm exec vite

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

# Schedule the nightly run, at whatever time the extension's settings say (2 AM by default)
install-autonomous-work:
    @command -v uv >/dev/null || { echo "uv not found on PATH"; exit 1; }
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

# Register the native host that writes .claude-scripts/claude-usage.json
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
