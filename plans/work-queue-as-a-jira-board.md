# Plan: The work queue as a Jira board

> **Status: built — phases 1 to 5.** Replaces the gist, Google Doc, GitHub
> issues and Obsidian vault designs. See `plans/rejected/` for the two that were
> worked out properly and still lost — the reasoning in both is still
> load-bearing here, and §1 and §8 say which parts of it survive.
>
> Where it landed:
>
> ```
> backend/queue_source.py         the vocabulary, QueueEntry, the protocol, FileQueueSource
> backend/queue_source_jira.py    JiraQueueSource, the credential, the probe, the CLI
> chrome-extension/lib/
>   jiraCredentialWarning.ts      §5.4's escalation, as pure logic
> backend/tests/
>   test_queue_source.py          the file source, against a real file
>   test_queue_source_jira.py     the Jira source, against a stub Jira in-process
> ```
>
> Plus the seam itself in `run-autonomous-work.py` (§8), the daily probe in
> `usage-host.py` (§5.4), the settings on both sides of the mirror (§10), and
> seven `just` recipes (§11).
>
> **What is not built.** **Phase 0** is a measurement against a real Atlassian
> site and so could not be done from here; `just probe-jira-adf` is its
> deliverable and it exists — run it once against your own site before trusting
> §4's flattening with a long prompt. **Phase 6** (MCP inside the run) depends on
> Phase 0's answer about the headless auth path, is explicitly optional, and
> nothing in phases 1–5 needs it.
>
> **Sections below are left as they were designed.** Where the build departed
> from the design, or settled something the design left open, the section says so
> in an indented note and gives the reason. §12 collects the four decisions the
> build itself made, and §13 marks which risks are now closed.

## Goal

`prompts.txt` lives at the repository root on one Mac. Adding a prompt to the
queue, reordering it, or reading what last night's run did all mean being at
that Mac — the wrong constraint for a queue whose entire purpose is to be
worked through while you are asleep or elsewhere.

Move the queue onto a **Jira board**: five columns — Draft, To Do, In Progress,
In Review, Done — in a project the app can create for you, named
**Free Claude Prompts**. The run reads the To Do column top-down, moves the card
it is working on, and writes Claude's own account of what it did back onto the
card.

Non-goals: mirroring Jira into `prompts.txt` or back (§8 explains why that is
the one design that must not be built); Jira Data Center or Server; a Forge or
Connect app; webhooks or anything that listens; Confluence; MCP as the
scheduler's transport (§6 is the whole argument, and where MCP _does_ belong);
the run ever _changing_ the rank (it reads the order, it never writes it);
multi-user workflows — this is one person's queue that happens to live in a
multi-user tool.

## 1. Why Jira, when a plain file already beat two alternatives

The file won its last two arguments on one property, and it is worth naming
precisely, because Jira is the first alternative that does not lose on it:

> **Reordering the queue is a direct-manipulation gesture, not an edit.**

In `prompts.txt` that is cut-and-paste in a text editor. GitHub issues lost
partly because issue-number order is creation order and the sub-issue workaround
was clunky. The Obsidian vault won by keeping the file and moving it — and then
inherited a markdown editor that renders `===` as a heading, a CSS snippet, an
ignore rule per sync tool, a conflict window with no merge, and an eviction
failure mode that looks exactly like an empty queue.

**Jira's data model is a ranked queue.** LexoRank is a first-class field, drag
is the primary gesture for it in every Jira client including both mobile apps,
and `ORDER BY Rank ASC` is a documented sort. Where the previous three designs
had to reconstruct ordering out of something that was not built for it, here it
is the thing the product is for.

Four more properties come free, and three of them are things earlier plans
listed as costs:

- **No sync, no merge, no conflict window.** Jira holds the only copy. §9 of the
  Obsidian plan accepted a nightly conflict window it could not close; there is
  nothing here to close.
- **Status is a column, and moving between them is a drag.** Re-queueing a
  failed prompt is dragging a card from In Review back to To Do. Today it is
  editing a `STATUS:` line in a text file.
- **The line-index fragility disappears entirely.** `status_line_index`,
  `status_on_line`'s "is this still a STATUS line" guard, and the whole
  "queue edited mid-run" hazard exist because the file addresses an entry by
  position. An issue key is a stable identity that survives any edit, including
  a reorder.
- **Push notifications, for free.** The Jira mobile app can notify you when a
  card reaches Done or In Review. The GitHub plan called "somewhere to read the
  account of what happened" its real prize and the Obsidian plan got it by
  putting `summaries/` in the vault; Jira gets it _and_ tells you it is there.

The honest costs, stated up front rather than buried in §13:

- **A card needs a summary.** This was named as a con of the issues design and
  it is no less true here. §3 mitigates it: a card with an empty description
  uses its summary _as_ the prompt, so a one-line prompt needs one field, not two.
- **A third-party account and a network dependency**, where a file needed
  neither. This is why §8 keeps the file source rather than replacing it.
- **Credentials that expire.** §5 is the longest section in this plan for that
  reason.

## 2. Terminology: it is a Jira _project_

Jira does not have spaces — Confluence does. The container this plan creates is
a **project**, of type _Jira Software_, team-managed, with a Kanban board. Its
name is `Free Claude Prompts` and its key defaults to `FCP`.

Team-managed rather than company-managed is a deliberate choice and it matters
for §7: in a team-managed project **the board's columns _are_ its statuses**, so
"add a column" and "add a status" are one gesture with no workflow scheme, no
issue-type scheme and no screen scheme in between. A company-managed project
would need all three configured before the five columns in the goal existed.

> **As revised — see `plans/company-managed-jira-project.md`.** Two follow-on
> requirements — a default work type lever, and a screen a custom field can
> attach to — both turned out to need exactly the scheme machinery team-managed
> was chosen to avoid, and neither is reachable on a team-managed project over
> the public API. The later plan measured what configuring that machinery
> actually costs (§0) and found it scriptable end to end, at the price this
> paragraph predicted — paid once, in code, not per-user. `install-jira-queue`
> now creates a company-managed project.

The **Free** plan of Jira Cloud covers this comfortably — one user, unlimited
projects, no card. Nothing in this plan needs a paid tier.

## 3. The mapping

