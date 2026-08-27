# Plan: The work queue as GitHub issues

> **Status: rejected. Not being built.** Issues lose to a plain text file on
> per-entry ergonomics — a forced title, clunky sub-issue ordering, and above all
> no context to copy a `REPO:` path from while composing. The file was never the
> problem; its location was. See **§14** for the reasoning and the direction that
> replaces it. Everything above §14 is kept as the record of a design that was
> worked out properly and still lost.

## Goal

`prompts.txt` lives on one Mac. Adding a prompt to the queue, or checking what
last night's run did, means being at that Mac — which is the wrong constraint
for a queue whose whole purpose is to be worked through while you are asleep or
elsewhere.

This makes **GitHub issues an alternative source for the queue**. The user
supplies a repository and one **parent issue whose ordered sub-issue list is the
queue**; the run works through that list top-down and writes back — labels for
status, a closing comment carrying Claude's own account of what it did.

The file source stays exactly as it is and stays the default. Nothing about a
fresh clone changes, and nobody is required to have a GitHub account to use the
scheduler.

Non-goals: mirroring issues into `prompts.txt` or back (§5 explains why that is
the one design that must not be built); a GitHub App, webhooks, or anything that
listens; pull-request integration; the run ever *changing* the order (it reads
the order, it never writes it); running against a public repository without
saying so loudly.

## 1. Why issues rather than a file synced somewhere

Four designs were compared — a private gist, a Google Doc, a synced folder
(Drive/iCloud/Dropbox), and issues. The first three are all the same shape: a
text file somewhere else, which needs a sync mechanism, a merge rule for when
both ends changed, and a text editor on a phone. Issues need none of the three.

- **No merge.** GitHub holds the only copy. There is no local file to diverge,
  so there is no conflict rule to get wrong at 2 AM.
- **The status field already has a UI.** A label is a tap. Today, re-queuing a
  failed prompt means editing a `STATUS:` line in a text file.
- **The order is explicit and draggable.** Sub-issues under one parent are a
  hand-ordered list, which is the property `prompts.txt` gets for free by being
  a file read top to bottom. Losing it was the flaw in this plan's first draft,
  and §2 is mostly about getting it back.
- **The line-index fragility disappears.** `status_line_index`,
  `rewrite_status_line`'s "is this still a STATUS line" guard, and the whole
  "queue edited mid-run" hazard exist because the file addresses an entry by
  position. An issue number is a stable identity that survives any edit —
  including a reorder, which is the point.
- **There is somewhere to put the account of what happened.** This is the real
  prize, and §6 is about it. Today Claude's closing message lands in
  `summaries/YYYY-MM-DD.md` on the Mac — the one place you cannot read it from
  a train.

The cost is that the queue stops being one hand-editable file, which CLAUDE.md
currently calls out as a deliberate property. That is why this is a *source*,
selected in settings, and not a replacement.

## 2. The mapping

**The queue is one parent issue whose sub-issue list, in order, is the queue.**
Everything else follows from that.

| `prompts.txt`            | GitHub                                                     |
| ------------------------ | ---------------------------------------------------------- |
| the file, read top-down  | the parent issue's ordered sub-issue list                  |
| position in the file     | position in that list — dragged, or `reprioritizeSubIssue` |
| `STATUS: todo`           | a sub-issue, open, carrying no skip label                  |
| `STATUS: draft`          | filed but not attached — or attached with `claude:draft`   |
| `STATUS: completed`      | closed, labelled `claude:completed`                        |
| `STATUS: error`          | open, `claude:error`                                       |
| `STATUS: unmerged:<b>`   | open, `claude:unmerged`, branch named in a comment         |
| `REPO: ~/code/x`         | a `REPO:` line at the top of the issue body — unchanged    |
| the prompt body          | the rest of the issue body                                 |
| (nothing)                | the issue title — free text, for scanning on a phone       |
| first `todo` in the file | first sub-issue that is open and carries no skip label     |

**Ordering was the thing to get right, and it was measured rather than assumed.**
`Issue.subIssues` takes no `orderBy` argument: it returns the parent's stored
order, which is exactly what dragging a sub-issue in the UI writes, through
`reprioritizeSubIssue(issueId, subIssueId, afterId|beforeId)`. So the list you
see on a phone is the order the run takes, and reordering it is a drag.

