# Claude Usage Optimizer

A Chrome MV3 extension showing Claude.ai usage limits with a **pace** indicator —
whether you are ahead of or behind an even burn for each window.

## Architecture — the rule that matters

**`chrome.*` is never called from a React component.**

```
src/
  lib/          pure TypeScript, zero browser-extension dependencies
                pace maths, formatters, view-model construction, toolbar title,
                types
  extension/    the only place chrome.* is touched
                claudeUsageClient.ts, usageStorage.ts, serviceWorker.ts, messages.ts
  components/   pure React, props in only — plus ui/ for shadcn primitives
  popup/        PopupRoot.tsx — the one component that talks to extension/
```

This is the constraint most likely to be violated by accident. Because the
library code has no browser dependencies, `claudeUsageClient.ts` takes `fetch`
and its organization-ID cache as injected dependencies, making the real call
shapes inspectable without mocking.

When adding a feature, ask which of the four directories it belongs in before
writing it. Maths and formatting go in `lib/` even if only one component uses
them.

## Commands

`just` is the entry point for everything. Do not run raw pnpm/vite commands —
add a recipe instead. Never use `git add` or `git commit` — that is for the user
to do.

```sh
just check           # typecheck + lint + format-check — the gate
just build           # production build into dist/
just --list          # everything else
```

**`just check` must pass before work is considered done.**

## The claude.ai API

Unofficial and undocumented. Two calls, riding the user's session cookie via
`credentials: 'include'` and the `https://claude.ai/*` host permission:

```
GET https://claude.ai/api/organizations
GET https://claude.ai/api/organizations/{orgId}/usage
```

The response shape is documented in `plans/mvp-chrome-extension.md` §1.

**Normalise defensively.** The schema has changed before and will again. The
client accepts several spellings of each field (`utilization` / `utilization_pct`,
`resets_at` / `reset_at`), drops windows it cannot read, and treats a missing
reset time as "window inactive" rather than as a reset at the epoch. A failing
usage call busts the cached org ID and retries once — that covers the user
leaving a team.

**Unverified assumption:** the API reports when a window _resets_ but not when it
started, so the start is derived as `resets_at − 5h/7d`. If the weekly window is
actually rolling, weekly pace is wrong. `normaliseUsageResponse` already prefers
a real start field (`starts_at` / `started_at` / `window_start`) if one ever
appears, and `deriveWindowStatus` trusts the reported span over the nominal
duration when both ends are known.

## MV3 constraints

- Periodic work goes through **`chrome.alarms`, never `setInterval`** — the
  service worker is killed when idle, and an interval simply stops firing.
- Keep the permission set minimal. Currently `storage`, `alarms`, and host
  access to `https://claude.ai/*`. No content script, no `cookies`, no `tabs`
  permission (`chrome.tabs.create` does not require one).
- The popup asks the service worker to refresh via `chrome.runtime.sendMessage`
  rather than fetching itself, so network, storage and badge updates all happen
  in one place.
- The build is two Vite passes: the popup, then the service worker as a single
  self-contained ES module with no shared chunks for Chrome to resolve.

## Autonomous work scheduler

`.claude-scripts/` holds a launchd job that runs a queued Claude Code prompt at
2 AM, but **only when the weekly window is behind an even burn** — the point is
to keep subscription burn-rate level, so being on pace means nothing runs and
nothing is spent. Design rationale in `plans/autonomous-credit-utilization.md`.

The extension is the data source. After each successful refresh
`exportUsageSnapshot` hands the figures to a **native-messaging host**,
`.claude-scripts/usage-host.py`, which writes
`.claude-scripts/claude-usage.json`.

MV3 has no filesystem API, and the obvious escape hatch — `chrome.downloads` —
was tried first and abandoned: Chrome can put a confirmation dialog in front of a
download, which is fatal for something firing every five minutes unattended, and
each write churned the download history. Native messaging costs a one-time host
registration and in exchange never prompts and keeps the file inside the repo.

The host is stdlib-only Python 3.9 and deliberately depends on nothing —
**Chrome spawns it with an environment we do not control**, so a `uv` or
package dependency would fail in ways that are near-undebuggable from inside a
browser. Its stdout is the wire protocol; anything diagnostic goes to
`usage-host.log`, because a stray `print` corrupts the stream and the extension
just sees the host die.

