# Plan: Resume a session when the 5-hour window resets

## Goal

Today a session that runs into the 5-hour session window just stops. The queue
still has `todo` entries, the week is still behind an even burn, and the one
thing standing in the way — the session window — refills at a known time, often
only two or three hours away. Nothing picks the work back up until 2 AM the
next night.

This adds a **resume**: when a session ends because the 5-hour window is spent,
the scheduler asks launchd to start it again shortly after that window resets.
The resumed run is an ordinary pace-gated run, not a forced one — if the week
has caught up to pace by then, it correctly does nothing.

**One resume, once per day.** A resumed run that runs into the window again does
not schedule a third; the queue waits for the next scheduled run. That bound is
what keeps a single night's decision from walking through the following day, and
§3 explains what else it saves us from writing.

Non-goals: chaining resumes; waiting in-process; resuming for the weekly or Opus
limits (their reset is days away, and the nightly job already covers that);
anything that needs Chrome to be open.

## 1. What "hit the 5-hour window" actually means

Two different endings mean it, and they arrive by different routes. Both are
already recognised — this feature adds no new detection, only a consequence.

| Ending | Where it comes from | What we know |
| --- | --- | --- |
| Gate reason `fiveHourExhausted` | `evaluate_pace_gate`, from the snapshot's `fiveHourPercent` | The snapshot said the window was full. It can be hours stale. |
| Outcome `sessionLimit` | `session_limit_message`, read live out of the CLI's stream | The CLI refused a prompt *just now*, and its notice names a reset time. |

The second is the strong case: the evidence is seconds old and carries the
answer to "when does it come back". The first is the weak one, and §3 exists
mostly to keep it from looping.

Two endings that must **not** schedule a resume:

- **A weekly or Opus limit.** It also arrives as `sessionLimit`, since the CLI
  reports all three the same way. §2's clamp rejects it without needing to
  classify the wording: a reset three days out is not a reset this feature has
  anything to say about.
- **`--force`.** A forced run is single-shot by definition (see the `--force`
  note in CLAUDE.md); a button press is one instruction, not a standing one.
  See §7 — this is the decision most worth disagreeing with.

## 2. When does the window reset — three sources, in order

Nothing on disk currently answers this. `backend/claude-usage.json` carries
`fiveHourPercent` but no reset time, and the log carries prose.

1. **The CLI's own notice**, when the run ended on `sessionLimit`. It reads
   `You've hit your session limit · resets 3:50am (Australia/Melbourne)`.
   Parsed by a new `parse_reset_time` in `run-autonomous-work.py`:

   ```python
   RESET_TIME_PATTERN = re.compile(
       r"resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?", re.IGNORECASE
   )
   ```

   Hour/minute are wall-clock. If a zone name is given and `zoneinfo` resolves
   it, convert; otherwise read it as local time — it is the user's own machine
   and the CLI reports in that machine's zone. Take the **next** occurrence in
   the future, since the notice gives no date.

2. **The snapshot**, via a new `fiveHourResetsAt` field (§4). Used for the
   `fiveHourExhausted` ending, which has no notice. Only accepted if it is in
   the future.

3. **`now + 5 hours`.** Always available, and wrong by at most one window. It
   errs *late*, never early, which is the right direction: a late resume wastes
   idle time, an early one is refused and wastes the day's only resume.

Whatever the source, two adjustments:

- **A buffer**, `AUTONOMOUS_WORK_RESUME_BUFFER_SECONDS` (default 120), added
  before scheduling. launchd's calendar granularity is a minute, and firing in
  the same minute the window resets is asking to be refused again.
- **A clamp**: the fire time must fall in `(now, now + 5h + 15m]`. A reset
  further out is not this window, and this is what silently discards the weekly
  and Opus limits without parsing their wording. A source that fails the clamp
  falls through to the next one — except source 1, which fails the clamp only
  when it is a different limit entirely, so it falls through to **no resume at
  all** rather than to `now + 5h`.