| `prompts.txt`            | Jira                                                          |
| ------------------------ | ------------------------------------------------------------- |
| the file, read top-down  | the To Do column, `ORDER BY Rank ASC`                         |
| position in the file     | rank — dragged on the board                                   |
| `STATUS: draft`          | the **Draft** column                                          |
| `STATUS: todo`           | the **To Do** column                                          |
| (running, no equivalent) | the **In Progress** column                                    |
| `STATUS: unmerged:<b>`   | **In Review**, label `claude-unmerged`, branch in a comment   |
| `STATUS: error`          | **In Review**, label `claude-error`, the failure in a comment |
| `STATUS: completed`      | the **Done** column                                           |
| `REPO: ~/code/x`         | a `REPO:` line at the top of the description — unchanged      |
| the prompt body          | the rest of the description                                   |
| (nothing)                | the summary — free text, for scanning the board on a phone    |

**The prompt is the description, or the summary when the description is empty.**
Jira forces a summary and this is what stops that from being double entry. A
prompt you can state in a sentence is one field on a phone; a long one gets a
title worth having on a card.

**In Review holds both endings that need a human**, told apart by a label. The
column means _your turn_, and both an unmerged branch and a failed prompt mean
exactly that. It is also what keeps the user's five columns intact rather than
growing a sixth for failures. §12 records the argument against.

**Picking a card up clears both labels**, so re-queueing is a drag and nothing
else. This is the one place the run writes something the user could have written
themselves, and it exists so that the gesture stays single.

**The `:detail` convention does not cross the boundary.** `unmerged:<branch>`
exists because a text file has one field to carry both the status and the branch
name. Jira has columns, labels _and_ comments, so `JiraQueueSource.record_outcome`
splits the string at §8's boundary: the status name picks the column, the detail
goes in the comment. Nothing downstream of the queue changes, and no `:detail`
parsing exists on the Jira side at all.

> **As built**, the split is in `plan_write`, which turns a status and a report
> into an `OutcomeWrite` — column, labels, comment — without touching the
> network. That is what makes §9's whole table testable as data, and it is the
> same object §5.5 writes to disk when a write cannot land.

**A card in In Progress at the start of a run is stale, by definition** — launchd
will not run two instances of one label, so no second run can be in flight. The
run sweeps any such card back to To Do before it starts. The SIGTERM handler that
already writes a cancelled session's summary does the same on the way out; the
sweep is the backstop for a hard kill, and it is the same reasoning the rejected
issues plan applied to its `claude:running` label.

**Status names are discovered, not hard-coded.** `GET /rest/api/3/project/{key}/statuses`
gives the project's statuses; the five are matched by name, case-insensitively,
with per-column overrides in settings for anyone who renames a column. A missing
status is reported by `just jira-status` rather than discovered at 2 AM.

> **As built**, resolution is lazy and cached per source, and a missing column is
> logged once rather than raised — a board with no Draft column still runs its
> To Do queue perfectly well. It is `_transition` that fails, and only for the
> column that is actually missing. That laziness is also what made
> `WRITE_FAILURES` necessary; see §5.5.

## 4. Reading the queue

One call per pick-up:

```
GET /rest/api/3/search/jql
    ?jql=project = "FCP" AND status = "To Do" ORDER BY Rank ASC
    &fields=summary,description,labels,status
    &maxResults=50
```

Note `/search/jql` rather than `/search` — the older endpoint is deprecated on
Cloud. Confirm the exact path and its pagination shape in Phase 0 rather than
trusting this line; a paginator that re-sorted would silently scramble the
queue, which is the worst failure this design has.

> **As built: one page, and no paginator at all.** The risk above is real and the
> cheapest way to be rid of it is not to write the thing that carries it. Fifty
> cards is far more queue than anyone has, the run only ever wants the _first_
> one, and `remaining_todo_prompts` is a line in a summary rather than a
> decision. If a board ever outgrows one page, the fix is a paginator with a test
> that asserts rank order across the seam — not a paginator added quietly now.

**The description is ADF, and this is the detail most likely to cost a morning.**
The v3 API returns a card's description as Atlassian Document Format — a JSON
document tree, not text. Dropped naively into `build_prompt` it would hand
Claude a blob of JSON.

The saving grace is that **the run only ever reads descriptions and never writes
them**, so this is a one-way conversion and not a round trip. A small flattener —
walk the tree, concatenate `text` nodes, `paragraph` and `heading` become blank-
line-separated blocks, `codeBlock` keeps its content verbatim, `hardBreak` a
newline — is enough, and it cannot corrupt anything because nothing is written
back. Phase 0 measures it against a prompt containing backticks, asterisks,
underscores, a `~/code/some_path` and a fenced block, since those are what a real
prompt contains and what a document model is most likely to reshape.

The v2 API (`/rest/api/2/`) returns wiki markup instead and is the fallback if
the flattener turns out to be lossy. It is the fallback rather than the default
precisely because it is a _conversion_ of the stored ADF and so has its own
lossiness, in the same places.

> **As built.** `flatten_adf` handles `text`, `hardBreak`, `codeBlock`,
> `mention`, `emoji`, `rule` and seven block types, and passes a plain string
> through unchanged so a v2 response needs no special casing at the call site.
> It is covered against backticks, asterisks, underscores, a path and a fenced
> block — but against documents _this repo built_, which is not the same test as
> against documents Jira built out of something a person typed. That is what
> `just probe-jira-adf` is still owed for.

## 5. Authentication — the concern that shapes everything else

Two things must be true: the job must not fail at 2 AM because a credential
quietly expired, and setting it up must not require a developer console tour.
These pull against each other, and the two candidates land on opposite sides.

### 5.1 The two options, measured

**Atlassian API token (HTTP Basic: email + token).**
Created at `id.atlassian.com/manage-profile/security/api-tokens`. Three clicks,
one paste. No app registration, no callback URL, no consent screen, no secret.

The catch is a hard one, and it is policy rather than configuration: since
December 2024 **every new API token carries a mandatory expiry of at most one
year**, and Atlassian retro-fitted expiry onto older tokens through 2026. There
is no indefinite token, and requests for one have been declined. So this scheme
has an annual cliff that cannot be engineered away.

