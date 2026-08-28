# Plan: Pick a repository from a list, on a Jira card

## Goal

Today, pointing a queued prompt at an existing repository means typing
`REPO: ~/code/current/claude-usage-optimizer` as the first line of a Jira
card's description — free text, on a phone, from memory, with a typo silently
starting a brand-new project instead of running against the one you meant.

This adds a **repository picker**: a single-select dropdown on the Jira card
itself, populated from a list the extension's Settings page manages. The list
is edited where every other autonomous-work setting already lives — name and
path, one row per repository — and pushed to Jira as the option list of one
custom field whenever settings are saved. Choosing a repo on a card becomes a
click on the board, the same way choosing a column already is.

Non-goals: a picker for the file queue (`prompts.txt` has no UI to pick
anything from — REPO: stays its only mechanism); reordering or deleting a
repository's Jira option the moment it's removed from the list (see §3, soft
disable, not delete); anything that sends an absolute filesystem path to
Jira (see §1).

## 0. What was measured, against the real site

Before designing around it, the mechanism was probed directly against
`carpetsquare.atlassian.net` — FCP, the same team-managed project the queue
already uses — with the stored API token, creating and then deleting a real
field. Three things came back that the plan below is built on, not assumed:

1. **Field creation works over the stored token.** `POST /rest/api/3/field`
   with `type: com.atlassian.jira.plugin.system.customfieldtypes:select`
   succeeds — but only with
   `searcherKey: com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher`.
   The searcher name Atlassian's own examples suggest for a _single_-select
   (`selectsearcher`) does not exist and 400s. This is exactly the kind of
   thing CLAUDE.md means by "measure, do not reason" — the working value was
   found by trying it, not by reading a name that looked right.
2. **The field's context is always global, and cannot be narrowed.**
   `PUT /field/{id}/context/{contextId}/project` 400s with
   `the global context cannot be made non-global`. Harmless here — a single
   personal site with one queue project — but worth knowing: the field could
   in principle be added to the layout of any of the other 17 projects on this
   site, not just FCP. Nothing does that automatically.
