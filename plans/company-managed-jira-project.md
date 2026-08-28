# Plan: `install-jira-queue` creates a company-managed project

## Goal

`just install-jira-queue` currently creates a **team-managed** Jira Software
project and ends by printing two board columns a human has to add by hand. That
choice (see `plans/work-queue-as-a-jira-board.md` §2) bought one thing — in a
team-managed project the board's columns *are* its statuses, so "add a column"
and "add a status" are a single gesture with no scheme in between — and it costs
in two places that have since come up:

- **The default work type.** `jira-default-work-type` branch measured it: a
  team-managed project has no issue type scheme, so there is no
  `defaultIssueTypeId` to set. A card made by hand on the board comes out a
  `Bug` (Jira takes the alphabetically first work type), and the only lever is
  *deleting* the other work types by hand.
- **A custom field on the card layout.** `plans/jira-repository-picker.md` §0.3
  measured it: attaching a field to a team-managed project's issue layout has no
  public REST route — it is a UI-only action.

Both trace to the same limitation: a team-managed project's schemes are not
reachable over the public API. A **company-managed** project has an issue type
scheme, a workflow scheme and screen schemes, and all three *are* reachable. The
cost the team-managed choice was avoiding — configuring those before the five
columns exist — is now paid **once, in code, inside `install-jira-queue`**,
instead of by a human clicking.

This plan switches `create_project` to a company-managed Kanban template and
scripts the rest end to end: an issue type scheme whose default is `Task`
instead of `Bug`, the two missing statuses wired into the workflow with global
transitions, and the board's five columns mapped. The target is **zero printed manual steps** except the one that
is genuinely not ours to do — pointing the extension's Settings at the board.

The existing FC project is brand new with nothing worth keeping, so it is simply
deleted and recreated. There is **no migration** and this plan designs none.

Non-goals: migrating data off the old project (there is none); supporting both
project types behind a flag (the run already cannot tell which project type it
is talking to, and should not start); a Scrum board (no sprints — see §9.3); the
repository-picker field itself (that plan owns it; this one only notes that
company-managed unblocks its §3).

## 0. What must be measured first

**Nothing below §0 is measured yet.** The house rule is "measure, do not reason",
and this plan is written to *degrade to today's behaviour per step* precisely
because every scripted step here rests on an API call whose behaviour on a
company-managed Cloud project has not been checked. Phase 0 (see §10) creates a
throwaway company-managed project on `carpetsquare.atlassian.net` with the stored
token, runs the probes below, records the answers **back into this section** the
way `plans/jira-repository-picker.md` §0 did, and deletes the project.

Until that is done, treat §3–§5 as the intended shape, not a guarantee.

### 0.1 Project creation

`POST /rest/api/3/project` with `projectTypeKey: "software"`,
`projectTemplateKey: "com.pyxis.greenhopper.jira:gh-kanban-template"`,
`leadAccountId`, `assigneeType: "PROJECT_LEAD"`, `key`, `name`.

- Does it return synchronously with `{id, key, self}`, or `202` + a task URL to
  poll? (Classic creation has historically been synchronous — confirm.)
- **What are the board's starting column names?** The classic Kanban template
  has shipped different defaults over the years ("To Do / In Progress / Done"
  vs "Backlog / Selected for Development / In Progress / Done").
  `resolve_project_statuses` matches statuses **by name**, so step 7 needs to
  know exactly what it is reshaping.
- Does the response carry the board id, or is a follow-up
  `GET /rest/agile/1.0/board?projectKeyOrId={key}` needed?
- Which workflow is bound to the project's `Task` type, and is it
  `isEditable: true`? **Is it a project-local copy or a shared site workflow?**
  If shared, editing it reaches other projects and this plan grows a branch (see
  §9).
- Which issue type scheme and issue type screen scheme are assigned?
  `GET /rest/api/3/issuetypescheme/project?projectId={id}`,
  `GET /rest/api/3/issuetypescreenscheme/project?projectId={id}`.
  **§0.2 branches on this answer** — a project-specific scheme can be edited in
  place; the shared site default scheme cannot.