```sh
just install-usage-host          # register the native host (needs the extension built)
just test-usage-host             # exercise the host directly, without Chrome
just extension-id                # the ID Chrome derives from dist/
just uninstall-usage-host

just autonomous-dry-run          # what would run next, without running it
just trigger-autonomous-work     # run now if behind pace (--force to ignore pace)
just autonomous-run-and-watch    # run now and follow the log in one go
just install-autonomous-work     # schedule the nightly 2 AM run
just uninstall-autonomous-work   # unschedule it
just autonomous-status           # is it scheduled?

just autonomous-log              # follow the run live
just autonomous-log-raw          # follow the raw stream-json events
just autonomous-running          # is a run in flight?
just cancel-autonomous-work      # stop an in-flight run
```

**Following a run live** is why `claude` is invoked with `--output-format
stream-json --verbose` and read line by line through `Popen`, rather than
`subprocess.run(capture_output=True)`. Plain `json` emits one blob only after the
run ends — nothing to follow. Each event is summarised into
`autonomous-work.log` as it arrives, with the raw events kept alongside in
`autonomous-work.jsonl`.

Two details that cost time to rediscover: `stdin` must be `DEVNULL` or `claude`
spends three seconds waiting on an inherited stdin and warns about it; and
`stderr` is merged into `stdout` because a second unread pipe can deadlock.

**Cancelling** needs `just cancel-autonomous-work` rather than a plain kill.
The host starts the scheduler in its own session so the run survives Chrome
tearing the native host down, and `claude` has been observed to outlive a group
signal aimed at the scheduler — so the cancel script matches both by command
line, SIGTERMs, waits, then SIGKILLs the survivors.

**Triggering a run from the popup.** Settings has a "Run now" button, which goes
popup → service worker → native host → detached scheduler process, and reports
only whether the run _started_: the work itself outlives the message by up to an
hour and reports into `autonomous-work.log`. It passes `--force`, since a button
press is an explicit instruction and applying the nightly pace gate to it would
just make the button look broken.

The host manifest names one `allowed_origins` extension ID. For an unpacked
extension Chrome derives that ID from the absolute load path, which
`extension-id.py` recomputes — so moving or renaming `dist/` changes the ID and
silently breaks the connection. Re-run `just install-usage-host` if that happens,
or pass an explicit ID as an argument.

**Editing the queue.** `.claude-scripts/prompts.queue.txt` is checked in and
user-editable. Sections split on a line of `===`; each has a required
`STATUS: todo|completed|error`, an optional `REPO:` (default
`~/code/auto-claude`), and a multi-line prompt. The scheduler takes the first
`todo`, runs it, and rewrites that status to `completed` or `error`. Failed
items are skipped until you edit them back to `todo`.

Every knob is an environment variable rather than a code edit —
`AUTONOMOUS_WORK_PACE_THRESHOLD_MS` (default −2h),
`AUTONOMOUS_WORK_TIMEOUT_SECONDS`, `AUTONOMOUS_WORK_DEFAULT_REPO`, and the
file-path overrides used by the tests.

**The newest snapshot is used however old it is — there is no freshness gate.**
That is deliberate: the extension can only refresh while Chrome is running, so
gating on age would mean the nightly job almost never fires on a machine whose
browser is closed at 2 AM. The trade is that a long-closed browser can have the
job act on figures from days ago; the age is logged on every decision so that is
visible after the fact. A missing `weeklyPaceDeltaMs` still skips the run, since
an inactive weekly window is genuinely no data rather than a stale reading.

**launchd starts jobs with a bare environment.** `uv` and `claude` live in
`~/.local/bin`, which is why the plist sets `PATH` explicitly. A missing entry
surfaces only as "command not found" in `.claude-scripts/system.log`.

The `claude -p` invocation is deliberately plain apart from `--permission-mode
auto`. Notably it does **not** pass `--bare`, which would authenticate with
`ANTHROPIC_API_KEY` and so spend the wrong budget entirely.

## Tech Stack

- **Language**: TypeScript with strict mode enabled
- **Styling**: Tailwind CSS v4 with the Vite plugin, CSS-first config in
  `src/index.css`
- **UI Components**: shadcn/ui-style primitives, hand-written in
  `src/components/ui/`
- **Icons**: Lucide React
- **Build Tool**: Vite with React plugin

## Naming Conventions

- **ALWAYS prefer readability over brevity** when naming things we control
  (variables, functions, classes, files). A few extra characters typed once
  saves thousands of moments of confusion reading code later.
- When naming variables, consider potential ambiguity in context (e.g., `data`
  could mean anything — prefer `userProfileData`; `result` tells you nothing —
  prefer `validatedToken`).
- AI tends to over-index on brief names from training data. Actively resist this.

## TypeScript

- Avoid `any` type unless absolutely necessary — strict mode is enabled
- Leverage TypeScript's type system to catch errors at compile time
