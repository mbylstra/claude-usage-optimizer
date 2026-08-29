# Plan: implement the Jira repository picker

Implements `plans/jira-repository-picker.md`, revised for the queue project
already being **company-managed** (`plans/company-managed-jira-project.md` is
shipped). Read that plan for the full rationale; this is the execution plan.

## Context

Today, aiming a queued Jira card at an existing repo means typing
`REPO: ~/code/current/foo` as the first line of the card's description — free
text, on a phone, from memory, and a typo silently starts a brand-new project.

`plans/jira-repository-picker.md` adds a **repository picker**: a single-select
custom field ("Repository") on the Jira card, whose option list is managed from
the extension's Settings page (name + local path per row) and pushed to Jira
whenever settings are saved. Choosing a repo on a card becomes a click.

The queue project is **already company-managed** (`queue_source_jira.py` uses
`COMPANY_MANAGED_KANBAN_TEMPLATE_KEY` and scripts scheme/workflow/columns end to
end). That supersedes the picker plan's **§3 "one step that has to stay
manual"**: on a company-managed project the field *can* be attached to the card
layout over the public REST API (measured in
`plans/company-managed-jira-project.md` §0.6:
`issuetypescreenscheme/project` → screen scheme → `screens.default` →
`GET /screens/{id}/tabs` → `POST /screens/{id}/tabs/{tabId}/fields`). So the
attach is scripted with the same find-or-create discipline as everything else —
there is **no printed manual step**.

Only the repo **name** ever reaches Jira. The **path** stays in the local
settings mirror and is resolved on the machine that runs the work, exactly like
`newProjectsDirectory`.

## Design decisions carried from the plan

1. **Name/path split; path never leaves the machine** (§1). Jira's option is one
   string — the name. Path resolution is entirely local.
2. **Soft-disable, never delete, a removed repo's option** (§2) — a deleted
   option blanks the field on every card that had it selected. Re-adding a name
   re-enables the same option.
3. **The field wins over `REPO:` when both are present; `REPO:` stays the
   fallback** (§4). Unmatched selected name behaves exactly like "no field".
4. **Sync rides on every settings save**, not just `install-jira-queue` (§5).
5. **A sync failure never fails the settings save** (§5) — mirrors the
   credential probe: Jira unreachable is an ordinary state.
6. **New:** the screen-attach chain (superseded §3) is folded into
   `ensure_repository_field` — idempotent, find-or-create, runs on install and
   on every settings save alongside field creation.

## Files & changes

### Backend — `backend/queue_source_jira.py`

New module constants:
- `REPOSITORY_FIELD_NAME = "Repository"`
- select field type `com.atlassian.jira.plugin.system.customfieldtypes:select`
- searcher key `...:multiselectsearcher` (measured working for single-select; the
  obvious `selectsearcher` 400s — picker plan §0.1)

New `@dataclass(frozen=True) RepositoryFieldSync`: `ok`, `field_id`,
`created_field`, `attached_to_screen`, `added: list[str]`, `disabled: list[str]`,
`reenabled: list[str]`, `error: str | None`.

New functions (all find-or-create / diff-and-patch, none raise on a Jira write
failure — they report):
- `find_repository_field(client) -> dict | None` — `GET /rest/api/3/field`,
  case-insensitive exact name match. Same discovery discipline as
  `resolve_project_statuses` / `_find_issue_type_scheme_by_name`.
- `ensure_repository_field(client, project_id, log) -> tuple[str, str, bool, bool]`
  → `(field_id, context_id, created_field, attached)`. Creates the field with the
  measured shape when absent; reads back its one auto-created context
  (`GET /rest/api/3/field/{id}/context`); then calls
  `attach_repository_field_to_screens`.
- `attach_repository_field_to_screens(client, project_id, field_id, log) -> bool`
  — the company-managed §0.6 chain:
  `GET /rest/api/3/issuetypescreenscheme/project?projectId=` →
  `GET /rest/api/3/issuetypescreenscheme/{id}/mapping` (default mapping's
  `screenSchemeId`) → `GET /rest/api/3/screenscheme?id=` → `screens.default` →
  `GET /rest/api/3/screens/{id}/tabs` → `POST /rest/api/3/screens/{id}/tabs/{tabId}/fields`
  `{"fieldId": field_id}`. Treats the specific `400 "field ... already exists on
  the screen"` as success (idempotent — measured in §0.6). Attaches to every
  distinct default screen it finds. Returns whether a POST landed.
- `sync_repository_field(client, project_id, repositories, log) -> RepositoryFieldSync`
  — `ensure_repository_field`, then read options
  (`GET /rest/api/3/field/{id}/context/{cid}/option`) and diff **by name**:
  missing desired name → `POST .../option` (`disabled: false`);
  Jira option not desired and enabled → `PUT .../option` `disabled: true`;
  desired name currently disabled → `PUT` re-enable. Wrapped so any
  `JiraError`/`QueueUnavailable` returns a `RepositoryFieldSync(ok=False,
  error=...)` rather than propagating.