### 0.2 A scheme that defaults to Task

The want is narrow: a card created by hand on the board should come out a
`Task` instead of a `Bug` — the other standard types stay offered. No palette
narrowing.

- `GET /rest/api/3/issuetype` → the site's `Task` id (`hierarchyLevel == 0`,
  `name == "Task"`, not `subtask`).
- Which scheme the fresh project was assigned (§0.1) decides the route:
  - **Project-specific scheme:** does
    `PUT /rest/api/3/issuetypescheme/{schemeId}` accept a body that changes
    only `defaultIssueTypeId`, or does it demand the full type list back?
  - **Shared site default scheme:** `POST /rest/api/3/issuetypescheme` with
    `{name, issueTypeIds: <the assigned scheme's own type list>, defaultIssueTypeId: taskId}`,
    then `POST /rest/api/3/issuetypescheme/project`
    `{issueTypeSchemeId, projectId}` to bind it. Does binding succeed on a
    fresh project?
- Confirm the create dialog on the board then defaults to `Task`, with the
  other standard types still offered.
- Cleanup: rebind the site default scheme and `DELETE /issuetypescheme/{id}`
  if a dedicated one was created, or restore the original `defaultIssueTypeId`
  if the project's own scheme was edited in place.

### 0.3 The two missing statuses

- `POST /rest/api/3/statuses` with
  `scope: {type: "PROJECT", project: {id}}` and
  `statuses: [{name: "Draft", statusCategory: "TO_DO"}, {name: "In Review", statusCategory: "IN_PROGRESS"}]`.
  Does company-managed accept `PROJECT` scope, or force `GLOBAL`?
- If a global `Draft` / `In Review` already exists on the site, does creation
  `400` on the name clash, or return the existing one? (Drives find-or-create.)
- A status created but left out of the workflow is invisible and collides by
  name with the one the UI would create — `DELETE /rest/api/3/statuses?id=…` is
  the documented cleanup (board plan §7). Confirm it still applies here.

### 0.4 Adding statuses to the workflow — the crux

- `GET /rest/api/3/workflows/search?expand=statuses,transitions` (or the
  workflow-scheme route scoped to the project) → the workflow's `id`, `version`,
  `isEditable`, its current status list and transition graph.
- `POST /rest/api/3/workflows/update` — **read the current request schema
  properly and fetch-mutate-POST; never hand-build the body.** The board plan
  tried three guessed shapes and got `400` every time, and its closing advice
  was exactly this. Add `Draft` and `In Review` to the workflow's status pool
  and to this workflow.
