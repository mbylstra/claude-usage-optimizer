# Claude Usage Optimizer

Keep your Claude.ai subscription burning level. Two halves, and the second is
the point of the first:

- **[A pace indicator](#what-it-shows)** in the toolbar — not just how much of
  each usage window you have spent, but whether you are ahead of or behind an
  even burn, expressed as time. With a [suggested model](#suggested-model) and
  optional notifications when that suggestion changes.
- **[An autonomous work scheduler](#autonomous-work)** — a nightly job that
  spends the headroom you would otherwise waste, running a queued Claude Code
  prompt at 2 AM (or whatever time you set in Settings), **but only when the
  week is behind pace.** On pace, nothing runs and nothing is spent.

Knowing you are at 61% is only half the picture. Knowing you are at 61% with 47%
of the week gone is the half you act on — in both directions. Overshooting the
weekly cap costs you a working day; undershooting it wastes the subscription
just as surely, and quietly.

No configuration of any kind for the indicator — the extension discovers your
organization itself and rides on the claude.ai session you are already signed in
to. The scheduler is opt-in, and `just setup` wires up both halves at once.

## Quick start

Not in the Chrome Web Store — you load it unpacked from this checkout.

That is a fair few system-wide dependencies for one small extension, and no
apology beyond this sentence: every one of them is a genuinely good tool, worth
having on a development machine whether or not you ever run this project.

On macOS, the prerequisites are:

```sh
brew install just node uv       # just runs every command in this repo
corepack enable pnpm            # or: brew install pnpm
```

- **`just`, `node`, `pnpm`** — needed to build the extension.
- **`uv`** — the scheduler script runs under `uv run --script`.
- **`claude`** — the Claude Code CLI, which is what the scheduler actually
  runs. Install it from <https://claude.com/claude-code> if you have not
  already, and sign in to a subscription (not an API key).
- **`python3`** — the native-messaging host is stdlib Python. macOS supplies it
  with the Xcode command line tools; run `xcode-select --install` if
  `python3 --version` fails.

`just setup` refuses to run if `uv` or `claude` is missing. Note that launchd
starts the nightly job with a bare environment, so both must live in
`~/.local/bin` or `/opt/homebrew/bin` — the only two user paths the launch agent
puts on `PATH`.

Then, from the repository root:

```sh
just setup
```

One command for the whole thing: dependencies, a build into `dist/`, the
native-messaging host, `prompts.txt` started from the template, and the nightly job scheduled. It is
safe to re-run, and it leaves anything already set up alone.

If you only want the popup, `just install && just build` is enough — stop after
step 1 below. If you ran `just setup` and change your mind,
`just uninstall-autonomous-work` unschedules the nightly job.

`setup` finishes by printing the one step it cannot do for you:

**1. Load the extension.** In Chrome, go to `chrome://extensions`, turn on
**Developer mode** (top right), click **Load unpacked** and pick the `dist/`
directory. Pin it, and make sure you are signed in to <https://claude.ai>. That
is the whole popup — no configuration. Then reload it once so it picks up the
native host. ([More detail](#install-it-locally).)

**2. Queue some work.** Edit `prompts.txt` at the repository root, which `setup`
created from `prompts.example.txt`. Sections are separated by a line of `===`;
the first `todo` one is what runs next:

```
===
STATUS: todo
REPO: ~/code/current/claude-usage-optimizer
Run `just check` and fix any lint, type, or format errors.
Leave the changes uncommitted for review.
```

Leave the `REPO:` line off and the prompt gets a fresh repository of its own
instead. ([Full format](#editing-the-queue).)

**3. Test it end to end.** Open the popup, go to **Settings**, and press
**Run now** — it runs the first `todo` prompt immediately, ignoring the pace
gate, and opens a window that follows the run as it happens. (Or watch it in a
terminal with `just autonomous-log`.) If the button errors, the native host is
not connected — rebuild, re-run `just install-usage-host`, and reload the
extension.

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

The [autonomous work scheduler](#autonomous-work) below is optional; skip it if
you only want the popup. `just setup` sets up both halves in one command.

## Commands

`just` is the entry point for everything:

```sh
just setup           # everything a fresh clone needs, in one command
just check           # typecheck + lint + format-check — the gate
just build           # production build into dist/
just dev             # Vite dev server for the popup UI (no chrome.* available)
just run-log-preview # the run-log window UI, on fixture events
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

The time is set in the popup's Settings screen, along with the folder new
projects are created in. See [Scheduling and new
projects](#scheduling-and-new-projects).

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

`just setup` does all of this. The individual recipes, for when you are undoing
or repairing one piece rather than starting from scratch:

```sh
just build                      # the host manifest names the ID Chrome derives from dist/
just install-usage-host         # register the native host
just install-autonomous-work    # schedule the nightly run (2 AM by default)
```

Then reload the extension in `chrome://extensions` so it picks up the host, and
check `just autonomous-status` says the job is loaded.

**All of these are safe to re-run at any point**, which is what makes
`just setup` the answer to most "did something come unstuck?" moments rather than
a first-run-only command. Each rewrites its output from a template or leaves an
up-to-date file alone; none accumulates state. The one exception worth knowing:
re-running `install-autonomous-work` reloads the launch agent, which stops a
nightly run that happens to be in flight. The scheduler treats that as a
cancellation and leaves the queue entry `todo`, so nothing is lost, but it does
mean not re-running it at 2:30 AM.

`install-usage-host` pins one extension ID, and for an unpacked extension Chrome
derives that ID from the absolute load path — so **moving or renaming `dist/`
silently breaks the connection.** Re-running fixes that, since it re-derives the
ID from wherever `dist/` now is.

What re-running cannot fix is Chrome showing an ID that the path does not
predict — which means the extension was loaded from some _other_ directory, an
old checkout or a symlink. Re-deriving gives the same answer forever there, so
pass the ID from `chrome://extensions` explicitly:

```sh
just install-usage-host abcdefghijklmnopabcdefghijklmnop
```

`just extension-id` prints what the current path should produce, for comparing
against what Chrome shows.

`just uninstall-autonomous-work` and `just uninstall-usage-host` undo both
halves.

### Protected folders

macOS gates `~/Desktop`, `~/Documents`, `~/Downloads` and iCloud Drive behind
per-application grants, and a queued prompt that reads one may be refused. What
happens then depends entirely on how the run was started, which took a while to
pin down:

- **Every run fails closed**, whether it is the nightly one or **Run now**. The
  read returns `Operation not permitted` immediately — no dialog, no hang.
  Claude sees an ordinary tool error, and the queue entry is marked `error`.
- **Run now used to prompt**, because it was spawned from Chrome and macOS would
  raise a dialog on its behalf. It now asks launchd to start the same job the
  nightly run uses, so the two have identical permissions — at the price of that
  prompting. The reason is Gatekeeper rather than folders: anything Chrome
  spawns has its files stamped with Chrome's quarantine, including the native
  module Claude unpacks to read an image, which then cannot load without a
  malware-check dialog blocking the run. See CLAUDE.md, "Triggering a run from
  the popup".

So the settings screen has a **Grant folder access** button. It asks macOS about
Desktop, Documents and Downloads in one go, and you answer the dialogs while you
are sitting there. Press it once, at setup.

It has to live in the extension rather than in a `just` recipe, and that is not
a stylistic choice: a recipe cannot raise those dialogs at all. Run the same
check from a terminal and macOS attributes the read to Terminal or iTerm, which
hold their own grants and lend them down the chain, so every folder comes back
readable and nothing is ever asked. Only a request coming through Chrome
prompts.

To see what the nightly job can currently reach:

```sh
just check-folder-access
```

That runs the check **as a launchd job**, which matters more than it sounds.
Run the same check from a terminal and every folder comes back readable,
because the read is then attributed to Terminal or iTerm — which hold their own
grants and lend them to everything they start. Only launchd reproduces the
nightly chain's permissions.

**This project never asks for Full Disk Access**, and does not need to. It runs
its own copy of `uv`, `.claude-scripts/bin/claude-usage-optimizer-uv`, re-signed
with its own code-signing identifier — so the folders you allow are allowed for
the nightly job and for nothing else. Your everyday `uv run` and `uvx` stay
unprivileged, which matters because `uvx` runs arbitrary packages from PyPI on
demand.

Three things about that copy, each learned the hard way:

- **macOS identifies it by code signature, not by path.** A plain `cp` of `uv`
  is byte-identical and therefore the _same_ client, sharing whatever the
  original was granted — which defeats the point. `just install-private-uv`
  re-signs it, and that is what makes it separate.
- **Renaming it is free; replacing it is not.** The signature does not include
  the filename, so the copy can be called anything. Replacing it with a newer uv
  changes the bytes, and so the signature, and so the grants — which is why
  `install-private-uv` never overwrites an existing copy and `just
refresh-private-uv` warns before it does.
- **The name in System Settings is the filename.** Hence the long one: two rows
  both called `uv` are impossible to tell apart.

**The dialogs only appear for a client macOS has no opinion about.** If you deny
one by accident, or switch a permission off later in Settings, that is recorded
as a decision and the button will silently do nothing from then on. Switching a
toggle off is _not_ a reset — to be asked again you must select the row and
delete it with the **−** button, then press Grant folder access.

### Editing the queue

`prompts.txt` at the repository root is meant to be edited by hand — it is the
one file in this whole setup you touch regularly, which is why it sits at the
top level rather than in `.claude-scripts/`. It is **gitignored**, since it is
your own task list and every run rewrites a status line in it; copy
`prompts.example.txt` to start one.

Sections are separated by a line of three or more `=` characters:

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
  working directory the prompt runs in, `~` included, created if it does not
  exist. **Leave it out and the prompt gets a brand-new repository instead** —
  created and `git init`-ed under the new-projects folder from Settings, named
  after the date and the first few words of the prompt
  (`~/code/2026-08-11-build-a-tetris-clone-in-plain`). A queue of unrelated
  "build me an X" prompts is the normal case, and sharing one working copy
  between them just makes each run contend with the last one's leftovers.
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

### Scheduling and new projects

Two settings in the popup's **Settings** screen shape how the nightly run
behaves:

- **Run at** — the local wall-clock time launchd fires the job. 2 AM by default.
  Changing it rewrites the installed launch agent and reloads it, so the change
  takes effect for the next night. Hour and minute rather than an instant,
  because "2 AM daily" has to survive daylight saving.
- **New projects folder** — where a queue prompt with no `REPO:` line starts its
  new repository. `~/code` by default.

Both settings live in `chrome.storage`, which launchd cannot read, so the native
host mirrors them to `.claude-scripts/autonomous-work-settings.json` — the file
`run-autonomous-work.py` and `just install-autonomous-work` both read.
`just autonomous-settings` prints the current state.

Changing the time **only reschedules a job that is already installed.** If you
have never run `just install-autonomous-work`, the setting is saved and the
screen says so rather than quietly scheduling unattended work you never asked
for. Without the native host installed at all, both settings stay in the browser
and the screen says that too.

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

Settings in the popup has a **Run now** button that does the same work as
`just trigger-autonomous-work --force` — by asking launchd to start it, so the
run is identical to the nightly one — and a **View run** button beside it.
Both open a detached window that streams the run — a status header with elapsed
time and cost, a timeline of what Claude is doing, a Cancel button, and a raw
JSON toggle. The window follows the newest line until you scroll away from it,
and a **live** button brings it back.

The nightly 2 AM run deliberately raises no window; it writes to the same
stream, so opening **View run** later shows what it did.

Runs are followed live because `claude` is invoked with `--output-format
stream-json --verbose` and read line by line; each event is summarised into
`autonomous-work.log` as it arrives, with the raw events kept beside it in
`autonomous-work.jsonl` and a structured, run-scoped version — the one the
window reads — in `autonomous-run-events.jsonl`, trimmed to the last five runs.
Cancelling needs `just cancel-autonomous-work` rather
than a plain kill: the run is deliberately detached so it survives Chrome
tearing the native host down, so the script matches both processes by command
line, SIGTERMs, then SIGKILLs whatever is left.

Every knob is an environment variable rather than a code edit —
`AUTONOMOUS_WORK_PACE_THRESHOLD_MS` (default −2h),
`AUTONOMOUS_WORK_TIMEOUT_SECONDS` (default 1 hour),
`AUTONOMOUS_WORK_NEW_PROJECTS_DIR` (which wins over the Settings screen, for a
one-off run), and file-path overrides for the queue, log, snapshot and settings.

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
  `/preview.html` to see the states side by side in the browser. The run-log
  window has the same arrangement — `just run-log-preview` drives it from
  recorded-looking events, including one panel that replays them on a timer, so
  the live behaviour can be developed without starting a billable run.

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

## Security

The nightly job runs `claude -p` with `--permission-mode auto` — the same
classifier-gated mode an interactive session defaults to, not
`--dangerously-skip-permissions`. In terms of what Claude is _permitted_ to do,
this is not a loosening of what you already run in a terminal.

The distinction is whether anything is judging the actions at all. Under `auto`
every tool call still goes through the permission layer: your allow and deny
rules apply, and a classifier waves through the calls it reads as low-risk and
stops on the ones it does not — so `auto` is really "don't interrupt me for the
routine things", not "don't check". `--dangerously-skip-permissions` removes
that layer outright; there is nothing left to consult, no rule to hit and no
call it would decline. The gap between them is exactly the set of actions the
classifier would have refused, which for an unattended run is the only thing
standing between a bad prompt and the rest of your disk.

At the OS level it is narrower, which is the opposite of how granting a folder
to a binary feels. The intuition to check is that ticking `~/Documents` for the
private `uv` hands it something it did not have before — but compare it against
the alternative, which is running `uv` from a terminal. There it is attributed
to Terminal or iTerm and inherits *their* grants, and those are typically
already wide: whatever you have ever approved for your terminal, for anything
that terminal has ever launched. Against that baseline the re-signed copy is a
reduction. It is a separate TCC client holding only the folders you ticked for
it, nothing else inherits them, and the uv on your `PATH` is unaffected in
either direction — see [Protected folders](#protected-folders).

What is genuinely new is not the breadth but the absence of a person: those
grants get exercised at 2 AM by a prompt you wrote days ago. That is an argument
about supervision, below, not about reach.

Nor can the extension make Claude do anything new: the native host answers a
fixed set of messages, with no path for arbitrary commands, and the work comes
from `prompts.txt`, which you write by hand.

What genuinely differs is supervision. An interactive session has you reading
the stream with Esc under your thumb; a 2 AM run has nobody. `-p` has no turn
boundary, so a classifier denial persists for the rest of the run and repeated
denials abort it rather than asking you. It fails closed — but no one is there
to approve a block that was wrong, either.

Note also what none of this covers: `~/.ssh`, `~/.aws` and `~/.claude` are not
TCC-protected, so they are readable here exactly as they are from any terminal.
Making them off-limits takes a `permissions.deny` rule in Claude Code's own
settings, the only layer in this stack that can.

## Privacy

Everything stays on your machine. The extension talks to claude.ai and nothing
else; there is no analytics, no server, and no telemetry. The autonomous-work
scheduler is local too — a native-messaging host writing a JSON file inside this
repository, and `claude` running under your own subscription.
