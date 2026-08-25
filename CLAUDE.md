# Claude Usage Optimizer

A Chrome MV3 extension showing Claude.ai usage limits with a **pace** indicator —
whether you are ahead of or behind an even burn for each window.

## Top-level layout

Two top-level directories hold code; the rest is docs and the work queue.

```
chrome-extension/   the Chrome MV3 extension — see below. Owns node_modules/,
                     package.json and the whole Vite/TS/eslint/prettier toolchain,
                     since none of that applies to backend/.
backend/             the native-messaging host + autonomous-work scheduler —
                     see "Autonomous work scheduler" below. stdlib-only Python,
                     deliberately dependency-free.
findings/            postmortems
marketing/           the Chrome Web Store listing assets
plans/               design docs
summaries/           what each night's run actually did, one file per day.
                     Written by the scheduler, gitignored, for a person to read.
```

`justfile` and `CLAUDE.md` stay at the repository root, as does `prompts.txt`
(explained below) — everything else that is specific to one side lives inside
its directory. `summaries/` is at the top level for the same reason
`prompts.txt` is: the queue and the report on it are the two files here meant to
be read and edited by hand, so neither is buried in `backend/`.

## Architecture — the rule that matters

**`chrome.*` is never called from a React component.**

```
chrome-extension/
  lib/          pure TypeScript, zero browser-extension dependencies
                pace maths, formatters, view-model construction, toolbar title,
                types
  extension/    the only place chrome.* is touched
                claudeUsageClient.ts, usageStorage.ts, serviceWorker.ts, messages.ts
  components/   pure React, props in only — plus ui/ for shadcn primitives
  popup/        PopupRoot.tsx — the one component that talks to extension/
  runLog/       RunLogRoot.tsx — the same, for the detached run-log window
```

This is the constraint most likely to be violated by accident. Because the
library code has no browser dependencies, `claudeUsageClient.ts` takes `fetch`
and its organization-ID cache as injected dependencies, making the real call
shapes inspectable without mocking.

When adding a feature, ask which of the five directories it belongs in before
writing it. Maths and formatting go in `lib/` even if only one component uses
them.

There are **two extension pages**, `popup.html` and `run-log.html`, each with a
root component that is the only one in its tree allowed to touch `extension/`.
They may share build chunks; only the service worker may not.

## Commands

`just` is the entry point for everything. Do not run raw pnpm/vite commands —
add a recipe instead. Never use `git add` or `git commit` — that is for the user
to do.

```sh
just setup           # everything a fresh clone needs, in one command
just check           # typecheck + lint + format-check — the gate
just build           # production build into chrome-extension/dist/
just --list          # everything else
```

`just setup` runs the install recipes in order and ends by printing the one
step it cannot do itself: loading the unpacked extension, which needs a human
to click through `chrome://extensions`.

**Every `install-*` recipe must stay safe to re-run at any point**, because
`setup` chains them and is the first thing to reach for when something has come
unstuck. They rewrite their output from a template, or compare and leave an
up-to-date file alone; none appends or accumulates. Keep it that way when adding
one. The single exception is `install-autonomous-work`, which reloads the launch
agent and so stops a nightly run in flight — recorded as a cancellation, leaving
the queue entry `todo`.

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

**An unpacked extension is only half as fresh as it looks, and every settings
message carries a build stamp because of it.** `popup.html` and its bundle are
re-read from disk every time the popup opens; the **service worker is replaced
only when Chrome reloads the extension**, and the reload button has been observed
not to take. The failure is invisible from every angle you would normally check:
the source is right, `dist/` is right, the UI shows the new fields — and the
worker relaying them to the native host is weeks old. It cost most of a morning
once, spent fixing a sender that was never running.

So both Vite passes `define` a `BUILD_STAMP` (declared in
`extension/buildStamp.d.ts`), `syncAutonomousWorkSettings` sends it, and
`usage-host.py` logs it beside the arriving key list. One line of
`backend/usage-host.log` now answers "is Chrome running what I just built?" —
`unstamped` means it is not. **Quit and reopen Chrome; reloading may not be
enough.**