- **Global transitions.** The run's `_transition` moves a card by *destination
  name* over whatever transitions the API reports, and the team-managed board it
  replaces was *undirected* — any status reachable from any other. A classic
  workflow is **directed** by default, so without global ("any status → this
  status") transitions, `_transition` starts failing with
  `No transition from X to 'Y'` at 2 AM. Confirm global transitions are
  expressible via `workflows/update` in one call; if not, fall back to an
  explicit transition per ordered pair (5 statuses → at most 20, bounded).

### 0.5 Board column mapping

- `GET /rest/agile/1.0/board/{boardId}/configuration` → current columns and
  `columnConfig.constraintType` (read-only, but tells us the starting point).
- `PUT /rest/greenhopper/1.0/rapidviewconfig/columns` with the full ordered set
  `Draft | To Do | In Progress | In Review | Done`, each column carrying its
  `mappedStatuses: [{id}]`. **This endpoint `500`d on a simplified board** (board
  plan §7). It is the endpoint classic-board scripts have used for years, so the
  odds on a *classic* board are better — but it is undocumented and unverified.
- If it `500`s here too, step 7 degrades to printing the two-column manual step,
  exactly as today (§9.6).

### 0.6 Screen field attach (for the repository-picker follow-on)

While a probe project exists, confirm the chain the repository-picker plan needs:
`issuetypescreenscheme/project` → screen scheme → screens →
`GET /rest/api/3/screens/{id}/tabs` →
`POST /rest/api/3/screens/{id}/tabs/{tabId}/fields {fieldId}` is accepted. Detail
belongs to that plan; this is only a "the wall is gone" check.

### 0.7 Teardown and re-run safety

- `DELETE /rest/api/3/project/{key}` — does it cascade the board, the workflow
  and the bound issue type scheme, or leave orphans that collide by name on the
  next `install`? CLAUDE.md requires every `install-*` recipe to be safe to
  re-run at any point; this answer decides how much find-or-create §6 needs and
  whether a `--purge` escape hatch is warranted.

## 1. Why company-managed, and why now

The `jira` branch shipped team-managed deliberately, and the reasoning still
holds *for what it was solving*: five columns with no scheme machinery, at the
price of two clicks once. What changed is that two follow-on features both hit
the same wall, and the wall is the public API's silence on team-managed schemes:

| Friction | Team-managed (measured) | Company-managed |
| --- | --- | --- |
| Default work type | No issue type scheme → no `defaultIssueTypeId`; hand-made card is a `Bug`; only lever is deleting work types by hand | Issue type scheme is a REST object; `defaultIssueTypeId` is settable |
| Custom field on card layout | No REST route to attach a field to the layout — UI only | `screens/{id}/tabs/{tabId}/fields` attaches it |
| Board columns | Column == status, one gesture, but **no REST route** — two clicks by hand | Status → workflow → column, more moving parts, **but every part is a REST object** |

Company-managed does not make the board-columns step *free* — it trades "no API
at all" for "three API objects to wire". But those three are scriptable, so the
trade is *human clicks now, code once*. And because FC is brand new, the switch
costs nothing but this plan's Phase 0.

`jira-default-work-type` is **superseded** by this plan — its
`review_work_types` / printed-deletions approach exists only because a
team-managed project had no `defaultIssueTypeId`. That branch should not be
merged; §5 replaces it with a one-line scheme setting.

## 2. What changes in the project's shape

| | Team-managed (today) | Company-managed (this plan) |
| --- | --- | --- |
| Template key | `…:gh-simplified-agility-kanban` | `…:gh-kanban-template` |
| A status | Project-owned; being on the board *is* being a status | Workflow-owned; must be in the workflow **and** mapped to a column |
| Work types | Project-owned, no scheme | Issue type scheme (a site object) assigned to the project |
| Fields on the layout | UI only | Screen scheme / ITSS; fields attach via screen tabs |
| The board | Implicit | An explicit `rapidView` with a column config we PUT |
| Transitions | Undirected (drag anywhere) | Directed by default — **we must add global transitions** |
| Permission needed | Administer Jira | Administer Jira (unchanged — free-site owner has it) |
| Jira Cloud Free | Covered | Covered (company-managed is not a paid feature; confirm in §0) |

Everything downstream of the queue is untouched. `JiraQueueSource`,
`resolve_project_statuses`, `_transition` (by destination name),
`determine_outcome`, the `STATUS_*` vocabulary and the summary writer all keep
working as they are — the change is entirely inside project *setup*.

## 3. The scripted setup — the new `_install` flow

Re-run safe at every step: find-or-create, or diff-and-patch, never append.

1. Credential — unchanged.
2. `GET /rest/api/3/myself` → `accountId` — unchanged.
3. `find_project` by key/name. **If it exists, leave it entirely alone** — this
   now also means the scheme/workflow/column scripting is *not* re-run against a
   project someone may have hand-customised. `just jira-configure-project` (§6)
   is the deliberate "re-apply the config" path.
4. Create the project from `gh-kanban-template` if absent. Handle a `202` +
   task-poll response if §0.1 finds one.
5. **Issue type scheme.** Resolve the site's `Task` id. If the project's
   assigned scheme is project-specific (§0.2), set its `defaultIssueTypeId` to
   `Task` in place; otherwise find-or-create a
   `Free Claude Prompts — defaults to Task` scheme carrying the assigned
   scheme's type list with `Task` as default, and bind it to the project if not
   already bound.
6. **Workflow statuses.** Resolve the project's workflow. Find-or-create the
   `Draft` and `In Review` statuses (project scope per §0.3). Diff the
   workflow's current statuses against the five wanted; `workflows/update` to add
   the missing ones **and the global transitions** that keep every status
   reachable by name.
7. **Board columns.** Resolve the board id; read its column config; if it is not
   already `Draft | To Do | In Progress | In Review | Done` in that order, PUT
   the full five-column mapping. On a `500` (§0.5), fall through to step 8's
   print.
8. `resolve_project_statuses` — should now report all five present. The existing
   "print the columns a human must add" block is **kept**, and simply expected
   to find nothing missing. If a step above could not be scripted, it prints
   exactly the residual — no worse than today.
9. Write the settings mirror (`queueSource = jira`, `jiraProjectKey`) —
   unchanged.
10. Probe the credential, write `jira-status.json` — unchanged.
11. Print only: "point the extension's Settings at the board" (still required —
    the extension owns those two settings and overwrites the mirror on its next
    save) and "check it: `just jira-status`".

## 4. Statuses, the workflow and the columns — where the risk sits

The chain is **create status → add to workflow → map to board column**, and each
link has a fallback so a gap in one does not block `install`:

- **Status creation** (§0.3): project-scoped so the site's global status list
  stays clean. If a stranded same-named status from a half-finished earlier run
  is sitting outside the workflow, `DELETE /rest/api/3/statuses?id=…` it first
  (board plan §7's collision note).
- **Workflow** (§0.4): fetch the workflow representation, add the two statuses
  and global transitions to the in-memory copy, POST it back via
  `workflows/update`. Never hand-build the body. If the project's workflow turns
  out to be a *shared* site workflow (§0.1), this step instead creates a
  project-local workflow + workflow scheme + ITSS and binds them — a bigger
  branch, gated on Phase 0.
- **Board columns** (§0.5): one `PUT /rest/greenhopper/1.0/rapidviewconfig/columns`
  with all five columns in order. On failure, `install` prints the two-column
  manual step and `just jira-status` verifies afterwards — i.e. the plan
  degrades to its "minimal" shape rather than erroring.

The **global-transitions** point is not optional polish: `_transition` is
name-directed over whatever transitions exist, and it currently relies on the
team-managed board being undirected. A directed classic workflow without global
transitions makes the run's To Do → In Progress → In Review → To Do moves fail
intermittently. §0.4 confirms how to express them; §9.5 carries the fallback.

## 5. The issue type scheme — default to Task, keep every type

The requirement is deliberately narrow: a card created by hand on the board
defaults to `Task` instead of `Bug`. The other standard types stay available —
the ask is the default, not a narrowed palette.

- **Never rewrite the site default scheme.** It is shared by every project on
  the site; changing its default would change the create dialog of the other
  ~17 projects. (This is the inverse of `jira-repository-picker.md`'s "the
  field is global" wrinkle — there the API forces global; here it lets us
  scope, so we scope.)
- If §0.1 shows the fresh project comes with a **project-specific scheme**,
  edit that one in place — `PUT` its `defaultIssueTypeId` to the `Task` id, no
  new object at all. If it is the shared site default, find-or-create a
  dedicated scheme by `name`, mirroring the assigned scheme's type list so
  nothing the create dialog offered disappears, with
  `defaultIssueTypeId = taskId`; idempotent.
- `defaultIssueTypeId = taskId` is the whole feature — it replaces
  `jira-default-work-type`'s printed deletions.
- `create_card` keeps `"issuetype": {"name": "Task"}` — still correct, and now
  a card made by hand on the board matches a card the importer makes.

## 6. Code changes, file by file

- **`backend/queue_source_jira.py`**
  - `KANBAN_TEMPLATE_KEY` → `COMPANY_MANAGED_KANBAN_TEMPLATE_KEY =
    "com.pyxis.greenhopper.jira:gh-kanban-template"`; rewrite the comment above
    it (it currently explains the team-managed one-gesture rationale).
  - Module docstring: "team-managed" → "company-managed", and the opening
    rationale paragraph.
  - `create_project`: new template key, docstring, and a `202`/task-poll branch
    if §0.1 needs one.
  - New: `resolve_task_issue_type(client)`,
    `ensure_scheme_defaults_to_task(client, project_id)` →
    `(scheme_id, changed, bound)` — edits the project's own scheme in place
    when it has one, else finds-or-creates and binds the dedicated scheme.
  - New: `resolve_project_workflow(client, project_id)`,
    `find_or_create_status(client, project_id, name, category)`,
    `delete_stranded_status(client, status_id)`,
    `ensure_statuses_in_workflow(client, workflow, wanted_names)` — fetch /
    mutate / POST `workflows/update`, including global transitions.
  - New: `resolve_board_id(client, project_key)`,
    `ensure_board_columns(client, board_id, ordered_status_ids)` — no-op when the
    column config already matches; degrades on `500`.
  - `_install`: orchestrate steps 5–7; keep the printed-steps block as the
    fallback, expected empty.
  - `_status`: unchanged — it already reports column health, which now doubles as
    verification that the scripted mapping took.
  - New CLI mode `--configure-project` → `just jira-configure-project`: runs only
    steps 5–7 against an existing project, touching neither credential nor
    settings. Mirrors `--probe-adf`'s "run it by hand and see" role and is the
    repair path when a project's config drifts.
- **`backend/tests/test_queue_source_jira.py`** — extend the in-process fake
  Jira `_Handler` with routes for `/rest/api/3/issuetypescheme*`,
  `/rest/api/3/issuetype`, `/rest/api/3/statuses`, `/rest/api/3/workflows/*`,
  `/rest/agile/1.0/board*`,
  `/rest/greenhopper/1.0/rapidviewconfig/columns`. Tests:
  - each `ensure_*` is idempotent — a second call issues zero writes;
  - a `500` from `rapidviewconfig/columns` leaves `_install` succeeding and the
    two-column manual step printed, not an exception;
  - `ensure_statuses_in_workflow` adds only the missing statuses and the global
    transitions, not the ones already present.
  - `create_project` and the full orchestration still are not end-to-end
    testable without the real site — same as today; Phase 0 and `just
    jira-status` are the real verification (board plan §7 takes the same stance).
- **`justfile`** — `install-jira-queue` comment → "creates a company-managed
  Jira Software project and configures its scheme, workflow and board columns";
  add `jira-configure-project` next to the other `jira_script` recipes.
- **`CLAUDE.md`** — the "Jira half" section: flip "team-managed" → "company-
  managed" and rewrite the rationale paragraph (it currently argues *for*
  team-managed). New paragraph: `install-jira-queue` now builds the five columns
  end to end — an issue type scheme defaulting to `Task`, `Draft`/`In Review`
  statuses in the workflow with global transitions, board column mapping — and
  the only printed step is pointing the extension at the board; note the Phase 0
  caveats and that `jira-default-work-type` is superseded.
- **`plans/work-queue-as-a-jira-board.md`** — indented "As revised — see
  `plans/company-managed-jira-project.md`" notes on §2 (project type), §7 (the
  manual columns step) and §13's board-column bullet.
