# Claude Usage Optimizer — every command for this project lives here.

# List available recipes
default:
    @just --list

# Install dependencies
install:
    pnpm install

# Vite dev server for the popup UI (no chrome.* APIs available — use Storybook for UI work)
dev:
    pnpm exec vite

# Production build of the unpacked extension into dist/
build:
    pnpm exec vite build
    pnpm exec vite build --config vite.config.serviceWorker.ts

# Run the unit tests once
test:
    pnpm exec vitest run

# Run the unit tests in watch mode
test-watch:
    pnpm exec vitest

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

# Storybook dev server
storybook:
    pnpm exec storybook dev -p 6006

# Static Storybook build
build-storybook:
    pnpm exec storybook build -o dist-storybook

# Regenerate the toolbar icons in public/icons/
icons:
    pnpm exec node scripts/generateIcons.js

# Pre-commit gate: everything that must pass before work is considered done
check: typecheck lint format-check test

# Zip dist/ for a Chrome Web Store upload
package: build
    rm -f claude-usage-optimizer.zip
    cd dist && zip -r ../claude-usage-optimizer.zip . -x '.*'
    @echo "Wrote claude-usage-optimizer.zip"