**OAuth 2.0 (3LO).**
Access tokens last an hour; refresh tokens **rotate** — each use returns a new
one valid 90 days — and the grant survives indefinitely provided it is exercised
inside a 90-day window and the user stays active within a year. So OAuth has
**no cliff**, which is exactly what the concern asks for.

It costs more in four places:

1. **Setup is an app registration.** developer.atlassian.com → create app → add
   Jira platform REST scopes → set a callback URL → copy a client id and secret.
   Six clicks and two pastes rather than three clicks and one.
2. **The client secret cannot be shipped.** A Web Store extension is not a
   confidential client, so the user must register their _own_ app and paste
   their own id and secret — which puts the setup burden back near the API
   token's, just doubled.
3. **Rotation is a race, and this codebase has exactly the wrong shape for it.**
   Chrome spawns a **separate native host process per connection**, and the
   launchd run is a third process. Two of them refreshing at once means one wins
   and the other's refresh token is dead — the "unknown or invalid refresh
   token" failure people hit in the wild. It is fixable with a lock file around
   the refresh, but it is a new failure mode invented to solve a scheduling one.
4. **A consent grant can be revoked** from the user's Atlassian account, at any
   moment, with no notice. Unlike an expiry, that is not a date anyone can warn
   about in advance.

### 5.2 The recommendation, and the argument for it

**Ship the API token. Design the credential behind an interface so OAuth can be
added later without touching anything else.**

The reasoning turns on a distinction the concern itself makes — _"either
automatically, or the user needs a good warning system"_:

> An API token's expiry is a **scheduled event with a date known at creation
> time**. OAuth's failure modes are **unscheduled**.

A failure you are told about thirty days ahead is not "failing in the middle of
the night"; it is a calendar reminder. Whereas OAuth trades that annual, warnable
event for a rotation race and a revocable grant, neither of which announces
itself. For a single-user tool the token's cliff is the cheaper risk, provided
§5.4 is actually built — and §5.4 is needed under OAuth too, because a revoked
grant needs the same alarm.

Reconsider if annual rotation turns out to be more annoying in practice than it
reads here. §8's interface is what keeps that a contained change.

### 5.3 Where the credential lives — the one deliberate break with the settings pattern

Every other setting travels popup → service worker → native host →
`backend/autonomous-work-settings.json`. **The Jira credential does not**, for
two reasons: that file is a plaintext mirror the host rewrites and logs around,
and a credential has no business sitting in `chrome.storage` at all.

Instead:

```sh
just set-jira-credentials     # prompts in the terminal, writes 0600
```

writing `backend/jira-credentials.json`, mode `0600`, gitignored:

```json
{
  "siteUrl": "https://example.atlassian.net",
  "email": "…",
  "apiToken": "…",
  "tokenExpiresAt": "2027-08-28"
}
```

Consequences worth stating:

- **The token is never logged.** The host's convention of logging arriving _key_
  names rather than values is already the right one and needs no change; the
  credential simply never arrives over that wire.
- **The popup shows status, never the secret** — valid / expires in N days /
  last checked at — fetched from the host by a new `getJiraStatus` message.
- **The mode is set before the token is in the file, not after.**
  `write_credentials` uses `mkstemp` plus `fchmod`, then renames over the
  target — so there is no window, however short, in which the token sits
  world-readable waiting for a `chmod`.
- **`0600` rather than the Keychain**, deliberately. The rejected issues plan
  flagged "can a LaunchAgent read the Keychain at 2 AM without a dialog" as an
  unmeasured unknown, and this project has already lost a morning to an
  invisible dialog in front of an unattended job. A file mode removes the
  unknown instead of measuring it.
- **`tokenExpiresAt` is recorded at paste time**, because the expiry is not
  readable back from any API — the user picks the date in the Atlassian UI and
  types it in. If Phase 0 finds an endpoint that reports it, this field becomes
  a cache rather than a source.

### 5.4 The warning system — the actual deliverable of this section

The load-bearing insight is about _whose clock_ drives the check:

> **The run is the wrong thing to discover a broken credential.** It fires at
> 2 AM, and only when the week is behind pace — which may be never for a
> fortnight. The extension refreshes every five minutes whenever Chrome is open.
> That is the reliable clock, and it is one you are awake for.

So the native host, already spawned every five minutes to write the usage
snapshot, does a **throttled daily probe** — `GET /rest/api/3/myself`, one call,
cheap — and records the result in `backend/jira-status.json`. Escalating from
there:

| When                        | Where it shows                                              |
| --------------------------- | ----------------------------------------------------------- |
| 30 days before expiry       | a line in the popup's Settings screen                       |
| 14 days                     | a banner on the popup's main view                           |
| 7 days, or any failed probe | the **toolbar badge**, the thing you look at all day anyway |
| expired, or a 401           | badge, plus the run refuses to start and says why           |

The badge is the point. This extension's whole premise is that a number in the
toolbar changes behaviour; a credential about to expire belongs in the same
place. It also catches everything the recorded date cannot: a revoked token, a
changed site URL, a Jira project deleted, a network that has been down for a week.

**A failed probe is reported with its cause**, not as a generic failure — 401
(bad or expired credential), 403 (permission lost on the project), 404 (project
gone), and a connection error (which means nothing at all and must not raise an
alarm, since a laptop is offline most nights it is shut).

> **As built, with one row of that table changed.** The recorded expiry
> **warns** at 2 AM and never **blocks**. The date is typed in by hand and cannot
> be read back from any API, so a mistyped one — 2026 for 2027, a transposed
> month — would refuse to run against a token that works perfectly, which is a
> strictly worse failure than the one it was guarding against. Jira's own 401 is
> what stops a run, it arrives through the ordinary `QueueUnavailable` path, and
> it is never wrong about it. So the run logs "expires in N days" from 30 days
> out and otherwise gets on with it.
>
> The other three rows are as designed, in `deriveJiraCredentialWarning`, which
> is pure and takes the queue source as an argument: none of this applies to an
> install queuing its work in a file, where a stale credential is a fact about
> nothing.
>
> Two implementation details worth knowing before touching it. The probe is
> **synchronous, on the host's message loop**, which is only defensible because
> `probe_is_due` throttles it to once a day — 287 of every 288 snapshots pay
> nothing. A background thread is the obvious alternative and is wrong: Chrome
> tears the host down the moment it has the reply to a `sendNativeMessage`, so
> the thread would be killed part way through. And the probe runs **after** the
> snapshot is written, so the file the scheduler reads never waits on Atlassian.

