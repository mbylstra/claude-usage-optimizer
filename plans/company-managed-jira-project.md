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

**Phase 0 is complete — every probe below is measured**, against a throwaway
company-managed `FCX` project created on `carpetsquare.atlassian.net` with the
stored token, and torn down (§0.7) at the end. The house rule was "measure, do
not reason"; the answers are recorded inline under each subsection below, and
the outcome across the board is **better than the plan assumed going in**: no
`500`s, no manual-step fallback needed anywhere, and the full `workflows/update`
schema is now known exactly rather than guessed at (§0.4). §3–§5 can be treated
as measured, not merely intended, with the corrections captured inline.

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

**Measured** (throwaway `FCX` project, `carpetsquare.atlassian.net`, classic
Kanban template):

- **Synchronous.** `POST /rest/api/3/project` returns `{id, key, self}`
  directly — no `202`/task poll.
- **Starting statuses were `Backlog / Selected for Development / In Progress /
  Done` — there is no "To Do".** Three of the four carry a
  `"(Migrated on <date>)"` description, i.e. they are reused *global* statuses,
  not fresh project-scoped ones. `step 7` (§3) must create/find a real "To Do"
  status and add it to the workflow exactly like Draft/In Review — it is not
  free.
- The board id is **not** in the create response. Follow-up
  `GET /rest/agile/1.0/board?projectKeyOrId={key}` → `values[0].id` is required.
- The workflow, issue type scheme, and issue type screen scheme assigned to a
  fresh project are all **project-specific** (`"FCX: Software Simplified
  Workflow Scheme"`, `"FCX: Kanban Issue Type Scheme"`, `"FCX: Kanban Issue
  Type Screen Scheme"`), each named after the project key, each editable
  (`isEditable: true` on the workflow) — **not shared with any other project**.
  §9's shared-workflow risk branch does not trigger on a fresh company-managed
  project.

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

**Measured:**

- Site `Task` issue type id is stable per-site (`10016` on this site; the site
  also has a duplicate `Task` (`10052`) and duplicate `Story`/`Bug` from old
  migrations — matching **must** filter on `hierarchyLevel == 0 && !subtask`,
  matching by name alone is not enough).
- **The fresh project's scheme is project-specific** (§0.1), so the in-place
  route applies: `PUT /rest/api/3/issuetypescheme/{schemeId}` **accepts a
  partial body — `{"defaultIssueTypeId": taskId}` alone succeeds**, no need to
  resend the full type list. Verified by re-`GET`.
- Site default scheme is id `10000`, `isDefault: true`, shared by ~17 projects
  on this site — confirmed never touched.
- Enumerating a scheme's `issueTypeIds` from `GET /issuetypescheme` does not
  work as hoped: **the `issueTypeSchemeId` query filter is ignored** — the
  endpoint always returns the full site list of schemes (flat objects:
  `id/name/description/defaultIssueTypeId/isDefault`, not the nested
  `{issueTypeScheme, issueTypeIds}` shape the v3 docs page structure suggests
  at a glance). If the type list is needed, `GET
  /rest/api/3/issue/createmeta?projectKeys={key}` is the working alternative
  (untested here since the partial-body PUT made it moot).

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

**Measured:**

- **`PROJECT` scope is rejected outright** —
  `400 "We couldn't find project <id> in this scope."` — even with a
  correctly-vocabularied body. **Company-managed forces `GLOBAL` scope for
  new statuses**; there is no such thing as a project-scoped status on this
  site (`GET /rest/api/3/statuses/search` shows every one of the site's 47
  statuses as `scope.type: GLOBAL`, including ones from long-defunct personal
  projects). `ensure_statuses_in_workflow` must always create with
  `{"type": "GLOBAL"}`.
  - The `statusCategory` vocabulary for this endpoint is **`TODO` /
    `IN_PROGRESS` / `DONE`**, not the lowercase `new`/`indeterminate`/`done`
    used elsewhere in the v3 API — a second, independent thing the first
    (wrong-scope) attempt got wrong at the same time.
  - Creation is **synchronous** — returns the created status objects directly
    (`[{id, name, statusCategory, scope, description}]`), no task polling.