## 3. The guards — one rule, and what it makes unnecessary

**One resume per day, and never from a resume.** A resumed run does not schedule
another one. It is a second attempt at the night's work, not the start of a
chain, so when it too runs into the window the queue simply waits for the next
scheduled run.

> A resume is scheduled only by a run that is not itself a resume, and only once
> per calendar day.

The second half of that rule matters because `just trigger-autonomous-work`
(without `--force`) is also a run that can schedule one. The day is stamped in
the state file — which is why serving a resume marks it `servedAt` rather than
deleting it (§5): the record of "today already had one" has to outlive the
schedule it describes.

**What the rule makes unnecessary.** Chaining was the dangerous part, and the
danger was specific: a resumed run reads the same snapshot file, so if Chrome
has been closed since, that file still says the five-hour window is at 100%,
the gate skips with `fiveHourExhausted`, and the run schedules *another* resume
five hours out — forever, on the strength of one stale reading. Under a
no-chain rule that cannot happen at all, so there is no freshness test to write,
no chain counter to keep, and no `AUTONOMOUS_WORK_MAX_RESUMES` to tune. It is
worth recording that this is *why* chaining is not allowed, so nobody adds it
back as an obvious improvement.

**A stray fire.** The plist is pinned to a Month as well as a Day (§4), so a
resume that is never cleaned up fires again a year later. The state file makes
that a no-op: `--resume` with no pending state, with one already marked served,
or with a `scheduledFor` more than an hour in the past, logs one line and
exits 0.

Also: no resume is scheduled when the queue holds no `todo` entry. There is
nothing to come back for.

## 4. Mechanism: a third launch agent, fired once

```
com.claudeusageoptimizer.autonomouswork           2 AM, pace-gated       (existing)
com.claudeusageoptimizer.autonomouswork.ondemand  no schedule, --force   (existing)
com.claudeusageoptimizer.autonomouswork.resume    one date and time, --resume   (new)
```

`backend/com.claudeusageoptimizer.autonomouswork.resume.plist` is a template
like its two siblings, with `__MONTH__`, `__DAY__`, `__HOUR__` and `__MINUTE__`
substituted at scheduling time:

```xml
  <key>ProgramArguments</key>
  <array>
    <string>__PROJECT_ROOT__/backend/claude-usage-autonomous-work</string>
    <string>--resume</string>
  </array>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key><integer>__MONTH__</integer>
    <key>Day</key><integer>__DAY__</integer>
    <key>Hour</key><integer>__HOUR__</integer>
    <key>Minute</key><integer>__MINUTE__</integer>
  </dict>
```

**Pinning Month and Day is what makes it one-shot.** launchd has no one-shot
calendar job: `Hour`/`Minute` alone repeat daily, `Day` added repeats monthly,
`Month` added repeats yearly — which, combined with the state file, is a
one-shot in every sense that matters. It cannot boot itself out at fire time:
`launchctl bootout`/`unload` of a label kills the job's own running process,
and the scheduler's SIGTERM handler would record the run as **cancelled**.

The agent carries `--resume`, not `--force`, so the pace gate still applies and
the run drains the queue the way the nightly one does.

**Why not the alternatives**, all of which were considered first:

- **Sleep in-process until the reset.** A launchd job holding a process for
  five hours, overlapping the next nightly run, invisible to
  `just autonomous-running`, and asleep whenever the Mac is. CLAUDE.md already
  records why a session ends rather than waiting out the window; that reasoning
  is unchanged, and scheduling a wake-up is precisely how to honour it.
- **A second `StartCalendarInterval` entry on the nightly agent.** launchd
  accepts an array of dicts, which would need no third label and no `--force`
  worry. But the reset time is only known at the *end* of a run, and rewriting
  that agent means `launchctl unload` — killing the very run doing the writing.
- **`chrome.alarms` plus a kickstart of the on-demand agent.** Needs Chrome
  open at the reset, and the on-demand agent carries `--force`, which is exactly
  the gate the resume must not bypass.