### 5.5 What happens if it fails at 2 AM anyway

The safe direction is _do nothing, loudly_:

- **The read fails** — expired token, no network, project gone. Log the cause,
  write the gate's decision as usual, and **exit 0 having run nothing**. It must
  never fall back to `prompts.txt`: that file may hold work deleted from the
  board weeks ago, and running it is the one failure that costs work rather than
  time.
- **The write fails after a prompt has run.** The expensive one — an unrecorded
  outcome means the prompt runs again tomorrow. Retry twice with a short backoff,
  then log loudly, put it in the day's summary, and append to a pending-writes
  file drained at the next run's start. The feature is usable before that file
  exists; it is Phase 5.

> **As built**, in `backend/jira-pending-writes.jsonl`, and `OutcomeWrite` is a
> serialisable plan for exactly this reason — the same object is applied,
> retried, written to disk and replayed. The one thing this needed that the plan
> did not say: **every write path catches `QueueUnavailable` as well as
> `JiraError`**. Resolving the project's statuses is itself a call and is made
> lazily, so the first thing a write does can be the thing that discovers Jira is
> gone — and that arrives as the _read_ error, not the write one. A write path
> that let it through would take the run down at the exact moment it was trying
> to be careful with an outcome. `WRITE_FAILURES` is that tuple, and there is a
> test that shuts the stub server's socket mid-run to prove it.

## 6. Where MCP fits — and where it does not

Atlassian's official **Remote MCP Server** went GA in February 2026, with Claude
as its first partner. It exposes Jira read, write and search to any MCP client
over `https://mcp.atlassian.com/v1/mcp/authv2`. It is the obvious thing to reach
for here, and it is worth being precise about which of this plan's three jobs it
can actually do, because the answer is different for each.

### 6.1 As the scheduler's queue transport — no

Replacing §4's search and §9's transitions with MCP tool calls fails on four
counts, and the first is decisive:

1. **MCP is a protocol for giving a _model_ tools. The scheduler is not a
   model.** Picking the top-ranked To Do card is a deterministic query with one
   right answer. Routing it through a tool call means either running an LLM to
   read the queue — absurd, and it would spend the very budget this project
   exists to pace — or hand-rolling an MCP client to call one tool, which is a
   worse REST client with extra framing.
2. **It breaks the stdlib-only rule, in the one place that rule is hardest.**
   `usage-host.py` needs the credential half of this module for §5.4's probe, and
   **Chrome spawns the host with an environment we do not control** — that is why
   the host depends on nothing. An MCP SDK is a dependency that would fail in
   ways near-undebuggable from inside a browser. `urllib.request` is already in
   the box.
3. **Tool output is shaped for a model, not for a parser.** Its wording and
   structure are free to change between server versions in a way a REST response
   shape is not. The queue's control plane should not be reading prose.
4. **`just autonomous-dry-run` spawns no `claude` process at all**, deliberately —
   asking what would happen must not disturb the record of what did. Under
   MCP-as-transport it would have to.

So §4 and §9 stay on REST. This is not a close call.

### 6.2 As the auth answer — no, and this is worth stating plainly

MCP looks like it might dissolve §5's whole problem, since Claude Code manages
its own MCP credentials. It does not. It **inherits the same problem and adds a
step**:

- The default path is a **browser-based OAuth 2.1 flow**. There is no browser at
  2 AM under launchd, and Claude Code's support for OAuth against HTTP MCP
  servers has open issues.
- The headless alternative is **an Atlassian API token** — the same credential
  §5 already chose, with the same mandatory annual expiry — _plus_ an
  administrator toggle in Atlassian Administration (Rovo → MCP server →
  Authentication) that has to be found and enabled first.

So MCP costs a setup step and buys nothing on longevity. §5.2's recommendation
stands unchanged, and §5.4's warning system is required either way.

### 6.3 Inside the run, as a tool for Claude — yes, and this is the good one

The place MCP earns its keep is the one place there _is_ a model:
`claude -p --mcp-config`, giving the running prompt the Atlassian tools. That
buys two things a description field cannot:

- **Context the queue does not carry.** The card's comments, its attachments,
  linked cards, a screenshot someone dropped on it from a phone. Today all a
  prompt gets is the text of the description.
- **Progress visible where the work is.** A long prompt can comment on its own
  card as it goes, so a two-hour run is watchable in Jira rather than only in
  `autonomous-work.log` on the Mac.

**With one rule, which is the whole of the design here:**

> **The prompt may read its card and comment on it. It must never transition
> it.**

The scheduler owns the queue's state machine — that is the point of §8's
`QueueSource` and of `write_queue_status`'s existing care about who may write a
status. A model holding a `transitionIssue` tool can move its own card to Done,
and would eventually do it while reasoning about the board rather than intending
to. The same argument as §9's table: a card reaches Done because
`determine_outcome` said so, never because the work felt finished.

Enforced by **restricting the tool set** in the MCP config to read, search and
comment — not by asking the prompt nicely in `appendToAllPrompts`. A convention
the model has to remember is a convention that holds until the night it does
not, which is the same reasoning that made `unmerged_branch_after_run` read git
rather than take the run's word for it.

This is genuinely optional, and it is Phase 6 for two reasons: it depends on the
headless auth path in §6.2 that may not be enabled on a given site, and every
part of the queue works without it. Build it after the board works, not as part
of making it work.

## 7. Creating the project automatically

`just install-jira-queue` follows the `install-*` contract exactly — safe to
re-run at any point, creates only what is missing, never appends or accumulates:

1. Prompt for site URL, email, API token and the expiry date the user chose;
   write §5.3's `0600` file.
2. `GET /rest/api/3/myself` — confirms the credential and yields an `accountId`.
3. Look for a project named **Free Claude Prompts**. If it exists, leave it and
   its board entirely alone.
4. If not, `POST /rest/api/3/project` with
   `projectTypeKey: "software"`,
   `projectTemplateKey: "com.pyxis.greenhopper.jira:gh-simplified-agility-kanban"`,
   `leadAccountId` from step 2, key `FCP`.
5. Resolve the project's statuses and record which ones are missing.
6. Write the project key and status mapping into the settings mirror.
7. Print the board URL, and the steps a human has to click.