- **Name clash is a hard `400`, not find-or-existing**:
  `"Status name \"Draft\" already in use. Try a different name."`
  `find_or_create_status` must search by name (case-sensitive exact match —
  this site has both `"todo"` and `"To Do"` as distinct statuses, so
  case-insensitive matching would pick the wrong one) **before** attempting
  create, never rely on create's error to discover an existing one.
- Confirmed: a status created but not yet added to the workflow is invisible
  via `GET /project/{key}/statuses` (does not show up as a project status
  until it is actually used by the project's workflow) — matches the board
  plan's §7 note, and `DELETE /rest/api/3/statuses?id=…` is confirmed as the
  correct cleanup route (used in Phase 0 teardown, §0.7).

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

**Measured — the full schema, and it works in one call.**

The schema for this endpoint is **not** rendered by
`developer.atlassian.com`'s JS-driven docs page (it truncates), but it *is* in
the raw OpenAPI spec at `https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json`
(`components.schemas.WorkflowUpdateRequest`, with a full worked `example` on
the `POST /rest/api/3/workflows/update` operation) — download it once and
`grep`/`json.load` it locally rather than guessing from error messages one
field at a time; that is by far the fastest path to the exact shape.

**Two endpoints share the name "workflow search" and are not interchangeable:**

- `GET /rest/api/3/workflow/search` (**singular** `workflow`) — legacy. Its
  `id` is a composite `{name, entityId}` object. **Its response shape does not
  round-trip back into `workflows/update`.**
- `GET /rest/api/3/workflows/search` (**plural** `workflows`) — paired with
  `workflows/update`. `id` is a plain string (the entityId). Filter with
  `?projectId={id}&expand=values.transitions` (the *only* documented expand
  value; asking for anything else `400`s with the full valid list in the error
  body). **Use this one, for both the read and as the base for the write.**

The write body:

```jsonc
{
  "statuses": [                     // pool of EVERY status this call touches —
    {                                // existing AND new. Omitting an untouched
      "id": "10028",                 // pre-existing one produces a baffling
      "name": "Backlog",              // "Transition references an unknown
      "statusCategory": "TODO",        // status" error even though it was
      "statusReference": "10028",       // already valid before the call.
      "description": ""
    },
    // ... one entry per status already on the workflow ...
    {
      "id": "10200",                  // the REAL numeric status id (from §0.3)
      "name": "Draft",
      "statusCategory": "TODO",
      "statusReference": "10200",     // pre-existing statuses: statusReference
      "description": ""               // == their real id, no UUID needed —
    }                                  // Jira reconciles a fresh UUID back to
  ],                                   // the real id anyway if you mint one.
  "workflows": [{
    "id": "<workflow entityId, plain string>",
    "version": {                      // NOT the same token as `id` above —
      "versionNumber": 0,             // fetch this from workflows/search's
      "id": "<opaque version token>"  // response, don't guess it.
    },
    "statuses": [
      {"statusReference": "10028", "properties": {}},
      // ... every status on the workflow, old + new, by statusReference ...
    ],
    "transitions": [
      {
        "id": "141",                        // any unused numeric id
        "type": "GLOBAL",                    // INITIAL | GLOBAL | DIRECTED —
        "toStatusReference": "10200",        // uppercase. Field is
        "links": [],                          // `toStatusReference`, not `to`.
        "name": "Draft",                       // DIRECTED transitions carry
        "description": "",                      // `links: [{fromStatusReference,
        "actions": [], "validators": [],         // fromPort, toPort}]` — there
        "triggers": [], "properties": {}          // is no `from` array.
      }
      // ... existing transitions carried through unchanged ...
    ]
  }]
}
```

Corrections versus what a from-scratch guess gets wrong (each one produced a
real, distinct `400` before landing on the shape above):

- `workflows[].id` is the plain `entityId` **string** — not the `{name,
  entityId}` object the singular search returns.
- `workflows[].version.id` is a **separate opaque token**, not the workflow's
  own id repeated. Must come from the same `workflows/search` fetch.
- The top-level `statuses` pool is **not** "new statuses only" — it must list
  every status the workflow will end up with, pre-existing included, or the
  pre-existing ones read back as "unknown".
- Transition target field is `toStatusReference`; there is no `to` field on
  this endpoint (that's the *read*-side shape from `workflow/search`, not the
  write shape).
- `type` is uppercase (`GLOBAL`, not `global`) — the read side happens to also
  return uppercase here, so this one is consistent, but is easy to get wrong
  by analogy with other Jira enums that are lowercase.
- `workflows[].statusMappings` (with per-issue-type `statusMigrations`) exists
  for **removing/renaming** statuses and is `400`-picky about being non-empty
  when present — **omit it entirely for a pure addition**, do not send `[]` or
  self-mappings, both still `400`.
- The response, on success, echoes back the resolved statuses with **their
  real ids substituted for any UUID `statusReference` you minted** — useful
  for confirming what actually landed without a second `GET`.

Verified end-to-end: added `Draft`, `In Review`, and (per §0.1's discovery
that "To Do" doesn't exist by default) `To Do` to the FCX workflow in three
separate `workflows/update` calls, each with a `GLOBAL` transition to the new
status, no `DIRECTED` transitions anywhere in the simplified-Kanban preset —
**confirming the workflow ships fully undirected already**, so global
transitions are additive, not a fight against existing directed edges.
`GET /project/{key}/statuses` reported all 7 statuses (5 wanted + the 2
unused Kanban-preset leftovers, Backlog/Selected for Development) immediately
after.

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

**Measured — it works on a classic board, no `500`, no manual step needed.**

`GET .../configuration` returns exactly the shape the plan expected —
`columnConfig.columns: [{name, statuses: [{id, self}]}]`,
`constraintType`. The board carries `rapidViewId` == the agile board id
(confirmed via `GET /rest/greenhopper/1.0/rapidview/{id}` — `isSimpleBoard:
false` on a classic board, which is the good branch: the plan's own §7 note
already flagged that the `500` was seen on a *simplified* board).

The write body is narrower than guessed — **no `columnsData` wrapper, and
adding one causes the generic `400 "Invalid request payload"`**:

```jsonc
{
  "rapidViewId": 475,
  "mappedColumns": [
    {"name": "Draft",       "mappedStatuses": [{"id": "10200"}]},
    {"name": "To Do",       "mappedStatuses": [{"id": "10026"}]},
    {"name": "In Progress", "mappedStatuses": [{"id": "3"}]},
    {"name": "In Review",   "mappedStatuses": [{"id": "10201"}]},
    {"name": "Done",        "mappedStatuses": [{"id": "10027"}]}
  ]
}
```

Confirmed by first round-tripping the board's *existing* 4-column config
unchanged (proves the shape before mutating anything), then PUTting the real
5-column target. `GET .../configuration` afterward showed exactly the 5
columns, in order, each with the right single mapped status — plus one extra
leading empty `"Backlog"` column with `statuses: []`, which is the board's
standard "unmapped statuses" bucket (Backlog and Selected for Development are
now deliberately unmapped) and is expected, not an error. **§9.6's manual-step
fallback is not needed** — build `ensure_board_columns` to call this directly,
keep the `500`-degrades-to-print path only as a defensive fallback for boards
this wasn't tested against (e.g. Scrum boards, boards with swimlane
constraints).

### 0.6 Screen field attach (for the repository-picker follow-on)

While a probe project exists, confirm the chain the repository-picker plan needs:
`issuetypescreenscheme/project` → screen scheme → screens →
`GET /rest/api/3/screens/{id}/tabs` →
`POST /rest/api/3/screens/{id}/tabs/{tabId}/fields {fieldId}` is accepted. Detail
belongs to that plan; this is only a "the wall is gone" check.

**Measured — the wall is gone.** The full chain resolves:
`issuetypescreenscheme/project` → screen scheme id → `GET
/rest/api/3/screenscheme?id=` → `screens.default` screen id → `GET
/screens/{id}/tabs` → one tab (`"Field Tab"`). `POST
/screens/{id}/tabs/{tabId}/fields {fieldId: "labels"}` returned
`400 {"fieldId": "The field with id labels already exists on the screen."}` —
a real, specific validation error (not a 404/wall), confirming the endpoint is
live and reachable on a company-managed project. `jira-repository-picker.md`
§0.3/§3 can proceed on this basis; it owns the actual field-creation detail.

### 0.7 Teardown and re-run safety

- `DELETE /rest/api/3/project/{key}` — does it cascade the board, the workflow
  and the bound issue type scheme, or leave orphans that collide by name on the
  next `install`? CLAUDE.md requires every `install-*` recipe to be safe to
  re-run at any point; this answer decides how much find-or-create §6 needs and
  whether a `--purge` escape hatch is warranted.

**Measured — `DELETE` is a soft delete, and the orphans are real.**

`DELETE /rest/api/3/project/{key}` does **not** free the project's name/key
immediately. It moves the project into a **60-day trash**
(`GET /rest/api/3/project/search?status=deleted` shows it with `deleted:
true`, `retentionTillDate` ~60 days out, `deletedBy`). `GET
/rest/api/3/project/{key}` correctly 404s (so naive existence checks are
fooled), but the project's **workflow, workflow scheme, issue type scheme,
and issue type screen scheme all survive as orphans**, still named after the
project key (`"FCX: Software Simplified Workflow Scheme"` etc.) and **still
reported as "active"/"assigned to a project"** by their own delete endpoints
— they refuse direct deletion (`"Not allowed to delete active workflow
scheme"`, `"cannot be deleted because it is assigned to one or more
projects"`) even though the project itself is gone from every listing except
the trash search. Recreating a project with the same key would mint
*new*-named schemes that collide with these orphans on next lookup by name.