The same log line prints the message's keys *before* they are parsed, because
`parse_settings` substitutes a default for anything absent — after it runs, "the
extension never sent this field" and "the extension sent the default" are
indistinguishable, which is the shape every version-skew bug here takes.

Relatedly, `syncAutonomousWorkSettings` **spreads the settings object** rather
than naming each field. Fields were dropped twice by a hand-written payload that
someone forgot to extend; only `scheduleTime` is spelled out, since it is the one
field whose shape differs from the mirrored file's.

## Autonomous work scheduler

`backend/` holds a launchd job that works through queued Claude Code
prompts starting at 2 AM (configurable — see below), but **only when the weekly
window is behind an even burn** — the point is to keep subscription burn-rate
level, so being on pace means nothing runs and nothing is spent. Design
rationale in `plans/autonomous-credit-utilization.md`.

It does not stop after one prompt: `run-autonomous-work.py` re-checks pace
before every queued item and keeps going as long as it is still behind. A
session ends when it runs out of `todo` entries, catches back up to pace, the
5-hour session window itself reports exhausted, or the CLI refuses a prompt
because a subscription limit has been reached — and those last two end the run
rather than sitting idle for up to five hours waiting for the window to reset,
since it does not refill early. Instead the run **schedules its own resume**, a
few minutes after that window is expected to refill — see below. `--force`
(used by "Run now" and by the test recipes) is the one path that stays
single-shot: it bypasses the pace check it exists to keep re-evaluating, so it
runs exactly one prompt.

**A prompt refused by a subscription limit is left `todo`, not marked as an
error.** It never ran, so failing it would skip it until somebody edited
`prompts.txt` by hand — the one outcome that costs work rather than just time.
The snapshot's own exhaustion figure cannot cover this: it can be hours stale,
it says nothing about the weekly or Opus-specific limits, and the limit can be
reached part-way through a session that started with headroom. So the CLI's
refusal is read out of the stream instead, by `session_limit_message` —
a synthetic assistant message carrying `error: "rate_limit"`, after which the
process **exits 1, indistinguishable from a prompt that genuinely failed**,
which is exactly why `determine_outcome` has to be told about it and reports
exit code 0. The structured field is trusted on its own; the wording is matched
only as a fallback, and only on a message the CLI has already flagged as an API
error or a failed result — matching it against ordinary assistant prose would
make any prompt that discusses rate limits (this section, for instance) look
like it hit one. The rest of the queue is not offered up afterwards: the limit
does not lift for hours, so every remaining entry would be picked up only to be
refused a second later.

The extension is the data source. After each successful refresh
`exportUsageSnapshot` hands the figures to a **native-messaging host**,
`backend/usage-host.py`, which writes
`backend/claude-usage.json`.

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
just extension-id                # the ID Chrome derives from chrome-extension/dist/
just uninstall-usage-host

just check-folder-access         # what the nightly run can actually read

just autonomous-settings         # the scheduled time and new-projects folder
just autonomous-dry-run          # what would run next, without running it
just trigger-autonomous-work     # run now if behind pace (--force to ignore pace)
just autonomous-run-and-watch    # run now and follow the log in one go
just install-autonomous-work     # schedule the nightly run at the configured time
just uninstall-autonomous-work   # unschedule it
just autonomous-status           # is it scheduled?

just autonomous-resume-status    # is a resume pending, and is launchd holding it?
just cancel-autonomous-resume    # unschedule a pending resume

just test-launchd-run            # run the queue through launchd, as the nightly job does

just autonomous-log              # follow the run live
just autonomous-summary          # what last night's session did (or a given day's)
just autonomous-log-raw          # follow the raw stream-json events
just autonomous-running          # is a run in flight?
just cancel-autonomous-work      # stop an in-flight run, and clear its resume