**Step 7 is not a shortcut, and the plan should not pretend otherwise.** The
team-managed template creates three columns — To Do, In Progress, Done. Adding
**Draft** and **In Review** is board configuration, and Jira Cloud exposes no
documented REST route for it. In a team-managed project it is two clicks each
(board → **+** → name the column, which creates the status), so the recipe ends
by printing exactly that — the same way `just setup` ends by printing the one
thing it cannot do, loading the unpacked extension at `chrome://extensions`.

Phase 0 probes whether the internal team-managed board API can do it. If it can,
step 7 shrinks; if it cannot, two clicks once per install is a fair price and
the recipe **verifies** afterwards rather than assuming, which is what step 5 and
`just jira-status` are for.

> **As built**, and it does verify: step 5 runs and step 7 prints only the
> columns actually missing, by name, or says all five are present. A 403 on
> project creation is caught and reported as the permission it is, with the
> `just install-jira-queue MYKEY` escape hatch named in the same breath.
>
> **The board-column question is now measured rather than assumed**, against a
> real team-managed project, and the answer is more interesting than "no API":
>
> | Attempt                                                      | Result                                                                                      |
> | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
> | `POST /rest/api/3/statuses`, scoped to the project           | **Works.** Creates the status.                                                              |
> | `GET /rest/api/3/project/{key}/statuses` afterwards          | Does _not_ list it — a status outside the workflow is not a column.                         |
> | `PUT /rest/greenhopper/1.0/rapidviewconfig/columns`          | **500** on a simplified board, both with an empty column and with the new status mapped in. |
> | `GET /rest/api/3/workflows/search?expand=values.transitions` | **Works**, and finds the project's own workflow, `isEditable: true`.                        |
> | `POST /rest/api/3/workflows/update/validation`               | **400**, "invalid request payload", on three guessed body shapes.                           |
>
> So the chain is _create status → add it to the workflow → it becomes a
> column_, the first link works over the public API and the last one is a
> consequence, and only the middle link is missing. It is missing for want of a
> payload schema rather than for want of an endpoint — `workflows/update` exists,
> the workflow is editable, and the project is admin-able. **That is a much
> better place to start from than this plan assumed**, and anyone picking it up
> should read the bulk-update schema properly rather than guess at it, as was
> done here.
>
> The one thing to know before trying: a status created and then left out of the
> workflow is invisible on the board and has to be deleted with
> `DELETE /rest/api/3/statuses?id=…`, or it will collide by name with the one the
> UI creates when somebody adds the column by hand.

> **As revised — see `plans/company-managed-jira-project.md` §0.4.** The
> `workflows/update` schema this section left as future work is now fully
> known — read from the raw OpenAPI spec rather than guessed at a second time
> — and step 7's printed manual step is **gone**: both the workflow-status
> addition and `rapidviewconfig/columns` (on the *classic* board a
> company-managed project gets — this section's `500` was on a simplified
> team-managed one) now work over the API with nothing printed but "point the
> extension at the board".

**Creating a project needs Administer Jira permission**, which the owner of a
free site has by definition. A user pointed at somebody else's Jira will fail
here with a clear message and can instead name an existing project in settings —
`install-jira-queue` takes an optional project key for exactly that case.

## 8. Two sources behind one interface

**This is the one part of the rejected GitHub issues plan that survives intact**,
because it was always a source-agnostic piece of design and the source it was
written for is not the point of it.

`run-autonomous-work.py` touches the queue in six places: `read_queue_lines`,
`parse_queue`, `find_next_todo`, `write_queue_status`, `remaining_todo_prompts`
and `queue_holds_a_todo`. Those become one small protocol with two
implementations:

```python
class QueueSource(Protocol):
    def next_todo(self) -> QueueEntry | None: ...            # raises QueueUnavailable
    def start(self, entry: QueueEntry) -> None: ...          # → In Progress
    def abandon(self, entry: QueueEntry) -> None: ...        # the inverse of start
    def record_outcome(self, entry, status: str, report=None) -> str: ...
    def remaining_todo_prompts(self, already_attempted: list[str]) -> list[str]: ...
    def holds_a_todo(self) -> bool: ...
    def sweep_stale(self) -> None: ...                       # §3's In Progress sweep
    def drain_pending_writes(self) -> int: ...               # §5.5's held-over outcomes
    def describe(self) -> str: ...                           # for the log and the run event
```

Three of those were not in the first draft of this section, and each was forced
by something the rest of the plan already required:

- **`abandon`** is `start`'s inverse, and §9's table is what needs it: "back to
  To Do is not a status change — it is the undoing of `start()`". The obvious
  shortcut is to call `record_outcome(entry, STATUS_TODO)` from the cancellation
  handler, and it is wrong, because that would have the _file_ source rewrite a
  STATUS line it has deliberately left alone since the day it was written. A
  cancelled prompt must leave the queue exactly as it found it, and only a method
  that means "undo the pick-up" can promise that for both sources.
- **`report`** carries Claude's closing message, turns and cost. §9's comment
  cannot be written without them, and one object rather than five arguments is
  what lets the file source go on ignoring it as more is added. It ignores it
  because a STATUS line is one field and it is already spoken for; the day's
  summary is where that account goes for a file queue.
- **`drain_pending_writes`** is §5.5's replay. It is on the protocol rather than
  duck-typed onto the Jira source alone, so the scheduler has one call shape and
  no `getattr`; the file source returns 0, because its write is a local atomic
  swap and nothing can ever be owed.

**`QueueUnavailable` is the other addition**, and it is the load-bearing one. It
is raised, never returned, precisely so that "I could not read the queue" cannot
be quietly mistaken for "there is nothing to do" by a caller that forgot to
check — the mistake §5.5 exists to prevent. It reaches the run-event stream as
`queueUnavailable` rather than `emptyQueue`, and the run-log window has a label
for it.

- `FileQueueSource` — today's functions, moved, behaviour unchanged.
- `JiraQueueSource` — §4's read, §3's transitions, §9's comments.

**`QueueEntry.status_line_index` becomes an opaque `handle`** — a line index for
the file source, an issue key for Jira. This is the one invasive change and it is
mechanical: the field is read only in the places listed above, and
`status_on_line` / `rewrite_status_line` move _inside_ `FileQueueSource` where
they belong, being file-shaped concerns that never meant anything to the rest of
the script.

