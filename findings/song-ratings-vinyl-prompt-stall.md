# Why the song-ratings "Random Rated" prompt did nothing despite `STATUS: completed`

Checked: 2026-08-12

## Verdict

The queued prompt never got past exploration. A **Claude Code CLI-internal**
limit — not anything this repo defines — cut the turn short after 10 minutes of
waiting on a background research agent, before any file was written. The
subprocess still exited `0`, so `run-autonomous-work.py` logged it as a success
and wrote `STATUS: completed` to `prompts.txt`. The entry is still marked
`completed` as of this check; nothing was implemented.

## The prompt

`prompts.txt`, repo `~/code/current/song-ratings`:

> Add a new feature to the app. On the vinyl page, add a button "Random Rated"
> that picks a random rated vinyl album, weighted towards more highly rated
> albums… Create a new branch and add a commit…

## What actually happened

From `.claude-scripts/autonomous-work.log`, run started 2026-08-12 04:19:32
(session `297f1c7d`):

1. Claude launched a background `Agent(Explore vinyl feature code)` to map the
   codebase, then spent the next ~17 minutes doing its own parallel
   `grep`/`find`/`cat` over `web-frontend`, `backend`, `api-design`, and
   `mobile-app` — explicitly waiting for the background agent's findings before
   writing any code ("I'll wait for the exploration agent to finish before
   implementing…", "I don't need to schedule a wakeup—I'll be notified
   automatically when the exploration agent finishes.").
2. At 04:36:04 the log records:

   ```
   Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.
   ```

   The background Explore agent had not returned within 10 minutes, so the CLI
   force-ended the turn and killed it.
3. `claude finished: success (6 turns, 30s, $0.27)` — a suspiciously small
   turn/cost count for 17 minutes of wall-clock time, consistent with the run
   being cut off mid-exploration rather than reaching a natural stop.
4. Exit code `0` → `run-autonomous-work.py` marked the queue entry
   `completed` and moved on to the next `todo`.

Confirmed against the actual repo:

```
$ cd ~/code/current/song-ratings && git status && git branch -a
On branch main
nothing to commit, working tree clean
  fix-logout-token
* main
  sorting
```

No new branch, no commit, no code — despite the prompt explicitly asking for
both, and despite `prompts.txt` still reading `STATUS: completed`.

## Root cause

`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` — a Claude Code CLI default (600,000ms /
10 minutes), **not set anywhere in this repo's scripts**. In `-p` (print,
non-interactive) mode, if a turn is waiting on a background task (here, an
`Agent` call) and that task hasn't returned within the ceiling, the CLI kills
the background work and ends the turn anyway. The process still exits `0`.

This is unrelated to either of this repo's own duration guards:

- **`CLAUDE_MAX_PROMPT_DURATION_SECONDS`** (`run-autonomous-work.py`, this
  repo's watchdog on one `claude -p` subprocess, default 5h) — never came
  close to firing; the whole run finished in under a minute of actual `claude`
  runtime once the CLI's own 600s ceiling cut it off.
- **`FIVE_HOUR_EXHAUSTED_PERCENT`** (the pace-gated session's usage-window
  stop condition) — governs whether the *scheduler* starts another queued
  prompt, not any single prompt's behavior.

## Why it reads as a false "completed"

`run_claude()` only checks the subprocess's exit code to decide
`completed` vs. `error`. A turn that the CLI forcibly ended (background task
timeout) still exits `0` like a turn that finished normally — there is no
signal in the exit code that distinguishes "the model decided it was done"
from "the harness cut it off mid-task." Nothing in the current pipeline
inspects *what* happened during the run (e.g., whether a branch was created or
a commit made) before trusting the exit code.

## Update 2026-08-12: the real root cause is the machine going to sleep

The 600s figure in the CLI's message is a red herring for how long the wait
actually was. Cross-referencing `pmset -g log` against the three background-task
kills logged overnight (song-ratings at 04:36:04, tododoo at 04:52:37 and
06:14:25) shows each one immediately preceded by a real `Sleep` state — not
DarkWake — entered a few hundred seconds earlier, with a scheduled wake time
that lines up with the kill to the second:

| Kill logged | `Entering Sleep` | Scheduled duration | Scheduled wake |
| ----------- | ----------------- | ------------------- | ---------------- |
| 04:36:04    | 04:20:10 (`Sleep Service Back to Sleep`) | 954s | 04:36:04 |
| 04:52:37    | 04:36:48 (`Sleep Service Back to Sleep`) | 949s | 04:52:37 |
| 06:14:25    | 05:58:22 (`Maintenance Sleep`)           | 963s | 06:14:25 |

The subagent's own transcript (still on disk under
`/private/tmp/claude-501/.../tasks/<agentId>.output` when this was checked) did
~26s of real work after launch, then went completely silent at the same instant
the machine entered `Sleep` — no further tool calls, no thinking, nothing —
until a synthetic `[Request interrupted by user]` at the wake instant. The
machine's idle-sleep timer was **1 minute on AC power**
(`pmset -g custom` → `AC Power: sleep 1`), with `powernap 1` cycling it through
brief maintenance wakes and back to sleep all night. Every open network
connection, including the one carrying the background agent's next response,
froze for the full sleep duration with no error on either side; the CLI's
600s background-task ceiling had already elapsed by the time the machine woke,
so it killed the task the instant it could.

This also explains the unrelated-looking `API Error: Your computer went to
sleep mid-response` at 05:57:37 later in the same log — same mechanism hitting
a foreground turn instead of a background agent. Foreground surfaces it as an
explicit error (correctly marked `STATUS: error`); background silently eats it
and reports `completed`.

**Fix applied:** `run_claude()` in `run-autonomous-work.py` now spawns
`caffeinate -s -w <claude's pid>` alongside `claude` — a system-sleep assertion
that needs no cleanup of its own, since `-w` ties its lifetime to `claude`'s PID
and it exits the moment `claude` does, however that happens. Best-effort: a
missing `caffeinate` logs a warning rather than failing the run.

Separately, this machine's own AC power settings are the underlying reason
sleep was happening at all: `pmset -g custom` showed `sleep 1` (idle sleep
after one minute) on AC, independent of `displaysleep` (10 minutes). Running
`sudo pmset -c sleep 0` disables AC idle sleep while leaving `displaysleep`
alone, so the monitor still turns off — that machine-level change is still
**pending**, since it needs an interactive sudo password. The `caffeinate`
wrapper covers the run either way, including if that setting is ever reset or
the job runs on a machine with different power settings.

## Not yet addressed

- The `song-ratings` queue entry is still `STATUS: completed` and needs to be
  hand-edited back to `todo` to retry.
- The scheduler still trusts exit code alone (see "Why it reads as a false
  'completed'" above) — the sleep-avoidance fix stops this specific cause, but
  a session cut short for some other reason would still be misreported as
  `completed`. Having the scheduler treat "0 files changed, no commit" as
  suspicious for a prompt that explicitly asked for a branch and a commit is
  still worth considering.