- **`plans/jira-repository-picker.md`** — indented note on §0.3 and §3: on a
  company-managed project the field *can* be attached to the card layout over
  REST, so §3's manual step is expected to go away; the picker's phases 1–2 are
  unaffected and phase 5 gets simpler.

## 7. Tests

Detailed in §6's test bullet. The shape: fake-server routes for the new
endpoints, idempotency assertions on every `ensure_*`, and a degradation
assertion that an unscriptable step prints rather than raises. The real
end-to-end check stays `just jira-status` against the live site, because
`create_project` and the orchestration cannot be exercised without it — the same
limitation the board plan already lives with.

## 8. Decisions taken

1. **Company-managed, project recreated from scratch — no migration.** FC is
   brand new; deleting and recreating it costs nothing, and supporting both
   project types behind a flag would leave the run unable to know which it is
   talking to.
2. **Full scripting, zero printed manual steps.** The value of the switch is
   removing human clicks; stopping half-way (scheme scripted, columns still
   manual) would leave the switch barely worth its Phase 0.
3. **Kanban template, not Scrum.** No sprints; matches the current board and the
   "ranked queue, read top-down" model.
4. **Default to Task, keep every type — via the project's own scheme when it
   has one, else a dedicated scheme; never the site default.** The ask is the
   default, not a narrowed palette — and rewriting the site default scheme's
   default would change the create dialog of the other ~17 projects.