3. **The field never appears on FCP's card layout on its own.** Even fully
   created, contexted and populated with options, `issue/createmeta` for
   FCP/Task came back with no trace of it, and the classic
   `issuetypescreenscheme/project` endpoint 400s outright — team-managed
   projects don't expose that model over the public API at all. This is the
   same shape as the board-columns gap `just install-jira-queue` already
   prints a manual step for (§3 there: "Jira Cloud exposes no documented REST
   route"). Adding a field to a team-managed layout is a UI-only action.

Adding and soft-disabling options (`POST`/`PUT`
`/field/{id}/context/{contextId}/option`) both worked cleanly and are fully
scriptable. Deleting the probe field worked too, despite `DELETE` answering
with an odd `303` rather than `204` — confirmed gone by a follow-up `GET`
coming back `404 Field not found`, and by a field search finding nothing.

## 1. Where the list lives, and why it carries a name _and_ a path

`chrome-extension/lib/settingsTypes.ts` gains one field on
`AutonomousWorkSettings`:

```ts
export interface RepositoryOption {
  /** Shown on the Jira card's dropdown. Never a path — see below. */
  name: string;
  /** Expanded on the machine that runs the work, `~` and all — same
   *  convention as `newProjectsDirectory`. Never sent to Jira. */
  path: string;
}

repositories: RepositoryOption[];
```

**Only `name` ever reaches Jira.** The option a card carries is a string
picked from a dropdown, and Jira has no second column to put a path in even if
we wanted one — a single-select option is one value. Splitting the two here,
rather than trying to encode both into one Jira-visible string, keeps an
absolute local path (which can carry a username, a company name, anything)
off a board that this plan does nothing to make private, and matches the
existing rule that a path is "the text the user typed... expanded on the
machine that runs the work" — `newProjectsDirectory` already works this way,
never leaving the settings mirror. `path` resolution stays entirely local:
Jira only ever sees which repo, never where it lives.

The Settings page section (new block in `SettingsPage.tsx`, shown only when
`queueSource === 'jira'`, next to the Jira project key and column-rename
fields) is a simple two-column list — Name, Path — with add/remove rows, no
different in kind from the `jiraStatusNames` rename fields already there.

## 2. The Jira side: one field, synced on save, never written to per-card

`backend/queue_source_jira.py` gains:

```python
REPOSITORY_FIELD_NAME = "Repository"

@dataclass(frozen=True)
class RepositoryFieldSync:
    ok: bool
    field_id: str | None       # e.g. "customfield_10210"
    created_field: bool
    added: list[str]
    disabled: list[str]
    reenabled: list[str]
    error: str | None


def find_repository_field(client) -> dict | None:
    """Case-insensitive exact match on name, discovered not hard-coded —
    the same reason `resolve_project_statuses` doesn't hard-code status IDs.
    A field ID is per-site and only known after creation or lookup."""


def ensure_repository_field(client) -> tuple[str, str, bool]:
    """(field_id, context_id, created). Creates the field with the measured
    working shape from §0 if find_repository_field returns nothing, then reads
    back its one auto-created context."""


def sync_repository_field(client, repositories, log=_ignore) -> RepositoryFieldSync:
    """Ensure the field exists, then diff its current options against
    `repositories` by name:

    - a desired name absent from Jira -> POST to add it, enabled
    - a Jira option absent from `repositories`, currently enabled -> PUT
      `disabled: true` — never DELETE (see below)
    - a Jira option present in `repositories` but currently disabled ->
      PUT `disabled: false`, in case a repo was removed and re-added later

    Never raises — like every Jira write path in this module, a sync that
    cannot land is reported, not thrown, so a save never fails because Jira is
    unreachable.
    """
```

**Soft-disable, never delete an option.** A deleted option blanks the field on
every card that had it selected — silently turning "point this at repo X"
into "point this at nothing" the moment you remove X from the settings list,
which is a worse outcome than a stale, disabled entry sitting unused in the
dropdown. Re-adding the same name later re-enables the same option rather than
creating a duplicate, which is why the diff matches by name rather than
always appending.

**This never writes to an issue.** Only `sync_repository_field`'s options
change; no card's field value is set by anything in this codebase. Setting it
is a human clicking the dropdown when they create or edit a card — the same
division CLAUDE.md already draws for descriptions ("the run only ever reads
descriptions and never writes them").

## 3. The one step that has to stay manual

Per §0.3, nothing over the API can put `Repository` onto FCP's card layout.
`just install-jira-queue` calls `sync_repository_field` once, with whatever
`repositories` already holds (usually empty, on a fresh install — the field
still gets created, with no options yet), then prints the same shape of
message it already prints for columns:

```
2. Add the field to the card layout by hand. Measured, not assumed: the field
   and its options can be created over the API, but attaching a field to a
   team-managed project's issue layout has no route we could find — the same
   gap this recipe already hits for board columns.
   Open https://carpetsquare.atlassian.net/jira/software/projects/FCP/settings/issuetypes
   then Task -> drag 'Repository' from the field palette onto the layout.
   (repeat for Bug/Story/Feature too, if you create cards of those types)
```

One-time, a few seconds, the same category of cost as adding the two board
columns already is.

## 4. Reading it back: the field wins, `REPO:` still falls back

`prompt_from_issue` (§ existing, `_split_repository_line` +
`prompt_from_issue`) gains the repository field as an input, resolved by the
caller once per run rather than looked up per card:

```python
def prompt_from_issue(issue, repository_field_id, repositories):
    # type: (dict, str | None, list[RepositoryOption]) -> tuple[str, Path | None]
    """Prefers the selected option's `name`, matched case-insensitively
    against `repositories` to find its `path`. Falls through to the existing
    `REPO:` line (description, then summary) when the field is absent, unset,
    or its selected name no longer matches any configured repository — a
    renamed or deleted entry in Settings must not point a queued prompt at
    the wrong place, so "no match" behaves exactly like "no field": either
    starts a new project via `resolve_working_directory`, same as today.
    """
```

`repository_field_id` is resolved once per run by `find_repository_field`
(§2) and threaded through, the same way `resolve_project_statuses` resolves
status IDs once rather than per card — and the JQL search that fetches To Do
cards adds that field ID to its `fields` list alongside summary and
description, so no extra round trip is needed to read the selection.

A card with **both** a field selection and a `REPO:` line prefers the field —
the field is the deliberate, current-intent choice; the text line is legacy.

## 5. The trigger: settings save, not `install-jira-queue` alone

`backend/usage-host.py`'s `apply_autonomous_work_settings` — already the
synchronous, on-the-message-loop handler for every settings save, and already
where `probe_jira_credential`'s daily check lives for the identical reason
("Chrome tears this process down as soon as it has the reply") — gains one
more best-effort call after `apply_settings`:

```python
if settings.queue_source == autonomous_work_settings.QUEUE_SOURCE_JIRA:
    sync_result = sync_repositories_if_configured(settings, log=log_message)
```

`sync_repositories_if_configured` reads the stored credential itself (never
sent from the extension — same rule the credential already follows
everywhere else in this codebase), no-ops with a logged line if there is no
credential or no project key yet (mirrors `probe_jira_credential`'s early
return), and otherwise calls `sync_repository_field`.

The result rides back on the same response `apply_autonomous_work_settings`
already returns, alongside `launchAgentUpdated`:

```json
{
  "ok": true,
  "launchAgentUpdated": true,
  "repositorySync": { "ok": true, "added": ["new-repo"], "disabled": [] }
}
```

so the popup can show _"Synced 'new-repo' to Jira"_ or _"Could not reach
Jira — repositories not synced"_ next to the save confirmation, rather than
a save silently not doing the Jira half of its job.

## 6. Code changes, file by file

- **`chrome-extension/lib/settingsTypes.ts`** — `RepositoryOption`,
  `repositories: RepositoryOption[]` on `AutonomousWorkSettings`, default
  `[]`, and the matching branch in `normaliseExtensionSettings` (drop any
  entry missing a non-empty `name`; `path` may be empty — a name-only row is a
  draft, not yet buildable into a working directory, the same tolerance
  `newProjectsDirectory` gives an empty string today by falling back to the
  default).
- **`chrome-extension/components/SettingsPage.tsx`** — the list editor,
  gated on `usesJira`, next to the existing Jira fields.
- **`backend/autonomous_work_settings.py`** — `repositories: list[dict]` on
  the dataclass (mirroring the plain-dict shape `jira_status_names` already
  uses rather than inventing a second nested dataclass the JSON round-trip
  has to know about), parsed defensively in `parse_settings` (drop anything
  not shaped like `{"name": str, "path": str}`), written in `write_settings`.
- **`backend/queue_source_jira.py`** — `find_repository_field`,
  `ensure_repository_field`, `sync_repository_field`, `RepositoryFieldSync`;
  `prompt_from_issue` takes the two new parameters (§4); `_install` calls
  `sync_repository_field` and prints the layout step (§3); a new
  `--sync-repositories` CLI mode for `just jira-sync-repositories`, mirroring
  `--probe-adf`'s "run it by hand and see" role, useful for checking a sync
  without waiting for a settings save.
- **`backend/usage-host.py`** — `apply_autonomous_work_settings` calls
  `sync_repositories_if_configured` after `apply_settings` (§5), and logs its
  result the same way it already logs everything else about a settings
  message.
- **`justfile`** — `jira-sync-repositories`, next to the other
  `jira_script` recipes.
- **`CLAUDE.md`** — a new paragraph under "The Jira half", parallel to the
  existing columns paragraph: the field is created once by
  `install-jira-queue` and kept in sync by every settings save; attaching it
  to a card layout is the one manual step, for the same reason columns are;
  only the repository _name_ ever reaches Jira, never a path.

## 7. Decisions taken

1. **Name and path split, path never leaves the machine.** §1 — the smaller
   surface (one string) is also the safer one (no absolute path on a board).
2. **Soft-disable over delete for a removed repository's option.** §2 — a
   card that already picked it must not go silently blank.
3. **The field wins over `REPO:` when both are present; `REPO:` remains the
   fallback, not replaced.** §4 — existing cards written before this feature
   keep working with no migration, and the file queue is entirely unaffected
   (it has no field to read).
4. **Sync rides on every settings save, not only on `install-jira-queue`.**
   §5 — the whole point is that the list is a living thing edited in the
   popup; a sync path that only ran once at install would leave every repo
   added afterwards invisible in Jira until someone remembered to re-run the
   recipe by hand.
5. **A sync failure never fails the settings save.** Matches the credential
   probe's own rule: Jira being unreachable is an ordinary state, not a fault,
   and the schedule/model/pace settings must land regardless.

## 8. Risks and unknowns

- **The field is global, not project-scoped (§0.2).** Only a wrinkle on a
  single-project site; if this queue is ever pointed at a second Jira
  project, or another project's admin notices a "Repository" field they
  didn't create, that's the cost of the API's own limitation, not a choice
  made here.
- **`searcherKey` behaviour is unverified beyond what §0 measured once.** If
  Atlassian changes the accepted searcher keys, `ensure_repository_field`'s
  creation call breaks; `find_repository_field` finding an already-created
  field is unaffected, so a working install never re-hits this path.
- **A renamed repository entry in Settings orphans its old Jira option.**
  Renaming is indistinguishable from "remove the old one, add a new one" to
  the diff in §2 — the old name gets soft-disabled, the new one added as
  fresh. Any card that had picked the old name keeps that now-disabled value
  selected (Jira does not clear a field when its option is disabled) but it
  will no longer match anything in `repositories` at read time, so §4's
  fallback treats it as unset. Acceptable: renaming a repo in Settings and
  expecting every card that already pointed at it to silently follow is a
  bigger feature than this plan sets out to build.
- **Team-managed layout behaviour is per-issue-type.** The manual step in §3
  only covers Task by default; a card created as a Bug or Story will not show
  the field unless the same drag is repeated for that type too. Worth a line
  in the printed instructions, not worth automating a loop over every issue
  type at install.

## 9. Phases

1. **Jira side, scriptable and testable without touching the extension** —
   `find_repository_field`, `ensure_repository_field`, `sync_repository_field`
   in `queue_source_jira.py`, unit-tested against a fake `JiraClient` the way
   `resolve_project_statuses` already is; `--sync-repositories` CLI mode.
2. **Extension settings** — `RepositoryOption`, the new field and its
   normaliser, the Settings page section, mirrored to
   `autonomous-work-settings.json` via the existing spread-based
   `syncAutonomousWorkSettings` (CLAUDE.md's warning about naming fields
   individually there instead of spreading applies as much to this field as
   any other).
3. **The trigger** — `apply_autonomous_work_settings` calling
   `sync_repositories_if_configured`, its result riding back to the popup.
4. **Reading it back** — `prompt_from_issue`'s two new parameters, the field
   ID threaded into the JQL `fields` list, tests for: field wins over
   `REPO:`, `REPO:` used when the field is unset, an unmatched selected name
   falling through to "no repo" rather than erroring.
5. **`install-jira-queue`** — calls the sync once, prints the layout step
   from §3.
6. **Docs** — CLAUDE.md's Jira-half paragraph, `just --list` picks up the new
   recipe automatically from its comment.

## 10. Success criteria

- Adding a repository (name + path) in Settings and saving creates the
  `Repository` field on first run, or adds the option on every run after —
  either way, no duplicate fields and no duplicate options.
- Removing a repository from Settings and saving disables its Jira option
  without deleting it, and a card that already had it selected keeps
  showing that value (disabled, not blanked) until edited.
- A card with the field set to a name that matches a configured repository
  runs the queued prompt in that repository's path, with no `REPO:` line
  needed.
- A card with the field unset, or set to a name no longer in the list, falls
  back exactly as today: `REPO:` line if present, otherwise a new project.
- `just install-jira-queue` on a fresh site creates the field and prints the
  layout step; run again, it changes nothing and prints nothing new.
- A settings save while Jira is unreachable still applies every other
  setting, and logs the sync failure without surfacing it as a save failure.