Two alternatives were measured and rejected:

- **Issue number ascending.** Creation order, and unchangeable. This was the
  first draft's answer and it is simply wrong for a queue you want to reprioritise
  from a train.
- **A Projects v2 board.** It does expose manual order — `ProjectV2Item` carries
  no readable `position` of its own, but `items(orderBy: {field: POSITION,
  direction: ASC})` returns the board's order — and it has the nicer drag
  surface. It also needs the **`read:project`** scope, which the default `gh`
  token does not carry:

  ```
  Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
  INSUFFICIENT_SCOPES: 'projectV2' requires ['read:project']
  ```

  That costs a `gh auth refresh -s read:project` and so gives up §4's best
  property, that anyone who has run `gh auth login` needs no setup at all.
  Sub-issues read over plain `repo` scope — the probe returned `200` with the
  token already on the machine.

**Membership in the list is the gate, replacing a `claude:todo` label.** This is
what lets a real project's repository work without a mode switch: forty issues,
three of them attached to the queue parent. Attaching is the queueing action, and
it is also where the entry lands in the order — one gesture, two decisions.

**Skip labels, not a status field.** An entry is `todo` when it is open and
carries none of `claude:error`, `claude:unmerged` or `claude:draft`; closed means
done. That is `find_next_todo`'s existing rule — ignore any status that is not
`todo` — spelled in labels, so the reading side needs no new concept.

**Why a failed entry keeps its place rather than being detached.** Same rule the
file follows: a failure is skipped until a human re-queues it, and re-queuing is
removing the label. Detaching would also work, but it would throw away the
entry's position and drop it out of the one list you actually look at. The file
does not delete a failed section either.

**Why a draft is, by default, an issue not yet attached.** You jot something down
on the train and it does not run until you deliberately put it in the queue —
the right default, and the same argument the original label-absence rule made.
A `claude:draft` label covers the other case, an entry already placed in the
order that you are still writing, and needs no special casing: it is just
another skip label.

**Closing for done, because the parent renders it.** GitHub shows a parent's
sub-issues as a progress list with closed ones struck through, so "what ran last
night" is the ticked top of that list. Closing is also what closing an issue
means to everybody who has ever used GitHub, and on a phone it is one tap.

**`claude:running`** is set when a prompt starts and cleared by every terminal
path, including the SIGTERM handler that already writes the cancelled summary.
A hard kill can strand it; the next run clears any stale one at startup, which
is safe because launchd will not run two instances of one label, so a
`claude:running` seen at startup is by definition stale.

**The run never reorders anything.** `reprioritizeSubIssue` is named here only
because it is what the UI calls; the scheduler treats the order as read-only
input. Nothing in an unattended job should be quietly rearranging the list you
arranged.

## 3. Which repository — and why the parent-issue gate makes the answer flexible

The user supplies `owner/repo` and the parent issue's number. **Only issues
attached to that parent are ever picked up**, and that one rule gives two
workflows without a mode switch:

- **A dedicated queue repository.** Every issue is a prompt. Suggested name when
  the app offers to create one: **`claude-work-queue`** — dull on purpose, so
  that in six months it is not mistaken for an abandoned project. Suggested,
  never enforced.
- **A real project's repository.** Forty issues, three of them attached to the
  queue parent. The work is filed where the work lives, and `REPO:` can be
  defaulted from the repository's own local clone rather than written out by
  hand.

**Private is not enforceable, so it is checked and reported.** `prompts.txt` is
gitignored precisely because it is somebody's personal task list; pointing this
at a public repository publishes that list. `just queue-check` says so plainly,
and configuring a public repository prints a warning rather than refusing —
it is a legitimate choice for a public project's issue tracker.

## 4. Transport: the `gh` CLI

Measured, not assumed: `gh`'s default token already carries the `repo` scope
(`admin:public_key, gist, read:org, repo`), and the nightly plist already puts
`/opt/homebrew/bin` on `PATH` with `HOME` set. So a user who has ever run
`gh auth login` needs **no token, no OAuth app, and no plist change** — which is
precisely the property §2 declined to trade away for a Projects board.

Six commands cover everything:

```sh
gh api /repos/R/issues/P/sub_issues --paginate             # the queue, in order
gh issue edit  --repo R N --add-label X --remove-label Y
gh issue close --repo R N
gh issue comment --repo R N --body-file -
gh label create --repo R X --color ... --description ...   # idempotent, on install
gh api graphql -f query='mutation { addSubIssue(...) { ... } }'   # install/import only
```

The first is the whole read. `sub_issues` returns full issue objects, so one
call yields number, title, body, labels and state for every queued entry, in
queue order — no per-issue `gh issue view` fan-out. Phase 0 confirms that
payload shape and that `--paginate` preserves order across page boundaries.

`addSubIssue` is the only write that touches structure, and it runs only from
`just install-issue-queue` and `just import-prompts-to-issues` — never from a
scheduled run.

All of it goes in `backend/queue_source_github.py` — underscores, because
`run-autonomous-work.py` imports it, the same constraint
`autonomous_work_settings.py` lives under. It shells out to `gh` and so stays
stdlib-only; nothing is added to the script's `dependencies = []`.

**The one real unknown is the keychain under launchd.** `gh` stores its token in
the macOS keychain (`gh auth status` reports `keyring`). Whether a LaunchAgent
can read it silently at 2 AM, or whether macOS raises an access prompt, is not
something to reason about — this project has already lost a morning to an
invisible dialog in front of an unattended job. **Phase 0 measures it through
launchd**, the way `just check-folder-access` does, because a probe run from a
terminal would pass regardless and tell us nothing.

The documented fallback, if it fails: a fine-grained PAT scoped to that one
repository in a `0600` file, read by the module and injected as `GH_TOKEN` into
the `gh` environment. Ten lines, and it removes the unknown from the critical
path. Note that a fine-grained PAT needs read/write on Issues only — the
sub-issue endpoints ride the same permission, which is another quiet argument
for this shape over a project board.

## 5. Two sources behind one interface

This is the structural decision the rest of the work hangs off.

`run-autonomous-work.py` touches the queue in six places: `read_queue_lines`,
`parse_queue`, `find_next_todo`, `write_queue_status`, `remaining_todo_prompts`
and `queue_holds_a_todo`. Those become one small protocol with two
implementations:

```python
class QueueSource(Protocol):
    def next_todo(self) -> QueueEntry | None: ...
    def record_outcome(self, entry: QueueEntry, status: str) -> str: ...
    def remaining_todo_prompts(self, already_attempted: list[str]) -> list[str]: ...
    def holds_a_todo(self) -> bool: ...
    def describe(self) -> str: ...          # for the log line and the run event
```

- `FileQueueSource` — today's functions, moved, behaviour unchanged.
- `GitHubIssueQueueSource` — §4's commands, over the parent's sub-issue list.

**`QueueEntry.status_line_index` becomes an opaque `handle`.** A line index for
the file source, an issue number for GitHub. This is the one invasive change and
it is mechanical: the field is read in exactly the places listed above, and
`status_on_line`/`rewrite_status_line` move inside `FileQueueSource` where they
belong, since they are file-shaped concerns that never meant anything to the
rest of the script.

Everything downstream of the queue is untouched. `determine_outcome`,
`queue_status_for_outcome`, `unmerged_branch_after_run` and the summary writer
all keep working in `STATUS_*` strings; `GitHubIssueQueueSource.record_outcome`
translates that string into labels at the boundary. That keeps the `unmerged:`
detail-carrying convention, the session-limit rule and the cancelled rule in one
place rather than duplicated per source.

**Ordering is entirely the source's business.** `next_todo` returns the next
entry and the caller never asks why it was next — line order for the file, list
position for GitHub. No ordering concept leaks into the scheduler, which is what
keeps the two sources from growing a shared "priority" abstraction neither of
them wants.

**Why not mirror issues into `prompts.txt`.** It reintroduces exactly what §1
removes: two copies, a sync direction, and a merge rule. Worse, it makes a stale
mirror indistinguishable from a real queue — the run would happily execute a
prompt the user deleted from GitHub yesterday. The file and the issues are
alternatives, never both live at once.

## 6. What lands on the issue — the part that pays for the whole feature

`PromptRunResult` already carries `result_text` (Claude's own closing message,
from the `result` event, falling back to the last assistant message when a run
was cancelled or wedged) and `unmerged_branch`. Per outcome:

| Outcome         | Labels                     | Comment                                             |
| --------------- | -------------------------- | --------------------------------------------------- |
| `completed`     | close, `+claude:completed` | `result_text`, plus turns and cost                  |
| unmerged branch | `+claude:unmerged`         | `result_text`, the branch name, a compare link      |
| `error`         | `+claude:error`            | `result_text` or the last output, and the exit code |
| `sessionLimit`  | labels unchanged           | none                                                |
| cancelled       | labels unchanged           | none                                                |

Every row also clears `claude:running`. The entry stays attached to the parent
in all five cases — its position is the user's, not the run's.

The last two rows are the existing rule stated in issue terms: those are the
only two outcomes that leave a queue entry's status alone, because the prompt
never really ran. Writing a comment for them would fill the issue with noise
every time a week ran out of window.

**One comment per attempt**, so an issue re-queued three times reads as three
attempts with three accounts. This is what `prompts.txt` structurally could not
do, and it is why the whole feature is worth building rather than syncing a file
somewhere: over breakfast, the parent issue *is* the morning-after summary —
an ordered list with last night's work ticked off the top — and each closed
issue explains itself.

## 7. When GitHub is not reachable

A laptop on a train at 2 AM must fail in the safe direction.

- **The read fails** — no network, `gh` not authed, repository or parent issue
  gone. Log the reason, write the gate's decision as usual, and **exit 0 without
  running anything**. It must never fall back to `prompts.txt`: that file may
  hold work the user deleted from the issue tracker weeks ago, and running it
  would be the one failure that costs work rather than time.
- **The write fails after a prompt has run.** This is the expensive one — an
  unrecorded outcome means the prompt runs again tomorrow. Retry twice with a
  short backoff, then log loudly and put the failure in the day's summary so it
  is visible in the morning. Phase 4 adds a small pending-writes file drained at
  the next run's start, which closes the hole properly; the feature is usable
  without it.

## 8. Settings

Three fields, following the existing mirror path exactly — popup → service
worker → native host → `backend/autonomous-work-settings.json` →
`autonomous_work_settings.py`:

| Setting              | Default | Environment override                  |
| -------------------- | ------- | ------------------------------------- |
| `queue_source`       | `"file"`| `AUTONOMOUS_WORK_QUEUE_SOURCE`        |
| `queue_repository`   | `""`    | `AUTONOMOUS_WORK_QUEUE_REPO`          |
| `queue_parent_issue` | `0`     | `AUTONOMOUS_WORK_QUEUE_PARENT_ISSUE`  |

Plus `AUTONOMOUS_WORK_GH`, defaulting to `gh`, so the tests can point the whole
transport at a stub script — the same trick `AUTONOMOUS_WORK_LAUNCHCTL` already
plays for the scheduling paths.

`queue_source` defaults to `file`, and a `github` source missing either the
repository or the parent issue number falls back to `file` with a logged
warning, so no upgrade path can leave an existing install with no queue at all.

The extension side is the usual four touches: `settingsTypes.ts`, the settings
screen, `syncAutonomousWorkSettings` (which spreads, so it needs no change for
new fields — the reason it spreads), and `parse_settings` in the host.

## 9. Recipes

```sh
just queue-source                     # which source is configured, and is it reachable
just install-issue-queue [owner/repo] # create the labels and the parent issue
just queue-list                       # what the next run would pick up, in order
just import-prompts-to-issues         # one-shot migration of prompts.txt
just probe-gh-under-launchd           # Phase 0 — can the nightly job read the token
```

`install-issue-queue` follows the `install-*` contract: safe to re-run, creates
only what is missing, never appends or accumulates. Re-running it with the parent
issue already present leaves it and its sub-issue order alone.

`import-prompts-to-issues` maps the file's top-down order onto the sub-issue
list directly — section order becomes queue order, `todo`/`error`/`unmerged`
become labels, and `completed` sections are created closed so the history comes
across rather than being dropped.

## 10. Decisions taken

- **The queue is one parent issue's ordered sub-issue list.** §2. This is the
  ordering mechanism, and it was chosen by measurement: sub-issues carry a
  hand-set order readable over plain `repo` scope, where a Projects v2 board
  needs `read:project`.
- **The gate is membership in that list**, not a `claude:todo` label — which is
  what makes a dedicated repo optional. §3.