> **As built, and the one place the "existing tests pass untouched" goal could
> not hold.** Renaming a field renames it in the tests that construct one, so
> `status_line_index=` became `handle=` there too, and the five
> `write_queue_status` tests now go through `work.record_outcome` — the same
> object `main` writes through. That is a better test than the one it replaced,
> since it exercises the wiring rather than a function the scheduler no longer
> calls. Everything else in those 227 tests is untouched and passes.
>
> The file source also gained a suite of its own, `test_queue_source.py`, which
> is where the "no behaviour change" claim is actually guarded: the parser, the
> status vocabulary and the in-place STATUS rewrite, exercised against a real
> file with no scheduler around them.

Everything downstream is untouched. `determine_outcome`,
`queue_status_for_outcome`, `unmerged_branch_after_run` and the summary writer
keep working in `STATUS_*` strings; `JiraQueueSource.record_outcome` translates
at the boundary. That keeps the session-limit rule, the cancelled rule and the
unmerged rule in one place rather than duplicated per source.

`start()` is new, and is the only addition to the protocol the file source does
not want — it is a no-op there, since a file has no "running" state and the
existing design deliberately leaves the status alone until the outcome is known.

**Ordering is entirely the source's business.** `next_todo` returns the next
entry and the caller never asks why it was next — line order for the file, rank
for Jira. No ordering concept leaks into the scheduler.

**`prompts.txt` stays, and stays the default for a fresh clone.** Nothing about
`just setup` changes and nobody is required to have an Atlassian account to use
the scheduler. The argument against — two code paths and two test suites for a
single-user tool — is real, and §12 records it.

**Never mirror Jira into the file.** It reintroduces exactly what §1 removes:
two copies, a sync direction, and a merge rule — and worse, it makes a stale
mirror indistinguishable from a real queue, so the run would happily execute a
prompt deleted from the board yesterday. The two sources are alternatives, never
both live.

The module is `backend/queue_source_jira.py` — underscores, because
`run-autonomous-work.py` imports it, the same constraint
`autonomous_work_settings.py` lives under. It talks HTTPS through
`urllib.request` and so stays **stdlib-only and 3.9-compatible**, inheriting the
host's constraints because the host imports the credential half of it for §5.4's
probe. Nothing is added to any script's `dependencies = []`.

## 9. What lands on the card

`PromptRunResult` already carries `result_text` — Claude's own closing message
from the `result` event, falling back to the last assistant message when a run
was cancelled or wedged — and `unmerged_branch`. Per outcome:

| Outcome         | Column        | Labels             | Comment                                     |
| --------------- | ------------- | ------------------ | ------------------------------------------- |
| `completed`     | Done          | —                  | `result_text`, plus turns and cost          |
| unmerged branch | In Review     | `+claude-unmerged` | `result_text`, the branch, the repo path    |
| `error`         | In Review     | `+claude-error`    | `result_text` or last output, and exit code |
| `sessionLimit`  | back to To Do | unchanged          | none                                        |
| cancelled       | back to To Do | unchanged          | none                                        |

The last two rows are the existing rule restated in board terms: those are the
only two outcomes that leave a queue entry's status alone, because the prompt
never really ran. A comment for them would fill the card with noise every time a
week ran out of window. "Back to To Do" is not a status change — it is the
undoing of §8's `start()`, returning the card to where it was.

> **As built, those two rows reach the board by different routes**, which is
> worth knowing when reading the code. A **session limit** is an outcome like any
> other: it comes back through `record_outcome` with `STATUS_TODO`, which maps to
> the To Do column, clears both labels and writes no comment. A **cancellation**
> never reaches that code at all — the SIGTERM handler records the run and calls
> `os._exit`, so it calls §8's `abandon` directly, best-effort, with the sweep at
> the next run's start as the backstop if even that does not land.

**One comment per attempt**, so a card re-queued three times reads as three
attempts with three accounts. This is what `prompts.txt` structurally cannot do,
and with §1's push notifications it is the payoff that justifies the whole
feature: over breakfast the board _is_ the morning-after summary — last night's
work sitting in Done, anything needing you in In Review — and each card explains
itself.

`summaries/YYYY-MM-DD.md` keeps being written exactly as it is. It is the
session-level account; the card comments are the prompt-level one, and neither
replaces the other.

## 10. Settings

Following the existing mirror path — popup → service worker → native host →
`backend/autonomous-work-settings.json` → `autonomous_work_settings.py`.
**Credentials do not travel this path (§5.3); these are the non-secret half.**

| Setting           | Default  | Environment override           |
| ----------------- | -------- | ------------------------------ |
| `queueSource`     | `"file"` | `AUTONOMOUS_WORK_QUEUE_SOURCE` |
| `jiraProjectKey`  | `""`     | `AUTONOMOUS_WORK_JIRA_PROJECT` |
| `jiraStatusNames` | the five | —                              |

Plus `AUTONOMOUS_WORK_JIRA_BASE_URL`, so the tests can point the whole transport
at a local stub — the same trick `AUTONOMOUS_WORK_LAUNCHCTL` already plays for
the scheduling paths, and the reason the unit tests can exercise every transition
without an Atlassian account.

`queueSource` defaults to `file`, and a `jira` source missing its project key or
credential file **falls back to `file` with a logged warning**, so no upgrade
path can leave an existing install with no queue at all.

> **As built, with one papercut that could not be designed away.**
> `just install-jira-queue` writes `queueSource: jira` into the mirror so the
> scheduler works the moment it finishes — but the extension _owns_ that field
> and rewrites the whole mirror on its next save, which would put it back to
> `file`. The two cannot both be the owner. The recipe therefore ends by saying
> so and telling you to set Queue source in the popup's Settings screen as well;
> `AUTONOMOUS_WORK_QUEUE_SOURCE` is the way out for a machine with no extension
> running at all. Worth revisiting if it bites: the alternative is to have the
> host merge rather than replace, which trades this for the version-skew failure
> the "log the arriving keys" convention exists to catch.

The extension side is the usual four touches: `lib/settingsTypes.ts`,
`components/SettingsPage.tsx`, `syncAutonomousWorkSettings` — which spreads, so
it needs no change for new fields, the reason it spreads — and `parse_settings`
in `usage-host.py`, one more key in the arriving key list.