just run-log-preview             # the run-log window UI, on fixtures, no extension
```

**Following a run live** is why `claude` is invoked with `--output-format
stream-json --verbose` and read line by line through `Popen`, rather than
`subprocess.run(capture_output=True)`. Plain `json` emits one blob only after the
run ends — nothing to follow. Each event is summarised into
`autonomous-work.log` as it arrives, with the raw events kept alongside in
`autonomous-work.jsonl`.

**Three log files, and why.** A run writes all three, and they are not
interchangeable:

| File                          | For                                                   |
| ----------------------------- | ----------------------------------------------------- |
| `autonomous-work.log`         | prose, for `just autonomous-log`                      |
| `autonomous-work.jsonl`       | every raw stream-json event, appended forever         |
| `autonomous-run-events.jsonl` | the structured, run-scoped stream the viewer consumes |

The third exists because neither of the first two can drive a UI. The `.log` is
our own formatting, so parsing it back into structure would break on every
wording change; the `.jsonl` has no run boundaries and no record of which
prompt, repo or working directory a run used — which is exactly what the
viewer's header needs. It carries our own envelope events (`runStarted`,
`claudeEvent` wrapping the stream-json verbatim, `claudeOutput`, `runFinished`,
`runSkipped`, `resumeScheduled`) and is **trimmed to the last five runs on each
start**, so it stays
bounded without a rotation job. A dry run writes nothing to it: asking what
would happen must not disturb the record of what did.

Two details that cost time to rediscover: `stdin` must be `DEVNULL` or `claude`
spends three seconds waiting on an inherited stdin and warns about it; and
`stderr` is merged into `stdout` because a second unread pipe can deadlock.

**The morning-after summary — `summaries/YYYY-MM-DD.md`.** None of the three log
files above answers the question you actually have over breakfast: which queued
prompts ran, how each went, and why the session stopped when it did. So a
session that ran at least one prompt appends its own section to the day's
summary file, rendered by `autonomous_work_summary.py` (underscores, because
`run-autonomous-work.py` imports it — the same constraint as
`autonomous_work_settings.py`). `just autonomous-summary` prints the latest.

Four things about it are deliberate:

- **One file per day, appended to, not one per session.** A day holds the 2 AM
  run and any number of "Run now" presses, and they belong together. The date is
  the day the session _started_, so a run that crosses midnight stays in the
  file you would look in.
- **A session that ran nothing writes nothing.** The pace gate's decision is
  already in the log, and a file every night saying "on pace, nothing to do"
  would bury the ones describing real work.
- **The per-prompt account is Claude's own closing message**, taken from the
  `result` event. A prompt that timed out, wedged or was cancelled never emits
  one, so the last assistant message is kept as it streams by and used instead —
  "how far did it get" is the whole question in exactly those cases.
- **A cancelled session still writes its summary**, from the SIGTERM handler,
  before `os._exit`. Its entry is recorded with the status the cancel really
  leaves behind (`todo`), and excluded from the "not attempted" list so it is
  not counted twice.

A dry run writes no summary, for the same reason it writes no run events.

**Cancelling** needs `just cancel-autonomous-work` rather than a plain kill.
The host starts the scheduler in its own session so the run survives Chrome
tearing the native host down, and `claude` has been observed to outlive a group
signal aimed at the scheduler — so the cancel script matches both by command
line, SIGTERMs, waits, then SIGKILLs the survivors. The scheduler catches that
SIGTERM only to record a `runFinished` with outcome `cancelled` and `os._exit`
straight away: a cancelled entry must be left as `todo`, not marked as an error
on the way out. It also clears any pending resume — cancelling a run and then
having it silently restart itself a few hours later is not what anybody means by
cancel.

**Triggering a run from the popup.** Settings has a "Run now" button, which goes
popup → service worker → native host → `launchctl kickstart`, and reports only
whether the run _started_: the work itself outlives the message by up to an hour
and reports into `autonomous-work.log`. It then opens the run-log window below.

**The host asks launchd to start the run rather than spawning it**, which is the
opposite of what the rest of the host does and costs a whole second launch
agent, `com.claudeusageoptimizer.autonomouswork.ondemand` — unscheduled, and
carrying the `--force` the nightly job does not, since a button press is an
explicit instruction and `launchctl kickstart` cannot pass arguments. It bought
two things.

The first is **Gatekeeper**. Everything the host spawns is a descendant of
Chrome, and macOS stamps `com.apple.quarantine` on files written by any
descendant of a quarantine-aware app. `claude` ships as a Bun-compiled binary
that unpacks an ad-hoc-signed `.node` module into `$TMPDIR` the first time a
prompt touches an image — reads a PNG, takes a screenshot — and a stamped,
unnotarized library cannot load without an "Apple could not verify…" dialog. The
run then sits there until somebody clicks. The module is unpacked per process
and deleted on exit, so nothing persists between runs and the nightly job was
never affected; but the stamp made "Run now" unusable for any prompt doing image
work. Started by launchd, the run has no quarantine agent above it.

The second is **parity**: the button and the nightly job are now the same job
started two ways, so they have the same ancestry, the same TCC identity and the
same folder permissions. What you see when you press it is what happens at 2 AM.
The cost is that "Run now" no longer raises folder-permission dialogs of its
own — that was only ever a side effect of Chrome being in the chain, and
granting is the "Grant folder access" button's job, which still takes the Chrome
path deliberately.

`just test-launchd-run` measures the Gatekeeper half of this: it runs the queue
through launchd and reports whether a quarantine stamp landed on the unpacked
module. It has to go through launchd to mean anything — a run started from a
terminal has no quarantine agent either, so it would look clean whatever the
truth was.

Two failure modes worth recognising. `launchctl kickstart` exits **113** when the
label was never installed, which the host turns into a "run
`just install-autonomous-work`" message rather than a generic failure; and
because launchd will not run two instances of one label, pressing the button
during a run can no longer start a second overlapping one.

## Resuming after the 5-hour window resets

A session that runs into the 5-hour session window stops, since that window does
not refill early. But it *does* refill, at a knowable time, often only two or
three hours away — so rather than leaving the queue until 2 AM the next night,
the run asks launchd to start it again shortly afterwards. Design and rationale:
`plans/resume-after-five-hour-reset.md`. `autonomous_work_resume.py` owns the
whole of it — the state file's shape and the agent's lifecycle — and inherits
the stdlib-only, 3.9-compatible constraint, being imported by
`cancel-autonomous-work.py`.

That makes **a third launch agent**:

```
com.claudeusageoptimizer.autonomouswork           2 AM, pace-gated
com.claudeusageoptimizer.autonomouswork.ondemand  no schedule, --force
com.claudeusageoptimizer.autonomouswork.resume    one date and time, --resume
```

It carries `--resume`, not `--force`, so the pace gate still applies: a week
that has caught up by the time it fires correctly does nothing.

**Pinning a Month and a Day is what makes it one-shot.** launchd has no one-shot
calendar job — `Hour`/`Minute` alone repeat daily, adding `Day` repeats monthly,
adding `Month` repeats yearly. Nor can the job unschedule itself at fire time:
`launchctl bootout` of a label kills that label's own running process, and the
scheduler's SIGTERM handler would then record the run as **cancelled**. So
`backend/autonomous-work-resume.json` is what makes a stray fire a no-op — a
year later, or on a Mac that ran a missed calendar job on waking.

**One resume per day, and never from a resume.** This is the rule the whole
design rests on, and it is worth knowing what it saves. A resumed run reads the
same snapshot file; if Chrome has been closed since, that file still says the
window is at 100%, the gate skips with `fiveHourExhausted`, and the run would
schedule *another* resume five hours out — forever, on the strength of one stale
reading. Under a no-chain rule that cannot happen, so there is no freshness
test, no chain counter and no maximum to tune. Do not add chaining back as an
obvious improvement. The per-day half of the rule is why serving a resume
**stamps `servedAt` rather than deleting the file**: the record that today
already had one has to outlive the schedule it describes.

Three more guards live in `schedule_resume_if_warranted`: a `--force` run
schedules nothing (it is one explicit instruction, not a standing one); nothing
is scheduled where the nightly agent is not installed (the same rule
`install_launch_agent(only_if_installed=True)` follows — a machine that just ran
`just uninstall-autonomous-work` must not find an agent written back); and
nothing is scheduled with an empty queue.

**When the window resets — three sources, in order.** The CLI's own notice, when
the run ended on `sessionLimit`; the snapshot's `fiveHourResetsAt`, for the
`fiveHourExhausted` gate ending, which has no notice; and `now + 5h`, which is
always available and errs *late*, the harmless direction. Every candidate gets a
buffer and is then clamped into `(now, now + 5h + 15m]`. **That clamp is what
discards a weekly or Opus limit** — both reach this code by exactly the same
route as a session limit — without having to classify their wording. A notice
that fails the clamp therefore schedules *nothing*, rather than falling through:
it is not this window, and it says nothing about this window being spent. A
notice we merely could not *parse* does fall through, since it tells us nothing
either way.

**The notice's wording is not ours.** `resets 3:50am (Australia/Melbourne)` is
the only sample we have, and `parse_reset_time` returns None rather than a wrong
time on anything else — falling through costs at most one wasted window, where a
wrong time spends the day's only resume. The raw notice is logged beside the
parse result so a wording change is diagnosable from the log alone.

Four places say a resume is coming, because a job that starts at 6 AM for no
visible reason is worse than one that never starts: `autonomous-work.log`, a
`resumeScheduled` event in the run-event stream (which the run-log window's
footer ends on), a `**Resuming:**` line in the day's summary, and
`just autonomous-resume-status`.

## Watching a run live

"Run now" also opens a **detached window** (`run-log.html`, via
`chrome.windows.create`) that streams the run: status header, timeline, Cancel.
"View run" reopens it, showing the most recent run whenever it happened — the
nightly job deliberately raises no window, it just writes to the same stream.
Pressing either twice focuses the open window rather than opening a second, so
the window id lives in `chrome.storage.session`; a module variable would be
forgotten every time the service worker went idle.

**The page opens the native port itself**, in `autonomousRunStream.ts`, which is
a deliberate exception to "the popup asks the service worker rather than doing it
itself". That rule exists so network, storage and badge updates happen in one
place, and a live stream is none of those; meanwhile an MV3 worker is killed when
idle, so holding a port open there for an hour of sporadic events is exactly the
fight `chrome.alarms` exists to avoid. A real document's lifetime matches the
stream's exactly. The architecture rule still holds: only `RunLogRoot.tsx`
touches `extension/`.

Streaming needs `chrome.runtime.connectNative`, not the `sendNativeMessage` every
other host call uses — that one spawns a process, takes a single reply and lets
Chrome tear it down. Chrome spawns a **separate host process per connection**, so
an open window cannot interfere with the five-minutely snapshot writes.

On connect the host **replays the most recent run** rather than only new lines.
The window is created at almost the same moment as the run, and losing the first
seconds to that race would be a miserable bug to chase; it is also what makes
"open the view to see what the nightly job did" work at all. Replays and
rewrites arrive with `replace: true`, so the viewer resets rather than showing a
run twice.

Two things in the host that are load-bearing: `write_message` takes a
`threading.Lock`, because a tail thread and the main loop interleaving two
length-prefixed frames would look, from the extension's side, exactly like the
host crashing; and the tail is a **250 ms stat loop**, because stdlib-only and
3.9-compatible rules out a filesystem-watch API and `kqueue` plumbing would be far
more code than this. It detects the file shrinking or changing inode — which is
what every run start does when it trims the file — and re-reads from the top.
`just test-usage-host` drives that race explicitly.

The host manifest names one `allowed_origins` extension ID. For an unpacked
extension Chrome derives that ID from the absolute load path, which
`extension-id.py` recomputes — so moving or renaming `chrome-extension/dist/` changes the ID and
silently breaks the connection. Re-run `just install-usage-host` if that happens,
or pass an explicit ID as an argument.

**Editing the queue.** `prompts.txt` at the repository root is user-editable —
deliberately at the top level rather than in `backend/`, being the only
file here meant for regular hand-editing. Sections split on a line of `===`;
each has a required `STATUS: todo|completed|error|draft`, an optional `REPO:`,
and a multi-line prompt. The scheduler takes the first `todo`, runs it, rewrites
that status to `completed` or `error`, and — while a pace-gated run — loops back
for the next `todo` rather than stopping. Failed items are skipped until you
edit them back to `todo`. Only two outcomes leave the status alone: a cancelled
prompt and one a subscription limit refused, both of which are picked up again
by the next run. `draft` is skipped the same way — it needs no special
casing in `run-autonomous-work.py`, since `find_next_todo` already ignores any
status that isn't `todo`; it exists purely so a prompt you're still drafting
has a name other than `todo` to sit under.

**`prompts.txt` is gitignored**; `prompts.example.txt` is the checked-in
template to copy from. It is somebody's personal task list, and every run
rewrites a STATUS line in place — tracking it turned each night's work into a
`chore(queue)` commit. Earlier commits still contain it; only tracking stopped.

**A prompt with no `REPO:` gets a new repository**, `git init`-ed under the
configured new-projects folder and named after the date and the first words of
the prompt. It used to share one fixed `~/code/auto-claude` working copy, which
made every "build me an X" prompt contend with the last one's leftovers.

**Settings the extension owns but launchd must read.** The scheduled time and
the new-projects folder are edited in the popup, live in `chrome.storage` — and
neither launchd nor `run-autonomous-work.py` can see that. So the native host
mirrors them to `backend/autonomous-work-settings.json`, and
`autonomous_work_settings.py` is the single module that knows that file's shape.

That module is imported by `usage-host.py`, so it inherits the host's
constraints exactly: **stdlib-only and 3.9-compatible.** Underscores in its name
rather than the hyphens its sibling scripts use, because a hyphen would make it
unimportable.

Changing the time rewrites the installed launch agent and reloads it, since
launchd holds the definition it was given and ignores an edited file. It does
this **only if the agent is already installed** — the settings screen may change
_when_ unattended work runs, but scheduling it in the first place stays an
explicit `just install-autonomous-work`.

Every knob is also an environment variable rather than a code edit —
`AUTONOMOUS_WORK_FIVE_HOUR_EXHAUSTED_PERCENT` (default 100 — the utilisation
that ends a session rather than moving on to the next `todo`),
`AUTONOMOUS_WORK_MAX_RUN_DURATION_SECONDS`, `AUTONOMOUS_WORK_NEW_PROJECTS_DIR` and
`AUTONOMOUS_WORK_PACE_THRESHOLD_MS` (both of which win over their mirrored
setting), `AUTONOMOUS_WORK_RESUME_BUFFER_SECONDS` (default 120 — how long after
a reset a resume fires), and the file-path overrides used by the tests —
including `AUTONOMOUS_WORK_LAUNCH_AGENT_PLIST`, `AUTONOMOUS_WORK_LAUNCHCTL`,
`AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST` and
`AUTONOMOUS_WORK_RESUME_STATE_FILE`, which are what let `just test-usage-host`
and the unit tests exercise the scheduling paths without touching the jobs
installed on the machine.

**The pace threshold is set in the extension's Settings screen, in hours** —
positive tolerates being that far ahead of an even weekly burn before the
scheduler stops; negative requires being at least that far behind before it
starts. It is mirrored to `backend/autonomous-work-settings.json` the same way
as the schedule time and new-projects folder, and `run-autonomous-work.py`
converts it to milliseconds. Default is 0h (any amount ahead skips the run,
any amount behind allows it).

**The newest snapshot is used however old it is — there is no freshness gate.**
That is deliberate: the extension can only refresh while Chrome is running, so
gating on age would mean the nightly job almost never fires on a machine whose
browser is closed at 2 AM. The trade is that a long-closed browser can have the
job act on figures from days ago; the age is logged on every decision so that is
visible after the fact. A missing `weeklyPaceDeltaMs` still skips the run, since
an inactive weekly window is genuinely no data rather than a stale reading.

**launchd starts jobs with a bare environment.** `uv` and `claude` live in
`~/.local/bin`, which is why the plist sets `PATH` explicitly. A missing entry
surfaces only as "command not found" in `backend/system.log`.

**Protected folders — measured, and counter-intuitive.** `~/Desktop`,
`~/Documents`, `~/Downloads` and iCloud Drive are gated by TCC. The failure
depends on how the run started: a **launchd** run is refused silently with
`Operation not permitted`, while a run started from **Run now** raises a dialog,
because Chrome is in that chain. So the only way to grant a folder is Run now
plus a click; there is no scriptable path.

**Granting has to happen from the extension**, which is why Settings has a
"Grant folder access" button going popup → service worker → native host →
detached `check-folder-access.py`. A `just` recipe cannot do it: a request made
from a terminal is attributed to Terminal or iTerm, whose grants satisfy it
silently, so no dialog appears and nothing is recorded for the runner. Only the
Chrome path prompts. The same script serves both purposes — under launchd it
reports, under Chrome it asks.

`just check-folder-access` reports what the nightly job can reach, and runs the
check **as a launchd job** for a reason: from a terminal every folder reads as
available, because access is attributed to Terminal or iTerm and their grants
pass down. Any test of this run from a shell is worthless.

**The grant is scoped by code signature, and that is the whole mechanism.** The
job runs `backend/bin/claude-usage-optimizer-uv`, a copy of uv re-signed
with the identifier `com.claudeusageoptimizer.autonomouswork.uv`. Re-signing is what
makes it a separate client from the uv on `PATH`, which has three consequences
worth knowing before touching any of it:

- A byte-identical `cp` is the _same_ client as the uv it came from and inherits
  its grants. The re-sign in `install-private-uv` is not decoration; without it
  the copy achieves nothing.
- The filename is only what System Settings displays, which is why it is not
  called `uv` — two rows both named `uv` cannot be told apart. Whether renaming
  the file _keeps_ its grants was tested twice and settled neither time; treat a
  rename as costing them, and choose the name before granting anything.
- Replacing the copy changes the bytes and so the signature, and the grants go
  with it. `install-private-uv` therefore never overwrites an existing copy;
  `refresh-private-uv` is the deliberate escape hatch and says what it costs.

**A toggle switched off in System Settings is a recorded denial, not a reset.**
The Grant folder access button will then do nothing at all, silently — no
dialog, no error. The row has to be deleted with **−** before macOS will ask
again. Anyone debugging "the button does nothing" should check that first.

**Measure, do not reason, about any of this.** Four mechanisms were proposed and
confidently argued for during the work that produced this section — a launcher
binary that stayed alive as the parent, an `.app` bundle, the interpreter
identity, a Python version pin — and every one was wrong. The probes that seemed
to refute the copy were run while a shared grant was still live and quietly
satisfying everything. `just check-folder-access` exists because it measures the
real chain through launchd; a check run from a terminal reports Terminal's
permissions and is worthless.

**Never ask for Full Disk Access.** Per-folder grants on a private binary are
strictly better, and FDA on anything shared would hand arbitrary `uvx` packages
the user's Mail, Messages and Safari data.

The `claude -p` invocation is deliberately plain apart from `--permission-mode
auto`. Notably it does **not** pass `--bare`, which would authenticate with
`ANTHROPIC_API_KEY` and so spend the wrong budget entirely.

## Tech Stack

- **Language**: TypeScript with strict mode enabled
- **Styling**: Tailwind CSS v4 with the Vite plugin, CSS-first config in
  `chrome-extension/index.css`
- **UI Components**: shadcn/ui-style primitives, hand-written in
  `chrome-extension/components/ui/`
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