The real cascade-delete is a **different, async endpoint**:
`POST /rest/api/3/project/{key}/delete` (needs `Administer Jira`, not the
softer `Administer Projects`) — returns a task, poll `GET
/rest/api/3/task/{id}` until `status: COMPLETE`. This **does** cascade the
issue type scheme and issue type screen scheme automatically (both gone,
confirmed via list-by-name, no direct `DELETE` call needed) — **but still
leaves the workflow scheme and the workflow itself orphaned**, requiring two
more explicit calls, in this order (workflow scheme first — the workflow
can't be deleted while a scheme still references it):
`DELETE /rest/api/3/workflowscheme/{id}` then
`DELETE /rest/api/3/workflow/{entityId}`.

Statuses created for the run are `GLOBAL` scope from the moment they're
created (§0.3) — project deletion, soft or hard, **never** touches them
either way; they need their own `DELETE /rest/api/3/statuses?id=…` regardless
of teardown path.

**This settles the find-or-create requirement for §6 as mandatory, not
optional**: `resolve_project_workflow`, `ensure_scheme_defaults_to_task`, and
the status/board helpers must all search-by-name before creating, because a
user who deletes and recreates a project (by hand, or via a `--purge`-less
re-run of `install-jira-queue`) will collide with orphans for up to 60 days.
A `--purge` escape hatch that calls the async `/delete` + the two explicit
scheme/workflow deletes above is worth adding to `jira-configure-project`
(§3) rather than leaving cleanup to Atlassian's own 60-day timer.

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
4. Create the project from `gh-kanban-template` if absent — **synchronous per
   §0.1, no task-poll needed.** Follow up with
   `GET /rest/agile/1.0/board?projectKeyOrId={key}` for the board id, which is
   not in the create response.
5. **Issue type scheme.** Resolve the site's `Task` id (`hierarchyLevel == 0
   && !subtask && name == "Task"` — §0.2 found duplicate `Task`/`Story`/`Bug`
   ids from migrations, name alone is not a safe filter). The project's
   assigned scheme is always project-specific on a fresh company-managed
   project (§0.1), so the in-place route always applies: `PUT
   /rest/api/3/issuetypescheme/{schemeId} {"defaultIssueTypeId": taskId}` — a
   partial body is accepted (§0.2), no need to resend the type list. Keep the
   shared-site-default branch as a defensive fallback only (`isDefault: true`,
   id `10000` on this site — never touch it) for the case of a user-named
   existing project (step 3) whose scheme predates this plan.
6. **Workflow statuses.** Resolve the project's workflow via
   `GET /rest/api/3/workflows/search?projectId={id}&expand=values.transitions`
   (the **plural** endpoint — §0.4; its singular namesake does not round-trip
   into the write). Find-or-create `Draft`, `In Review`, **and `To Do`** — all
   three, `GLOBAL` scope always (§0.3; this site's Kanban template starts with
   Backlog/Selected for Development instead of To Do, so all three of the
   plan's non-`In Progress`/non-`Done` columns are typically missing, not two).
   Diff the workflow's current statuses against the five wanted; one
   `workflows/update` call carrying **every** status the workflow will end up
   with (existing + new — §0.4's exact schema) plus one `GLOBAL` transition per
   new status.
7. **Board columns.** Resolve the board id (== `rapidViewId`); read its column
   config (`GET /rest/agile/1.0/board/{id}/configuration`); if it is not
   already `Draft | To Do | In Progress | In Review | Done` in that order, PUT
   the full five-column mapping via
   `PUT /rest/greenhopper/1.0/rapidviewconfig/columns
   {rapidViewId, mappedColumns: [{name, mappedStatuses: [{id}]}, ...]}` — **no
   `columnsData` wrapper** (§0.5 found it causes a generic `400` if included).
   Confirmed working on a classic board with no `500`; keep the `500`-degrades
   path (below) only as a defensive fallback.
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
  - `create_project`: new template key and docstring. **No `202`/task-poll
    branch needed** — §0.1 confirmed creation is synchronous — but a follow-up
    `GET /rest/agile/1.0/board?projectKeyOrId={key}` call is, since the board
    id is not in the create response.
  - New: `resolve_task_issue_type(client)`,
    `ensure_scheme_defaults_to_task(client, project_id)` →
    `(scheme_id, changed, bound)` — edits the project's own scheme in place
    when it has one (the only case seen on a fresh company-managed project,
    §0.1/§0.2), else finds-or-creates and binds the dedicated scheme as a
    defensive fallback for a pre-existing user-named project.
  - New: `resolve_project_workflow(client, project_id)` (via the **plural**
    `GET /rest/api/3/workflows/search?projectId=...&expand=values.transitions`
    — §0.4), `find_or_create_status(client, name, category)` (always `GLOBAL`
    scope, exact-name search before create — §0.3), `delete_stranded_status`,
    `ensure_statuses_in_workflow(client, workflow, wanted_names)` — fetch /
    mutate / POST `workflows/update` against the exact schema in §0.4,
    including a `GLOBAL` transition per added status and the full existing +
    new status pool (omitting an untouched pre-existing status 400s).
  - New: `resolve_board_id(client, project_key)`,
    `ensure_board_columns(client, board_id, ordered_status_ids)` — PUTs
    `rapidviewconfig/columns` with `{rapidViewId, mappedColumns}` (no
    `columnsData` wrapper — §0.5); no-op when the column config already
    matches; degrades on `500` as a defensive fallback, not expected to fire.
  - New: `purge_project_remnants(client, key_or_id)` — the async
    `POST /project/{key}/delete` cascade (task-polled) plus the two explicit
    `DELETE`s (`workflowscheme` then `workflow`) it still leaves behind (§0.7).
    Used by `--purge` below and, optionally, by Phase 0-style throwaway
    projects in tests.
  - `_install`: orchestrate steps 5–7; keep the printed-steps block as the
    fallback, expected empty.
  - `_status`: unchanged — it already reports column health, which now doubles as
    verification that the scripted mapping took.
  - New CLI mode `--configure-project` → `just jira-configure-project`: runs only
    steps 5–7 against an existing project, touching neither credential nor
    settings. Mirrors `--probe-adf`'s "run it by hand and see" role and is the
    repair path when a project's config drifts. A `--purge` flag on the same
    mode calls `purge_project_remnants` — the escape hatch §9 risk 6 calls for,
    so a deleted-and-recreated project doesn't wait out Atlassian's 60-day
    trash retention colliding by name.
- **`backend/tests/test_queue_source_jira.py`** — extend the in-process fake
  Jira `_Handler` with routes for `/rest/api/3/issuetypescheme*`,
  `/rest/api/3/issuetype`, `/rest/api/3/statuses`,
  `/rest/api/3/statuses/search`, `/rest/api/3/workflows/search` (**plural** —
  §0.4; the fake must not accidentally serve the legacy singular shape),
  `/rest/api/3/workflows/update`, `/rest/agile/1.0/board*`,
  `/rest/greenhopper/1.0/rapidviewconfig/columns`,
  `/rest/api/3/project/{key}/delete` + `/rest/api/3/task/{id}` (for
  `purge_project_remnants`), `/rest/api/3/workflowscheme/{id}`,
  `/rest/api/3/workflow/{entityId}`. Tests:
  - each `ensure_*` is idempotent — a second call issues zero writes;
  - a `500` from `rapidviewconfig/columns` leaves `_install` succeeding and the
    two-column manual step printed, not an exception — a defensive path, given
    §0.5 found no `500` on the real classic board;
  - `ensure_statuses_in_workflow` adds only the missing statuses and the global
    transitions, not the ones already present, and correctly includes
    untouched pre-existing statuses in the write's status pool (§0.4 — a
    regression here reproduces the exact `400` Phase 0 hit before that was
    understood);
  - `find_or_create_status` searches by exact name before creating, and
    surfaces the specific "already in use" `400` distinctly from other
    failures (§0.3);
  - `purge_project_remnants` polls the delete task to completion and issues
    the workflow-scheme-then-workflow deletes in that order (§0.7).
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

1. ~~**Everything in §0 is unmeasured.**~~ **Settled — Phase 0 is complete.**
   Every probe below §0 came back favourable: no `500`s, no undiscoverable
   schema, no shared-workflow branch triggered. The "zero manual steps"
   ambition holds without a fallback being exercised.
2. ~~**`workflows/update` is a versioned, involved schema.**~~ **Settled.** The
   exact schema is now known (§0.4) — pulled from the raw OpenAPI spec
   (`swagger-v3.v3.json`, not the JS-rendered docs page, which truncates) and
   confirmed against the live API, not guessed. Mitigation shipped: read the
   spec first, fetch-mutate-POST from `workflows/search` (**plural**, not the
   singular endpoint of the same near-name — its shape does not round-trip).
3. ~~**`rapidviewconfig/columns` is a private GreenHopper endpoint.**~~
   **Settled — works on a classic board, no `500`.** §0.5: the board plan's
   `500` was on a *simplified* board; this plan's classic board round-tripped
   its existing config, then accepted the real 5-column PUT cleanly. The one
   real gotcha: a `columnsData` wrapper alongside `mappedColumns` causes a
   generic `400` — omit it.
4. ~~**The project's workflow may be shared, not project-local.**~~ **Settled,
   does not trigger.** §0.1: a fresh company-managed project gets its own
   project-specific workflow, workflow scheme, issue type scheme, and issue
   type screen scheme, all named after the project key, none shared.
5. ~~**Global transitions may need one call or twenty.**~~ **Settled, one
   call.** §0.4: the simplified-Kanban preset ships fully undirected already
   (every starting transition is `type: GLOBAL`), and each new status needs
   exactly one added `GLOBAL` transition, bundled into the same
   `workflows/update` call as the status addition.
6. ~~**Company-managed teardown may orphan objects.**~~ **Settled, and it
   does.** §0.7: the soft `DELETE /project` leaves the workflow, workflow
   scheme, issue type scheme, and issue type screen scheme all orphaned for a
   60-day trash window, still colliding by name. Even the async
   `POST /project/{key}/delete` cascade-delete (a different endpoint,
   `Administer Jira`-gated, needs task-polling) only takes the two scheme
   objects with it — the workflow scheme and workflow still need two explicit
   `DELETE`s afterward, in that order. **This makes find-or-create mandatory,
   not optional, for every object §6 touches** — a project recreated after
   deletion will hit these orphans within the retention window. A `--purge`
   flag on `jira-configure-project` that runs the full cascade is worth
   building rather than leaving cleanup to Atlassian's 60-day timer.
7. ~~**Classic Kanban template's default column names are unknown.**~~
   **Settled.** §0.1: this site's template starts with `Backlog / Selected for
   Development / In Progress / Done` — no `To Do` at all. §3 step 6 revised to
   find-or-create three statuses (`Draft`, `To Do`, `In Review`), not two.
8. **Jira Cloud Free may cap company-managed projects.** Believed not,
   confirmed in §0 — creating `FCX` on the free-tier `carpetsquare.atlassian.net`
   site hit no plan-level restriction.

## 10. Phases

1. ~~**Phase 0 — measure.**~~ **Done.** Real site, throwaway company-managed
   `FCX` project, every probe in §0 run and recorded, project deleted and its
   orphans cleaned up (§0.7). Every remaining phase can proceed as designed —
   nothing forces a fallback branch.
2. ~~**Template swap + Task-default scheme.**~~ **Done.** `create_project` uses
   `COMPANY_MANAGED_KANBAN_TEMPLATE_KEY`; `resolve_task_issue_type` and
   `ensure_scheme_defaults_to_task` script the scheme.
3. ~~**Workflow statuses + global transitions.**~~ **Done.** `find_or_create_status`,
   `resolve_project_workflow` and `ensure_statuses_in_workflow` add `Draft` /
   `To Do` / `In Review` to the workflow with `GLOBAL` transitions, per the
   exact §0.4 schema.
4. ~~**Board column mapping.**~~ **Done.** `resolve_board_id` and
   `ensure_board_columns` PUT `rapidviewconfig/columns`; the degrade-to-print
   fallback is kept defensively in `_install` but was not needed on the
   measured classic board.
5. ~~**`--configure-project` CLI + tests.**~~ **Done.** `configure_project`
   orchestrates steps 5–7 and is shared by `_install` and the new
   `_configure_project` (`--configure-project`, `--purge`); the fake server in
   `backend/tests/test_queue_source_jira.py` grew scheme/status/workflow/
   board/purge routes and 7 new test classes covering idempotency, exact-name
   matching, pre-existing-status preservation, `500` degradation and
   purge task-polling — 78 tests pass.
6. ~~**Docs.**~~ **Done.** `backend/CLAUDE.md`'s Jira section rewritten for
   company-managed; cross-plan notes added to `work-queue-as-a-jira-board.md`
   (§2, §7, §13) and `jira-repository-picker.md` (§0.3, §3); `just --list`
   picks up `jira-configure-project` from its comment.

## 11. Success criteria

- `just install-jira-queue` on a clean site creates a company-managed project
  and leaves `just jira-status` reporting all five columns present, with nothing
  printed but "point the extension at the board".
- A card created by hand on the board defaults to `Task`, with the other
  standard types still offered.
- The run moves a card To Do → In Progress → In Review → To Do with no
  `No transition` error.
- Re-running `just install-jira-queue` changes nothing and prints nothing new.
- The column PUT (§0.5) is confirmed to work on a classic board; the
  degrade-to-print fallback stays in the code defensively (an untested board
  shape, a future API change) but is not expected to fire in practice.
- `just jira-configure-project` repairs a project whose scheme, workflow or
  columns have drifted, without touching the credential or the settings mirror,
  and its `--purge` mode (§9, risk 6) cascades a deleted project's orphaned
  workflow scheme and workflow rather than leaving them to Atlassian's 60-day
  timer.