> **As built, `jiraStatusNames` got a UI after all.** The plan lists it as a
> mirrored setting, and a mirrored setting the extension does not own is a
> mirrored setting the extension silently blanks on every save. So Settings has
> five text inputs behind a collapsed "Renamed columns", shown only for the Jira
> source, each placeholdered with the name the board is created with. A blank
> field is _removed_ rather than stored as `""` — an empty string is not a
> rename, and storing one would send the run looking for a column called "".

## 11. Recipes

```sh
just install-jira-queue [PROJECTKEY]  # credential, project, statuses, board URL
just set-jira-credentials             # rotate the token without touching anything else
just jira-status                      # site, project, credential, days to expiry, column health
just queue-source                     # which source is configured, and is it reachable
just queue-list                       # what the next run would pick up, in rank order
just import-prompts-to-jira           # one-shot migration of prompts.txt
just probe-jira-adf                   # Phase 0 — what a real prompt survives as
```

`just jira-status` is the one that matters day to day, and it answers in one
screen: which site, which project, is the credential valid, how many days until
it expires, do all five statuses exist, how many cards are in To Do, and when the
last probe ran.

`import-prompts-to-jira` maps the file's top-down order onto rank directly —
section order becomes board order, and `completed` sections are created in Done
so the history comes across rather than being dropped. It **asks before creating
anything**, prints each card as it goes, and **leaves `prompts.txt` alone** —
deleting the file you just migrated is your call, made once you have looked at
the board, not the migration's.

## 12. Decisions taken

- **A Jira board, over a file in a synced folder.** §1 — rank is a first-class
  draggable field, which is the one property every previous design had to
  reconstruct.
- **A team-managed Jira Software project**, because there the columns _are_ the
  statuses. §2.
- **The prompt is the description, or the summary when the description is
  empty.** §3 — this is what stops a forced title from being double entry.
- **In Review holds both unmerged work and failures**, told apart by a label. §3.
- **Status names are discovered, not hard-coded.** §3.
- **An API token, not OAuth**, because an annual expiry with a known date is a
  warnable event and OAuth's failure modes are not. §5.2.
- **The credential is a `0600` file set from the terminal**, not a mirrored
  setting and not the Keychain. §5.3.
- **The extension's five-minute clock drives the credential probe, not the
  run's.** §5.4. This is the section's real content.
- **REST for the queue, MCP only inside the run.** §6 — MCP is a way to give a
  _model_ tools, and the scheduler is not a model. It also buys nothing on
  longevity: its headless path is the same API token plus an admin toggle.
- **A prompt may read and comment on its card, never transition it**, enforced by
  the tool set rather than by instruction. §6.3.
- **The project is created by API; two columns are a printed manual step.** §7.
- **Two sources, one interface, no mirror.** §8.
- **A failed read runs nothing and never falls back to the file.** §5.5.

Four more the build itself decided, each recorded in the section it belongs to:

- **One page, no paginator.** §4 — the cheapest way to be rid of the worst
  failure this design had was not to write the code that carried it.
- **`abandon` is its own method**, rather than the cancellation handler calling
  `record_outcome(entry, todo)`. §8 — the shortcut would have made the file
  source rewrite a STATUS line it has always deliberately left alone.
- **The recorded expiry warns but never blocks.** §5.4 — a hand-typed date
  refusing a working token is worse than the failure it guards against.
- **`QueueUnavailable` is raised, not returned.** §8 — so a caller cannot
  mistake it for an empty queue by forgetting to check.

### The one most worth disagreeing with

**Keeping `prompts.txt` as a second source rather than replacing it.** Against:
two implementations, two test suites, a settings field whose only job is to
choose between them, and a `QueueSource` abstraction that exists for one real
user — genuine weight for a single-user tool, and the file source will rot
quietly the moment Jira becomes the one anybody uses. For: it needs no account,
no network and no third party; and it is what a fresh clone works with in
`just setup`. Revisit after a month of real use, and delete the file source if it
turns out nobody has touched it.

> **One argument struck out, because it contradicts §5.5 and §5.5 is right.**
> This paragraph originally also argued that the file is "the fallback when Jira
> is unreachable". It must not be, and as built it is not: an unreachable Jira
> runs _nothing_. A file holding work you deleted from the board weeks ago is
> not a safety net, it is the one failure that costs work rather than time.
> The only falling back that happens is at **configuration** time — no project
> key, or no credential file, where there is no Jira queue to have failed — and
> it is logged when it does. A read that fails on a configured board is
> `QueueUnavailable`, full stop.

The runner-up worth arguing about is **In Review holding failures**. The case
against is that a successful-but-unmerged branch and a crashed prompt are
different things and a `Blocked` column would say so. The case for, which won: the
column means _your turn_, both are, and the goal named five columns.

## 13. Risks and unknowns

Written before the build. Three are now settled and say so; the rest stand,
because the thing they are about has not been measured yet.

- **ADF flattening** (§4) is the likeliest source of a subtly wrong prompt.
  Phase 0 measures it against backticks, asterisks, underscores, a path and a
  fenced block, because a silently reshaped prompt is worse than a failed read.
- ~~**`/rest/api/3/search/jql` pagination preserving rank order across pages.**~~
  **Settled by not building it.** One page, `maxResults=50`, no paginator — see
  §4. The risk was in code that now does not exist.
- ~~**Board column creation via any scriptable route** (§7) is assumed absent.~~
  **Fully settled — see `plans/company-managed-jira-project.md` §0.4/§0.5.**
  Creating the status works over the public API, as first found here; the
  missing link this section left open — the exact `workflows/update` schema —
  is now known and scripted, and so is `rapidviewconfig/columns`'s body shape
  on a classic board. §7 has the full table of what was tried here.
- **Whether token expiry is readable from an API** (§5.3). If it is, the recorded
  date becomes a cache; if not, a user who mistypes the date gets a warning on the
  wrong day — which the daily probe still catches on the right one.
- ~~**A stranded In Progress card** after a hard kill.~~ **Settled.** Swept at
  the next run's start, and returned by `abandon` on the way out of an ordinary
  cancellation; visible and harmless in between, and covered by a test.
