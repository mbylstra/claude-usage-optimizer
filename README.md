# Claude Usage Optimizer

Keep your Claude.ai subscription burning level. Two halves, and the second is
the point of the first:

- **[A pace indicator](#what-it-shows)** in the toolbar — not just how much of
  each usage window you have spent, but whether you are ahead of or behind an
  even burn, expressed as time. With a [suggested model](#suggested-model) and
  optional notifications when that suggestion changes.
- **[An autonomous work scheduler](#autonomous-work)** — a nightly job that
  spends the headroom you would otherwise waste, running a queued Claude Code
  prompt at 2 AM, **but only when the week is behind pace.** On pace, nothing
  runs and nothing is spent.

Knowing you are at 61% is only half the picture. Knowing you are at 61% with 47%
of the week gone is the half you act on — in both directions. Overshooting the
weekly cap costs you a working day; undershooting it wastes the subscription
just as surely, and quietly.

No configuration of any kind for the indicator — the extension discovers your
organization itself and rides on the claude.ai session you are already signed in
to. The scheduler is opt-in and takes two commands to set up.

## What it shows

For the 5-hour session window, the weekly window, and the weekly Opus window:

- percent used, and when the window started and resets
- how long is left
- **pace**: how far your usage is ahead of, or behind, an even burn — expressed
  as _time_, because that is the unit you can act on: "36m ahead of pace",
  "1h 5m behind pace", or "On pace"

  The gap is measured along the window: being 36m ahead means you have already
  spent what an even burn would not reach until 36 minutes from now. The same
  percentage gap is worth minutes on the 5-hour window and days on the weekly
  one, which is why the raw percentage-point difference was never the number to
  show.

### How loud the warning gets

Being ahead escalates yellow → orange → red, at the point where the gap is
actually worth acting on for that window:

|                | slightly bad | half bad    | bad          |
| -------------- | ------------ | ----------- | ------------ |
| 5-hour session | 15m ahead    | 30m ahead   | 1h ahead     |
| Weekly         | 12h ahead    | 1 day ahead | 2 days ahead |

Below the first threshold the pill is neutral — but it still names the gap
("11m ahead of pace") rather than collapsing to a dash. Being _behind_ has one
colour at any size: headroom is good news, and grading it would imply a scale
you cannot act on.

Each bar carries a vertical line marking the even-burn point, so the number and
the picture say the same thing. Behind it runs a scale — one tick per hour of a
five-hour session, one per day of a weekly window — so the line can be read as
"three hours in" rather than merely "somewhere past the middle".

The toolbar icon carries no badge. Hovering it names the highest utilisation
across all windows; the pace story lives in the popup, where there is room to
tell it.

### Suggested model

Below the windows, the popup names the model worth reaching for right now:
**Opus** when both gating windows have room to spare, **Haiku** the moment
either is burning severely ahead of an even pace, **Sonnet** in between.

It reads only the 5-hour and weekly windows. The weekly _Opus_ window caps Opus
specifically rather than describing overall burn rate, so counting it here would
penalise Opus twice.

The 5-hour window has to be a clear 30 minutes ahead before it downgrades the
suggestion — later than the 15 minutes at which the bar first turns yellow,
because "switch models" is a stronger nudge than a colour change.

Turn on **Notifications** in Settings to be told when that suggestion changes;
the notification says which window drove the change rather than just naming the
new model.

## Install it locally

```sh
just install
just build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` directory
4. Pin the extension, and make sure you are signed in to <https://claude.ai>

Data refreshes every 5 minutes in the background, and again whenever you open
the popup.

> Chrome removed the `--load-extension` command-line switch, so loading it
> through the UI is the only route.

The [autonomous work scheduler](#autonomous-work) below is optional and needs
two more steps; skip it if you only want the popup.

## Commands

`just` is the entry point for everything:

```sh
just check           # typecheck + lint + format-check — the gate
just build           # production build into dist/
just dev             # Vite dev server for the popup UI (no chrome.* available)
just package         # zip dist/ for a Web Store upload
just --list          # everything else
```

## Autonomous work

The half that makes this an _optimizer_ rather than a monitor. Unused weekly
capacity does not roll over, so headroom you never spend is simply gone.
`.claude-scripts/` holds a launchd job that puts it to work: it runs a queued
Claude Code prompt at 2 AM — **but only when the weekly window is behind an even
burn.** Being on pace means nothing runs and nothing is spent; the point is to
level out subscription burn rate, not to add to it.

It is opt-in — the popup works without any of this — but it is where the
indicator's numbers stop being something to read and start being something that
acts.

The extension is the data source. After each successful refresh it hands the
figures to a native-messaging host, which writes
`.claude-scripts/claude-usage.json`. The scheduler reads that file, and runs
only if `weeklyPaceDeltaMs` is at least 2 hours behind pace.

Design rationale, including why `chrome.downloads` was tried and abandoned,
is in `plans/autonomous-credit-utilization.md`.

### Setting it up

```sh
just build                      # the host manifest names the ID Chrome derives from dist/
just install-usage-host         # register the native host
just install-autonomous-work    # schedule the nightly 2 AM run
```

Then reload the extension in `chrome://extensions` so it picks up the host, and
check `just autonomous-status` says the job is loaded.

`install-usage-host` pins one extension ID, and for an unpacked extension Chrome
derives that ID from the absolute load path — so **moving or renaming `dist/`
silently breaks the connection.** Re-run `just install-usage-host` if that
happens, or pass an explicit ID from `chrome://extensions` as an argument.
`just extension-id` prints what the current path should produce.

`just uninstall-autonomous-work` and `just uninstall-usage-host` undo both
halves.

### Editing the queue

`.claude-scripts/prompts.queue.txt` is checked in and meant to be edited by
hand. Sections are separated by a line of three or more `=` characters:

```
===
STATUS: todo
REPO: ~/code/current/claude-usage-optimizer
Run `just check` to verify project health.
Fix any lint, type, or format errors.
Leave the changes uncommitted for review.
```

- **`STATUS:`** is required and must be the section's first non-blank line —
  `todo`, `completed`, or `error`. A section without one is ignored entirely,
  which is what lets the file carry `#` comments at the top.
- **`REPO:`** is optional and must come before the prompt body. It is the
  working directory the prompt runs in, `~` included; it defaults to
  `~/code/auto-claude` (override with `AUTONOMOUS_WORK_DEFAULT_REPO`). The
  directory is created if it does not exist.
- **Everything after the headers is the prompt**, and may span as many lines as
  you like.

Each run takes the first `todo` section with a non-empty prompt, runs it, and
rewrites that one status line to `completed` (exit 0) or `error` (anything
else). So the queue is consumed top to bottom, one item per run, and a failed
item is skipped on later runs until you edit its status back to `todo`. Add new
work by appending a section — a queue with no `todo` sections left is a no-op,
not an error.

The status is rewritten by line index rather than by search-and-replace, so a
prompt body containing the word `STATUS` is harmless, and the file is swapped
atomically so an edit made mid-run never leaves it truncated.

### Watching and driving it

```sh
just autonomous-dry-run          # what would run next, without running it
just trigger-autonomous-work     # run now if behind pace (--force to ignore pace)
just autonomous-run-and-watch    # run now and follow the log in one go
just autonomous-log              # follow the run live
just autonomous-log-raw          # follow the raw stream-json events
just autonomous-running          # is a run in flight?
just cancel-autonomous-work      # stop an in-flight run
```

Settings in the popup has a **Run now** button that does the same thing as
`just trigger-autonomous-work --force`. It reports only whether the run
_started_ — the work itself outlives the button press by up to an hour and
reports into `.claude-scripts/autonomous-work.log`.

Runs are followed live because `claude` is invoked with `--output-format
stream-json --verbose` and read line by line; each event is summarised into
`autonomous-work.log` as it arrives, with the raw events kept beside it in
`autonomous-work.jsonl`. Cancelling needs `just cancel-autonomous-work` rather
than a plain kill: the run is deliberately detached so it survives Chrome
tearing the native host down, so the script matches both processes by command
line, SIGTERMs, then SIGKILLs whatever is left.

Every knob is an environment variable rather than a code edit —
`AUTONOMOUS_WORK_PACE_THRESHOLD_MS` (default −2h),
`AUTONOMOUS_WORK_TIMEOUT_SECONDS` (default 1 hour),
`AUTONOMOUS_WORK_DEFAULT_REPO`, and file-path overrides for the queue, log and
snapshot.

### One deliberate rough edge

The newest snapshot is used however old it is — there is no freshness gate. The
extension can only refresh while Chrome is running, so gating on age would mean
the job almost never fires on a machine whose browser is closed at 2 AM. The
trade is that a long-closed browser can have the job act on figures from days
ago; the age is logged on every decision, so it is at least visible after the
fact. A _missing_ weekly figure still skips the run, since an inactive weekly
window is genuinely no data rather than a stale reading.

## How it is put together

The rule that makes the tooling worth having: **`chrome.*` is never called from
a React component.**

```
src/
  lib/          pure TypeScript, no browser-extension dependencies
                pace maths, formatters, view-model construction, types
  extension/    the only place chrome.* is touched
                API client, storage, service worker
  components/   pure React, props in only
  popup/        PopupRoot — the one component that talks to extension/
```

Two consequences worth keeping:

- Pure functions in `src/lib` take `now` as an explicit argument and never read
  the clock. That is what makes the pace maths predictable and inspectable.
- `UsagePopup` renders a fully-derived view model, so every visual state —
  loading, logged out, ahead, behind, window inactive, stale, refresh-failed —
  can be rendered from a hand-written fixture with no extension host. That is
  what `preview.html` / `src/popup/previewMain.tsx` do: run `just dev` and open
  `/preview.html` to see the states side by side in the browser.

### The claude.ai API

Unofficial and undocumented. Two calls, both riding the session cookie:

```
GET https://claude.ai/api/organizations
GET https://claude.ai/api/organizations/{orgId}/usage
```

Responses are normalised defensively — the client accepts several spellings of
each field, drops windows it cannot read, and treats a missing reset time as
"window inactive" rather than as a reset at the epoch. A failing usage call
busts the cached organization ID and retries once, which covers leaving a team.

**One assumption is still unverified against live data:** the API reports when a
window _resets_ but not when it started, so the start is derived as
`resets_at − 5h/7d`. That holds for fixed windows. If the weekly window turns
out to be rolling, weekly pace is wrong and needs reworking. The normaliser
already prefers a real start field (`starts_at` / `started_at` / `window_start`)
if the API ever supplies one.

### MV3 constraints

Periodic work goes through `chrome.alarms`, never `setInterval` — the service
worker is killed when idle, and an interval would simply stop firing. The
permission set is deliberately small: `storage`, `alarms`, `notifications`,
`nativeMessaging`, and host access to `https://claude.ai/*`. No content script,
no `cookies`, no `tabs`.

### Usage history

Every successful refresh appends a sample — the utilisation percentages, the
reset times as reported at that moment, and `fetchedAt` — to a capped ring buffer
in `chrome.storage.local`. Nothing reads it yet. It serves two future purposes:

1. An activity-weighted pace model — one that knows 3am Sunday is not 10am
   Tuesday — needs a real dataset rather than starting from zero.
2. The recorded reset times settle whether each window is **fixed or rolling**,
   which no single API response can tell you. A fixed window's reset holds steady
   and then jumps forward by the window duration as utilisation drops to ~0; a
   rolling one creeps forward continuously with utilisation decaying gradually.
   Weekly pace is only meaningful in the fixed case — see the assumption above.

## Privacy

Everything stays on your machine. The extension talks to claude.ai and nothing
else; there is no analytics, no server, and no telemetry. The autonomous-work
scheduler is local too — a native-messaging host writing a JSON file inside this
repository, and `claude` running under your own subscription.