- **`at(1)`.** `atrun` is disabled by default on macOS and needs Full Disk
  Access to enable, which CLAUDE.md rules out for good reasons.

## 5. Code changes, file by file

### `backend/autonomous_work_resume.py` (new)

Stdlib-only and 3.9-compatible like its siblings, underscores because
`run-autonomous-work.py` imports it. Owns the state file's shape and the resume
agent's lifecycle — nothing else knows either.

```python
RESUME_LAUNCH_AGENT_LABEL = LAUNCH_AGENT_LABEL + ".resume"
RESUME_STATE_FILE  = _environment_path("AUTONOMOUS_WORK_RESUME_STATE_FILE", ...)
INSTALLED_RESUME_LAUNCH_AGENT_FILE = _environment_path(
    "AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST", ...)

@dataclass(frozen=True)
class PendingResume:
    scheduled_for: datetime      # local, buffered, already clamped
    scheduled_at: datetime
    reason: str                  # "sessionLimit" | "fiveHourExhausted"
    source: str                  # "cliNotice" | "snapshot" | "fallback"
    served_at: datetime | None   # set when the resume run consumed it

def schedule_resume(pending) -> ResumeUpdate   # write plist, reload, write state
def read_pending_resume() -> PendingResume | None       # None once served
def consume_pending_resume() -> PendingResume | None    # read, then stamp servedAt
def resume_scheduled_today(now) -> bool        # served or pending, either counts
def cancel_resume() -> None                    # unload, remove plist and state
```

`backend/autonomous-work-resume.json` is the state file, gitignored beside the
other runtime files:

```json
{
  "scheduledFor": "2026-08-25T18:17:00+10:00",
  "scheduledAt":  "2026-08-25T13:15:41+10:00",
  "reason": "sessionLimit",
  "source": "cliNotice",
  "servedAt": null
}

The file is **stamped, not deleted, when the resume runs** — `servedAt` is
filled in instead. A deleted file would take with it the fact that today
already had its resume, which is half of §3's rule.
```

### `backend/autonomous_work_settings.py`

- Promote `_write_and_load_agent` and `_run_launchctl` to `write_and_load_agent`
  and `run_launchctl` so the resume module reuses them rather than
  re-implementing the unload-before-rewrite rule, which is the one thing about
  launchd that is easy to get wrong twice.
- `_render_template` takes an optional `extra_replacements` mapping, for
  `__MONTH__` and `__DAY__`.
- `install_launch_agent` leaves the resume agent alone. It is written by runs,
  not by settings.

### `backend/run-autonomous-work.py`

- `--resume` argument. At startup it calls `consume_pending_resume()`; a
  missing, already-served or long-past state file logs and returns 0 (§3, stray
  fire). Otherwise the run proceeds exactly as the nightly one does, except that
  it schedules no resume of its own.
- `parse_reset_time(notice, now)` → `datetime | None`, and
  `choose_resume_time(...)` implementing §2's three sources, buffer and clamp.
  Both pure, both unit-tested — this is the arithmetic most worth getting right,
  and it follows `evaluate_pace_gate` in being split from its I/O for that
  reason.
- At the two ending points in `main`'s loop — the `fiveHourExhausted` gate break
  and the `OUTCOME_SESSION_LIMIT` break — call one new
  `schedule_resume_if_warranted(...)` holding every §3 guard. It returns the
  `PendingResume` it scheduled, or None with a logged reason.
- `RunEventStream.resume_scheduled(...)` emits a new envelope event, and
  `finish_session` records the pending resume on the summary.

### `chrome-extension/lib/usageSnapshotExport.ts`

One new field, from `ActiveWindowStatus.windowResetsAt`:

```ts
  /** ISO 8601, or null when the API did not report a current session window. */
  fiveHourResetsAt: string | null;
```