- `sync_repositories_if_configured(settings, log) -> dict | None` — reads the
  stored credential itself (never passed from the extension), no-ops with a
  logged line when there is no credential or no project key (mirrors
  `probe_jira_credential`'s early return), else resolves the project id
  (`find_project` → `id`) and calls `sync_repository_field`; returns the sync as
  a plain dict for the host response. Never raises.

`prompt_from_issue(issue, repository_field_id=None, repositories=None)` — new
optional params. When the field is present on the issue
(`fields[repository_field_id]` is a `{"value": "..."}` dict), match `value`
case-insensitively against `repositories` → resolved `path`
(`Path(os.path.expanduser(path))`). Field selection wins over a `REPO:` line;
"no match" / "field unset" falls through to the existing
`_split_repository_line` behaviour unchanged.

`JiraQueueSource`:
- `__init__` gains `repositories=None`; resolves `repository_field_id` once
  (lazy, like `statuses()`) via `find_repository_field`, caching it; tolerates a
  `JiraError` by treating the field as absent (log + fall back to `REPO:`).
- `_search` adds the resolved field id to the JQL `fields` list.
- `_entry_from_issue` passes `repository_field_id` + `self.repositories` into
  `prompt_from_issue`.

`configure_project` — gains `repositories=()` param; new final step calls
`sync_repository_field` and logs its result (field created / attached / options
synced). Reached by both `_install` and `_configure_project`.

`_install` / `_configure_project` — read `settings.repositories`, pass to
`configure_project`. `_install`'s closing print gets one line: the Repository
field is created and on the card layout; add repos in Settings. **No manual
step** (§3 superseded — say so in a comment referencing
`plans/company-managed-jira-project.md` §0.6).

CLI — new `--sync-repositories` mode → `_sync_repositories()`: load configured
credential + project key + `settings.repositories`, resolve project id, call
`sync_repository_field`, print the diff. Add to `main()`'s mutually-exclusive
group, mirroring `--probe-adf`'s "run it by hand and see" role.

### Backend — `backend/autonomous_work_settings.py`

- `DEFAULT_REPOSITORIES = []`; `repositories: list = dataclass_field(default_factory=list)`
  on `AutonomousWorkSettings` (plain-dict shape, like `jira_status_names`).
- `parse_settings` — parse `settings_data.get("repositories")`: keep only dicts
  shaped `{"name": <non-empty str>, "path": <str, may be "">}`; drop the rest.
- `write_settings` — `"repositories": [dict(r) for r in settings.repositories]`.
- `main()` — print the repo list when `queue_source == jira` and non-empty.

### Backend — `backend/usage-host.py`

`apply_autonomous_work_settings` — after `apply_settings`, when
`settings.queue_source == QUEUE_SOURCE_JIRA`, call
`queue_source_jira.sync_repositories_if_configured(settings, log=log_message)`,
log the result, and add `"repositorySync": <result or None>` to the returned
dict (alongside `launchAgentUpdated`).

### Backend — `backend/run-autonomous-work.py`

`build_queue_source` — pass `repositories=_settings.repositories` to
`JiraQueueSource(...)`.

### Extension — `chrome-extension/lib/settingsTypes.ts`

- `export interface RepositoryOption { name: string; path: string }`
- `repositories: RepositoryOption[]` on `AutonomousWorkSettings`;
  `DEFAULT_REPOSITORIES: RepositoryOption[] = []` in
  `DEFAULT_AUTONOMOUS_WORK_SETTINGS`.
- `normaliseExtensionSettings` — `normaliseRepositories(stored)` helper mirroring
  `normaliseJiraStatusNames`: array in, keep entries whose `name` is a non-empty
  string, coerce `path` to a string (default `""`).

### Extension — `chrome-extension/components/SettingsPage.tsx`

New `usesJira`-gated block, styled like the existing "Renamed columns"
`<details>`: a "Repositories" list of Name / Path row pairs with a remove button
per row and an "Add repository" button. Immutable handlers
(`handleRepositoryChange(index, key, value)`, add, remove) over
`autonomousWorkSettings.repositories`. Help text: only the name is sent to Jira;
the path is expanded on the machine that runs the work.

### Extension — popup-visible sync feedback (plan §5)

- **`chrome-extension/extension/usageSnapshotExporter.ts`** —
  `syncAutonomousWorkSettings` already spreads the settings object, so
  `repositories` crosses with no change. Extend `AutonomousWorkSettingsSyncResult`
  with `repositorySync?: { ok: boolean; added: string[]; disabled: string[];
  reenabled: string[]; error?: string }` and read it out of the host response
  (the `repositorySync` key `apply_autonomous_work_settings` now returns).
- **`chrome-extension/extension/serviceWorker.ts`** (~line 352) — the
  `SyncAutonomousWorkSettingsResponse` relayed to the popup carries
  `repositorySync` through.
- **`chrome-extension/lib/autonomousWorkSettingsStatus.ts`** — add an optional
  `repositorySync` payload to the `scheduled` and `savedWithoutSchedule`
  variants; `describeAutonomousWorkSettingsStatus` appends one clause:
  `Synced 'new-repo' to Jira.` / `Removed 'old-repo' from the Jira dropdown.` /
  `Could not reach Jira — repositories not synced.` (nothing appended when the
  sync did nothing or was not applicable). Cover the new clauses in the existing
  `autonomousWorkSettingsStatus` unit test.
- **`chrome-extension/popup/PopupRoot.tsx`** (~line 311) — pass
  `response.repositorySync` into the `scheduled` / `savedWithoutSchedule` status
  objects it sets.

### `justfile`

`jira-sync-repositories` recipe → `python3 {{ jira_script }} --sync-repositories`,
beside the other `jira_script` recipes (comment picked up by `just --list`).

### Docs — `backend/CLAUDE.md` ("The Jira half")

New paragraph parallel to the columns one: the `Repository` field is created and
attached to the card layout by `install-jira-queue` (company-managed makes the
screen attach scriptable — no manual step), and kept in sync by every settings
save; only the repo *name* reaches Jira, never the path; options are
soft-disabled, never deleted.

## Tests

### `backend/tests/test_queue_source_jira.py`

Extend `FakeJiraState` + `_Handler` with routes:
`GET|POST /rest/api/3/field`, `GET /rest/api/3/field/{id}/context`,
`GET|POST|PUT /rest/api/3/field/{id}/context/{cid}/option`,
`GET /rest/api/3/issuetypescreenscheme/project`,
`GET /rest/api/3/issuetypescreenscheme/{id}/mapping`,
`GET /rest/api/3/screenscheme`, `GET /rest/api/3/screens/{id}/tabs`,
`POST /rest/api/3/screens/{id}/tabs/{tabId}/fields` (with the "already exists"
`400` branch). Model the field, its context, and its options in `state`.

New test classes:
- **RepositoryFieldTests** — created once with the measured searcher key; second
  call is a no-op; name match is case-insensitive; an existing field is found,
  not recreated.
- **RepositoryFieldScreenAttachTests** — attached to the default tab; the
  "already exists" `400` is treated as success; a second call issues no POST.
- **RepositoryOptionSyncTests** — adds only missing names; soft-disables a
  removed name (asserts **no DELETE**); re-enables a re-added name; matches by
  name; a forced write failure yields `RepositoryFieldSync(ok=False, error=...)`
  and does not raise.
- **PromptFromIssueRepositoryFieldTests** — field selection wins over a `REPO:`
  line; an unmatched selected name falls back to `REPO:` then to a new project;
  field unset uses `REPO:`.
- Extend **ConfigureProjectOrchestrationTests** — the field is created during
  `configure_project`, and a second call writes nothing new (idempotency now
  includes the field + options + screen attach).

### `backend/tests/test_autonomous_work_settings.py`

`repositories` round-trips through `parse_settings` / `write_settings`; a
name-less or wrongly-shaped entry is dropped; default is `[]`.

### Extension

Add `repositories` normalisation cases to the existing `settingsTypes`
normaliser test (array in / bad entries dropped / path coerced to string).

## Execution order

1. Backend Jira: `find_repository_field`, `ensure_repository_field`,
   `attach_repository_field_to_screens`, `sync_repository_field`,
   `sync_repositories_if_configured`, `--sync-repositories`, fake-server routes +
   the four new test classes.
2. Settings plumbing: `autonomous_work_settings.py` + `settingsTypes.ts` +
   normaliser tests.
3. `prompt_from_issue` + `JiraQueueSource` threading + `build_queue_source` +
   tests.
4. Trigger: `usage-host.py` `sync_repositories_if_configured` wiring + response.
5. `SettingsPage.tsx` list editor + the popup-visible sync feedback chain
   (`usageSnapshotExporter.ts` → `serviceWorker.ts` → `autonomousWorkSettingsStatus.ts`
   → `PopupRoot.tsx`) + its unit test.
6. `justfile` recipe + `backend/CLAUDE.md` paragraph.
7. `just check` + `backend/tests/run_tests.py` + extension tests all green.

## Verification

- `python3 backend/tests/run_tests.py` — all backend tests, including the new
  Jira and settings cases.
- `just check` — typecheck + lint + format for the extension.
- Manual against the real site (not automatable — same stance as
  `probe-jira-adf`): `just jira-sync-repositories` after adding a repo in
  Settings creates the `Repository` field, attaches it to the Task card layout,
  and adds the option; re-running changes nothing; removing the repo and
  re-running disables (not deletes) the option; a card with the field set runs
  the prompt in that repo with no `REPO:` line; `just install-jira-queue` on a
  fresh site prints no manual step for the field.