- ~~**Jira rate limits.**~~ **Settled.** A 429 is retried once, honouring
  `Retry-After` where one is sent, and reports as `rateLimited` rather than as a
  generic failure.
- **The site URL changing** (a renamed Atlassian site) breaks everything silently
  until the daily probe fails. That is what the probe is for.
- **Atlassian changing token policy again.** It has moved twice in two years.
  §5.3's `tokenExpiresAt` and §5.4's probe are what make the next move visible
  rather than fatal.
- **The MCP headless auth path** (§6.2) needs a Rovo admin toggle whose exact
  client configuration is undocumented in the server's own README. Phase 0 checks
  whether it can be enabled and connected at all; Phase 6 is cancelled cheaply if
  not, since nothing depends on it.
- **A run that crosses an expiry.** A token valid at 2:00 and expired at 2:40
  fails the write, not the read — which is exactly what §5.5's pending-writes
  file exists for, and the reason it is a phase rather than a nicety. Built, and
  the failure is _reproduced_ in a test rather than only reasoned about: the stub
  server's socket is closed mid-run and the outcome has to land in the
  pending-writes file rather than raise.

Two the build added to this list:

- **The queue source has two owners** — the terminal and the popup — and the
  popup wins. §10 records the papercut and the way out.
- **`flatten_adf` is tested against documents this repo built.** Jira building a
  document out of something a person typed into the phone app is a different
  input, and only Phase 0 sees it.

## 14. Phases

0. **Probe.** _Not done — see below._ `just probe-jira-adf` and a scratch
   project: what does a real prompt survive as through v3 and v2; does
   `/search/jql` hold rank across pages; can columns be created by any API; is
   token expiry readable; can the MCP server's headless auth be enabled and
   connected (§6.2).
1. **The seam.** ✅ `QueueSource` extracted into `backend/queue_source.py`,
   today's behaviour moved into `FileQueueSource`, `status_line_index` replaced
   with `handle`.
2. **The Jira source, read-only.** ✅ Credential file, `next_todo`,
   `holds_a_todo`, `remaining_todo_prompts`, ADF flattening, `just queue-list`,
   `just jira-status` — and `just queue-source`, which the plan did not name but
   which is the question you actually ask ("which queue, and can it be read?").
3. **Write-back.** ✅ Transitions, labels, comments (§9), the In Progress sweep,
   `just install-jira-queue` and `just import-prompts-to-jira`.
4. **The warning system.** ✅ The daily probe in the host, `jira-status.json`,
   and the settings line, the banner and the badge — with §5.4's note about
   warning rather than blocking on the recorded date.
5. **Resilience.** ✅ The pending-writes file, the 429 retry, and the settings
   through the extension.
6. **MCP inside the run.** _Not done._ Optional, and gated on Phase 0's answer
   about the headless auth path.

**Phase 0 could not be done from here, and that is a fact about the phase rather
than about the work.** Every question in it is a measurement against a live
Atlassian site with a real token; a stub answering them would only be answering
itself. What phases 1–5 could do instead was build the tool that asks — `just
probe-jira-adf` creates one card, reads it back through both APIs, deletes it,
and prints the two flattenings against what was sent. **Run it once before
trusting a long prompt to the board.** Each unknown it covers has a documented
fallback here, so a bad answer costs a change rather than a redesign:

| Question                                   | If the answer is bad                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| Does v3's ADF flatten losslessly?          | Switch the read path to `/rest/api/2/` (§4).                               |
| Does `/search/jql` hold rank across pages? | Moot as built — one page, no paginator (§4).                               |
| Can board columns be created by API?       | Partly answered already — §7's table; the two clicks stay printed for now. |
| Is token expiry readable from an API?      | Nothing breaks; the typed date stays the source (§5.3).                    |
| Can MCP's headless auth be enabled?        | Phase 6 is cancelled; nothing depends on it (§6.3).                        |

**Phase 4 was not optional and was not treated as such** — it is the half of §5
that makes the API token choice defensible, and phases 1–3 without it would have
shipped exactly the failure the goal set out to avoid.

## 15. Success criteria

Marked against what was built. The two that cannot be checked without a real
Atlassian account are marked as such rather than claimed.

- ⏳ A prompt typed into the Jira mobile app at 11 PM runs at 2 AM, and by
  morning its card is in Done carrying Claude's account of what it did.
  _Every step is covered against the stub; the end-to-end run needs a site._
- ⏳ **Dragging a card to the top of To Do changes what runs next, with no other
  action taken anywhere.** _The read is `ORDER BY Rank ASC` and asserted to be;
  the drag itself is Jira's._
- ✅ A prompt that left work on a branch is in In Review with the branch named,
  and dragging it back to To Do is the only gesture needed to re-queue it —
  `start` clears both labels, which is what keeps that a single gesture.
- ✅ With the network down, the run logs why it did nothing, touches neither
  source, and exits 0.
- ✅ With the token expired, the toolbar badge said so a week earlier.
- ✅ `just jira-status` answers site, project, credential, days to expiry, column
  health and queue depth in one screen.
- ✅ With `queueSource` unset, behaviour is unchanged — the 227 existing tests
  still pass, alongside 74 new ones for the two sources (16 for the file, 58 for
  Jira) and 4 more for the setting that chooses between them, with `just check`
  and `just test-usage-host` both green. Not _byte_-identical on the tests
  themselves: §8 records the one rename that could not be avoided.

## 16. References

- [Manage API tokens for your Atlassian account](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [API tokens will now have a maximum one-year expiry](https://community.atlassian.com/forums/Jira-articles/API-tokens-will-now-have-a-maximum-one-year-expiry/ba-p/2880029)
- [OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/software/oauth-2-3lo-apps/)
- [Jira Cloud platform REST API — projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/)
- [Jira Software Cloud REST API — board](https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/)
- [Atlassian MCP Server (official repository)](https://github.com/atlassian/atlassian-mcp-server)
- [Atlassian MCP Server documentation](https://atlassian.github.io/atlassian-mcp-server/)
- [Introducing Atlassian's Remote MCP Server](https://www.atlassian.com/blog/announcements/remote-mcp-server)
- [Claude Code issue #36374 — OAuth for HTTP MCP servers](https://github.com/anthropics/claude-code/issues/36374)