This is a contract with the Python reader, so `read_pace_snapshot` gains a
matching optional `five_hour_resets_at` on `PaceSnapshot` and tolerates its
absence — an extension that has not been rebuilt must keep working, falling
through to source 3.

## 6. Surfacing it

A scheduled resume that nobody can see is a job that starts at 6 AM for no
visible reason. Four places say so:

- **`autonomous-work.log`** — `Resuming at 6:17am (5-hour window resets 6:15am,
  from the CLI's notice)`, or the reason none was scheduled.
- **`autonomous-run-events.jsonl`** — a `resumeScheduled` event, so the run-log
  window's footer can end with "Resuming at 6:17am" instead of just stopping.
  Needs the matching arm in `lib/autonomousRunEvents.ts` and a line in
  `autonomousRunViewModel.ts`.
- **The day's summary** — a `**Resuming:** 6:17am, when the 5-hour session
  window resets.` line under **Why it stopped**, and the two relevant entries in
  `STOP_REASON_DESCRIPTIONS` amended so they no longer end on "the run ended".
  Note the ordering problem: the resume is scheduled inside the loop, and
  `finish_session` renders afterwards — so `SessionSummary` carries it, rather
  than the summary module reading the state file itself.
- **`just`** — `autonomous-resume-status` (what is pending, and whether launchd
  is holding it), `cancel-autonomous-resume`, and the resume label added to
  `uninstall-autonomous-work` and to `autonomous-status`.

`cancel-autonomous-work` should also clear a pending resume: cancelling a run
and then having it silently restart itself five hours later is not what anyone
means by cancel.

## 7. Decisions taken

1. **A `--force` run schedules no resume.** `--force` is documented as
   single-shot, it is the path the test recipes take, and a button press is one
   instruction rather than a standing one. So "Run now", refused by a limit,
   stays refused — the next scheduled run picks the entry up, still `todo`.
2. **A run that never got a prompt started still schedules a resume.** The 2 AM
   gate finding the window already full is the case this feature exists for:
   the week is behind, the queue is full, and the obstacle clears at a known
   time. Whatever stopped the run — a spent window, or something transient at
   the other end — is more likely to be gone in five hours than in twenty-four.
3. **No confinement to the small hours.** A resume may land in the middle of
   the working day — up to five hours after the run that scheduled it, and no
   further, since there is exactly one per day (§3). The pace gate means it only
   ever spends what the week is already behind. A "resume only before HH:MM"
   setting is not being built.
4. **A resume requires the nightly agent to already be installed.** Explained
   below, since it is the least obvious of the four.

### On requiring the nightly agent

Installing the resume agent means writing a plist into
`~/Library/LaunchAgents` and asking launchd to hold it — the same act as
`just install-autonomous-work`, differing only in that a run decided it rather
than the user. On a machine where the nightly job is installed that is
uncontroversial: the user has already said "run unattended work on a schedule",
and a resume is that schedule adapting to a window it ran into.

On a machine where the nightly job is *not* installed, it would be the software
scheduling unattended work that nobody asked for. That covers two people: one
who never ran `just install-autonomous-work`, and one who deliberately ran
`just uninstall-autonomous-work`. The second is the one that matters — having
just unscheduled unattended work, they would find a launch agent reinstalled
behind them.

The precedent is already in the codebase:
`install_launch_agent(only_if_installed=True)` lets the extension's settings
screen change *when* the nightly job runs, but never schedule it in the first
place. This is the same rule, applied to the same directory, for the same
reason.

Given decision 1, the check only ever bites in one situation: `just
trigger-autonomous-work` without `--force`, on a machine with no nightly agent
installed. Rare — but the cost of the check is one `exists()` call and a logged
line, so it is worth having. Concretely, in `schedule_resume_if_warranted`:

```python
if not autonomous_work_settings.INSTALLED_LAUNCH_AGENT_FILE.exists():
    log_message("Nightly job is not installed — not scheduling a resume")
    return None