5. **Global transitions in the workflow.** `_transition` works by destination
   name over whatever transitions exist, and the board it replaces was
   undirected; a directed classic workflow would make the run's card moves fail
   at 2 AM.
6. **Degrade, don't fail.** Any sub-step Phase 0 finds unscriptable falls back
   to the existing printed-manual-step machinery, so a partial API gap cannot
   block `install`.
7. **`jira-default-work-type` is superseded** and should not be merged.

## 9. Risks and unknowns

1. **Everything in §0 is unmeasured.** The plan degrades per step, but the
   "zero manual steps" ambition is only realised if Phase 0's answers are
   favourable.
2. **`workflows/update` is a versioned, involved schema.** A wrong body `400`s
   (the board plan hit this three times). Mitigation: fetch-mutate-POST, never
   hand-build; keep the printed fallback.
3. **`rapidviewconfig/columns` is a private GreenHopper endpoint.** It `500`d on
   a simplified board and is undocumented for classic. Better odds on classic,
   but unverified — §0.5.
4. **The project's workflow may be shared, not project-local.** Editing it would
   reach other projects; if so the plan grows a "create project-local workflow +
   scheme + ITSS and bind" branch — measure in §0.1 before building §6's
   workflow functions.
5. **Global transitions may need one call or twenty.** If `workflows/update`
   cannot express "any → status" in one shot, fall back to an explicit
   transition per ordered pair — 20 for five statuses, tedious but bounded.
