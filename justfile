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

# Schedule the nightly 2 AM run
install-autonomous-work:
    @command -v uv >/dev/null || { echo "uv not found on PATH"; exit 1; }
    @command -v claude >/dev/null || { echo "claude not found on PATH"; exit 1; }
    mkdir -p "{{ home_directory() }}/Library/LaunchAgents"
    launchctl unload {{ launch_agent_plist }} 2>/dev/null || true
    sed -e 's|__PROJECT_ROOT__|{{ justfile_directory() }}|g' \
        -e 's|__HOME__|{{ home_directory() }}|g' \
        .claude-scripts/{{ launch_agent_label }}.plist > {{ launch_agent_plist }}
    launchctl load {{ launch_agent_plist }}
    @echo "Loaded {{ launch_agent_label }} — runs daily at 02:00"

# Unschedule the nightly run
uninstall-autonomous-work:
    launchctl unload {{ launch_agent_plist }} 2>/dev/null || true
    rm -f {{ launch_agent_plist }}
    @echo "Removed {{ launch_agent_label }}"

# Is the nightly run scheduled?
autonomous-status:
    @launchctl list | grep {{ launch_agent_label }} || echo "not loaded"

# Zip dist/ for a Chrome Web Store upload
package: build
    rm -f claude-usage-optimizer.zip
    cd dist && zip -r ../claude-usage-optimizer.zip . -x '.*'
    @echo "Wrote claude-usage-optimizer.zip"