```

### Follow-up this raises, deliberately out of scope

Decision 2's reasoning — that the obstacle may be transient rather than a spent
window — points at a case this feature does **not** cover. A prompt that fails
because the API was down is recorded as `error`, and an entry marked `error` is
skipped until somebody edits `prompts.txt` by hand. A resume does not help
there, because the entry will no longer be `todo` when it fires. Retrying a
genuinely failed prompt is a separate change: it needs a way to tell "failed
because of something at the other end" from "failed because the prompt is
wrong", which is a harder question than any in this plan.

## 8. Risks and unknowns

- **The notice's wording is not ours.** `resets 3:50am (Australia/Melbourne)`
  is the only sample we have. `parse_reset_time` must return None rather than a
  wrong time on anything it does not recognise, and falling through to
  `now + 5h` costs at most one wasted window. Log the raw notice beside the
  parse result so a wording change is diagnosable from the log alone.
- **Sleep and shutdown.** launchd runs a missed `StartCalendarInterval` when
  the Mac wakes, but not one missed while it was powered off. A resume that
  never fires leaves a stale state file, which §3's stray-fire guard already
  handles; the nightly run then picks the queue up as it does today.
- **Clock and zone changes** between scheduling and firing (DST, travel).
  `StartCalendarInterval` is wall-clock, so a DST jump can move a resume by an
  hour in either direction. Harmless — an hour early is refused and an hour
  late is idle — but worth a sentence in the plist template's comment.
- **The unverified 5-hour-window assumption** in CLAUDE.md applies here too: if
  the window is rolling rather than a fixed block, source 3's `now + 5h` is a
  worse guess than it looks. Sources 1 and 2 are unaffected, being reported
  absolutes.

## 9. Phases

1. **Extension** — add `fiveHourResetsAt` to the export and its test. Ship this
   first: it takes a Chrome reload to reach disk, and the Python side needs the
   field present to be worth testing against. (Remember the BUILD_STAMP note in
   CLAUDE.md — quit and reopen Chrome, do not just reload.)
2. **Pure logic** — `parse_reset_time` and `choose_resume_time`, with unit tests
   in `backend/tests/test_run_autonomous_work.py`: each source, the buffer, the
   clamp, a weekly-limit notice, an unparseable notice, a past snapshot time.
3. **The module and the agent** — `autonomous_work_resume.py` and the plist
   template, tested through `AUTONOMOUS_WORK_RESUME_LAUNCH_AGENT_PLIST` and the
   fake `AUTONOMOUS_WORK_LAUNCHCTL` the settings tests already use, in a new
   `backend/tests/test_autonomous_work_resume.py`.
4. **Wiring** — `--resume`, the two ending points, the guards, and tests for the
   guards themselves: a resume run scheduling nothing further, a second run the
   same day scheduling nothing, the empty queue, the stray fire, an
   already-served state file.
5. **Surfacing** — log line, `resumeScheduled` event and its viewer arm, the
   summary line, the `just` recipes, `cancel-autonomous-work` clearing state.
6. **Docs** — CLAUDE.md's "Autonomous work scheduler" section gains the third
   label and the one-shot-plist reasoning; its list of environment knobs gains
   `AUTONOMOUS_WORK_RESUME_BUFFER_SECONDS`; the recipe list gains the two new
   ones. `just check` and
   `backend/tests/run_tests.py` pass.

## 10. Success criteria

- A session that ends on `sessionLimit` with work still queued writes a resume
  agent whose fire time is within a couple of minutes of the reset the CLI
  named, and `launchctl list` holds it.
- That agent fires once, runs the queue pace-gated, and does not fire again.
- The resumed run schedules nothing further, whatever it runs into — including
  the same 5-hour window a second time, and including on a machine whose
  snapshot has not been refreshed since.
- A second run on the same day schedules nothing either.
- A weekly-limit refusal schedules nothing.
- `just cancel-autonomous-work` leaves no pending resume behind.