6. **Company-managed teardown may orphan objects.** `DELETE /project` might
   leave the issue type scheme / workflow / board behind to collide by name on
   the next `install`. Re-run safety needs find-or-create on every object;
   §0.7 decides whether a `--purge` escape hatch is also warranted.
7. **Classic Kanban template's default column names are unknown** (§0.1).
   `resolve_project_statuses` keys entirely off name, so step 7 needs the exact
   starting names to know what it is reshaping.
8. **Jira Cloud Free may cap company-managed projects.** Believed not, confirmed
   in §0.

## 10. Phases

1. **Phase 0 — measure.** Real site, throwaway company-managed project, every
   probe in §0, answers written back into §0, project deleted. Blocks everything
   below.
2. **Template swap + Task-default scheme.** Smallest useful increment: company-
   managed project created, issue type scheme scripted, columns still printed.
   Shippable alone — it kills the work-type friction and supersedes
   `jira-default-work-type`.
3. **Workflow statuses + global transitions.** `Draft` / `In Review` into the
   workflow, reachable by name from anywhere.
4. **Board column mapping.** The `rapidviewconfig/columns` PUT, with the
   degrade-to-print fallback.
5. **`--configure-project` CLI + tests.** Fake-server routes, idempotency,
   degradation assertions.
6. **Docs.** CLAUDE.md flip, the two plan-doc notes; `just --list` picks up the
   new recipe from its comment.

## 11. Success criteria

- `just install-jira-queue` on a clean site creates a company-managed project
  and leaves `just jira-status` reporting all five columns present, with nothing
  printed but "point the extension at the board".
- A card created by hand on the board defaults to `Task`, with the other
  standard types still offered.
- The run moves a card To Do → In Progress → In Review → To Do with no
  `No transition` error.
- Re-running `just install-jira-queue` changes nothing and prints nothing new.
- If Phase 0 disproves the column PUT, the same command still succeeds and
  prints exactly the two-column manual step — no worse than today.
- `just jira-configure-project` repairs a project whose scheme, workflow or
  columns have drifted, without touching the credential or the settings mirror.