- **Labels for the non-`todo` statuses, closing for done.** §2.
- **The run reads the order and never writes it.** §2.
- **`gh` as transport, not the REST API directly.** It removes token setup
  entirely for anyone who has used `gh`, at the price of one binary dependency
  and the keychain unknown. The API fallback is a `GH_TOKEN` file, not a rewrite.
- **Two sources, no mirror.** §5.
- **A failed read runs nothing.** §7.

### The one most worth disagreeing with

**`prompts.txt` stays and stays the default**, rather than issues becoming the
only queue. The argument against: two sources is two code paths, two sets of
tests, and a settings field that exists to choose between them — real weight for
a single-user tool. The argument for, which won: the file needs no account, no
network and no third party, it is the thing a fresh clone works with in
`just setup`, and CLAUDE.md's claim that the queue is a hand-editable file is
load-bearing for how the whole project is understood. Reconsider if the issue
source turns out to be what everyone uses.

## 11. Risks and unknowns

- **The keychain under launchd** — §4. Phase 0, before anything else is built.
- **The `sub_issues` payload shape.** The endpoint was probed and answers `200`,
  but against an empty list, so the fields on a populated response are inferred
  rather than seen. Phase 0 confirms body, labels and state are all present, and
  that `--paginate` preserves order across pages — a paginator that re-sorted
  would silently scramble the queue, which is the worst failure this design has.
- **Whether a sub-issue may live in a different repository from its parent** is
  untested. The plan assumes same-repo throughout; if cross-repo works it is a
  bonus (one queue spanning several projects), not something to rely on.
- **GitHub caps sub-issues per parent**, and the number is not worth trusting
  from memory. `just queue-check` reports the count so approaching it is visible
  rather than a surprise `422` at 2 AM.
- **A stranded `claude:running`** after a hard kill. Cleared at the next run's
  start; visible and harmless in the meantime.
- **Issue body formatting.** GitHub's editor will happily wrap a prompt in
  Markdown a text file never had. The body is passed through verbatim; a fenced
  block in a prompt is the user's business, exactly as it is in `prompts.txt`.
- **Rate limits** are not a concern at this volume — a handful of calls per
  prompt against a 5,000/hour budget — but a 403 should be logged as itself
  rather than as a generic failure.
- **`gh` version drift.** `--json` field names and the `sub_issues` route are
  stable but not contractual; `just queue-check` failing loudly is the detector.
- **A public repository** silently publishing a personal task list. Warned at
  configure time and reported by `just queue-check`; not refused.

## 12. Phases

0. **Probe.** `just probe-gh-under-launchd` — can a LaunchAgent run
   `gh api /repos/R/issues/P/sub_issues` against a private repo without a
   dialog, and what exactly does that payload contain? Everything else depends
   on the answer, and the fallback (§4) is cheap if it is no.
1. **The seam.** Extract `QueueSource`, move today's behaviour into
   `FileQueueSource`, replace `status_line_index` with `handle`. No behaviour
   change; the existing tests must pass untouched.
2. **The GitHub source, read-only.** `next_todo`, `holds_a_todo`,
   `remaining_todo_prompts` over the parent's sub-issue list, plus
   `just queue-list` and `just queue-check`. Runnable end to end with write-back
   stubbed to a log line.
3. **Write-back.** Labels, closing, comments (§6). `just install-issue-queue`
   and `just import-prompts-to-issues`.
4. **Settings and resilience.** The three settings through the extension, the
   public-repo warning, and the pending-writes file from §7.

Phases 1 and 2 are independently useful: after 2 you can already see, on a
phone, what tonight will run and in what order.

## 13. Success criteria

- File-source behaviour is byte-identical to today, with the existing tests
  unchanged.
- A prompt filed as an issue from a phone at 11 PM, attached to the queue parent,
  runs at 2 AM, and by morning the issue is closed and carries Claude's account
  of what it did.
- **Dragging a sub-issue to the top of the parent's list changes what runs next,
  with no other action taken anywhere.**
- An issue in a project repository that is not attached to the parent is never
  touched.
- With the network down, the run logs why it did nothing and touches neither
  source.
- `just queue-check` answers "which repository, which parent issue, can I reach
  it, is it private, how many entries are queued" in one screen.
