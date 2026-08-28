#!/usr/bin/env python3
"""The work queue as a Jira board — see `plans/work-queue-as-a-jira-board.md`.

Five columns (Draft, To Do, In Progress, In Review, Done) in a team-managed
Jira Software project. The run reads the To Do column `ORDER BY Rank ASC`, moves
the card it is working on into In Progress, and writes Claude's own account of
what it did back onto the card as a comment.

**Why the board, and not the file.** Reordering a queue is a direct-manipulation
gesture, and Jira's data model is a ranked queue — dragging a card *is* the
reorder, `ORDER BY Rank ASC` *is* the read. Nothing is synced, so there is no
merge and no conflict window; an issue key is a stable identity, so the
line-index fragility the file source lives with disappears; and status is a
column, so re-queueing a failed prompt is a drag rather than a text edit.

**Constraints this module inherits, and cannot negotiate:**

* **stdlib-only, and 3.9-compatible.** `usage-host.py` imports the credential
  half of this file for §5.4's daily probe, and Chrome spawns that host with an
  environment we do not control. `urllib.request` is already in the box; an HTTP
  library would fail in ways that are near-undebuggable from inside a browser.
* **Underscores in the filename**, because `run-autonomous-work.py` imports it.
* **The run reads descriptions and never writes them**, which is what makes the
  ADF flattening in `flatten_adf` a one-way conversion that cannot corrupt
  anything. Only `import_prompts` writes a description, once, at migration.

**REST, not MCP.** MCP is a protocol for giving a *model* tools, and the
scheduler is not a model — picking the top-ranked To Do card is a deterministic
query with one right answer. MCP's place is inside the run, where there *is* a
model: read and comment on its own card, never transition it.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

import queue_source
from queue_source import (
    STATUS_COMPLETED,
    STATUS_DRAFT,
    STATUS_ERROR,
    STATUS_TODO,
    STATUS_UNMERGED,
    QueueEntry,
    QueueUnavailable,
    status_detail_of,
    status_name_of,
)

SCRIPT_DIRECTORY = Path(__file__).resolve().parent


def _environment_path(name, default):
    # type: (str, Path) -> Path
    raw_value = os.environ.get(name)
    return Path(os.path.expanduser(raw_value)) if raw_value else default


# Mode 0600, gitignored, and deliberately *not* on the settings mirror path: that
# file is a plaintext mirror the host rewrites and logs around, and a credential
# has no business sitting in `chrome.storage` at all. A file mode rather than the
# Keychain, because "can a LaunchAgent read the Keychain at 2 AM without a
# dialog" is an unmeasured unknown and this project has already lost a morning to
# an invisible dialog in front of an unattended job.
CREDENTIALS_FILE = _environment_path(
    "AUTONOMOUS_WORK_JIRA_CREDENTIALS_FILE", SCRIPT_DIRECTORY / "jira-credentials.json"
)
# What the daily probe found, read by the popup and by `just jira-status`.
STATUS_FILE = _environment_path(
    "AUTONOMOUS_WORK_JIRA_STATUS_FILE", SCRIPT_DIRECTORY / "jira-status.json"
)
# Outcomes that could not be written when the prompt finished, drained at the
# start of the next run. The expensive failure: an unrecorded outcome means the
# prompt runs again tomorrow.
PENDING_WRITES_FILE = _environment_path(
    "AUTONOMOUS_WORK_JIRA_PENDING_WRITES_FILE", SCRIPT_DIRECTORY / "jira-pending-writes.jsonl"
)

# Lets the tests point the whole transport at a local stub — the same trick
# AUTONOMOUS_WORK_LAUNCHCTL plays for the scheduling paths, and the reason every
# transition can be exercised without an Atlassian account.
BASE_URL_OVERRIDE = os.environ.get("AUTONOMOUS_WORK_JIRA_BASE_URL")

DEFAULT_PROJECT_NAME = "Free Claude Prompts"
DEFAULT_PROJECT_KEY = "FCP"
# Team-managed Jira Software with a Kanban board: there the board's columns *are*
# its statuses, so "add a column" and "add a status" are one gesture with no
# workflow, issue-type or screen scheme in between.
KANBAN_TEMPLATE_KEY = "com.pyxis.greenhopper.jira:gh-simplified-agility-kanban"

COLUMN_DRAFT = "draft"
COLUMN_TODO = "todo"
COLUMN_IN_PROGRESS = "inProgress"
COLUMN_IN_REVIEW = "inReview"
COLUMN_DONE = "done"

COLUMN_KEYS = (COLUMN_DRAFT, COLUMN_TODO, COLUMN_IN_PROGRESS, COLUMN_IN_REVIEW, COLUMN_DONE)

DEFAULT_STATUS_NAMES = {
    COLUMN_DRAFT: "Draft",
    COLUMN_TODO: "To Do",
    COLUMN_IN_PROGRESS: "In Progress",
    COLUMN_IN_REVIEW: "In Review",
    COLUMN_DONE: "Done",
}

# In Review holds both endings that need a human, told apart by a label: the
# column means *your turn*, and an unmerged branch and a failed prompt both are.
# A sixth column for failures would have said the same thing less usefully.
LABEL_UNMERGED = "claude-unmerged"
LABEL_ERROR = "claude-error"
RUN_LABELS = (LABEL_UNMERGED, LABEL_ERROR)

# Which column each queue status lands in. The `:detail` convention does not
# cross this boundary — `record_outcome` splits it, the status name picks the
# column and the branch goes in the comment — so no `:detail` parsing exists on
# the Jira side at all.
COLUMN_FOR_STATUS = {
    STATUS_TODO: COLUMN_TODO,
    STATUS_DRAFT: COLUMN_DRAFT,
    STATUS_COMPLETED: COLUMN_DONE,
    STATUS_ERROR: COLUMN_IN_REVIEW,
    STATUS_UNMERGED: COLUMN_IN_REVIEW,
}

# A card whose description opens with this names the repository to work in, the
# same way `REPO:` does in `prompts.txt` — unchanged, so a prompt can be moved
# between the two sources by copy and paste.
REPOSITORY_FIELD_PREFIX = queue_source.REPOSITORY_FIELD_PREFIX

REQUEST_TIMEOUT_SECONDS = 30
# The probe runs inside the native host, on the message loop, so it is held to a
# much shorter leash than the run's own calls: a host that sat for half a minute
# would look to the extension exactly like one that had died.
PROBE_TIMEOUT_SECONDS = 10
# A handful of calls per prompt makes rate limits irrelevant at this volume, but
# a 429 should be logged as itself rather than as a generic failure, and retried.
RATE_LIMIT_STATUS = 429
RATE_LIMIT_RETRY_SECONDS = 5
# The write after a prompt has run is the expensive one to lose, so it gets two
# more goes before it is set aside for the next run to drain.
OUTCOME_WRITE_ATTEMPTS = 3
OUTCOME_WRITE_BACKOFF_SECONDS = 3

# The one call the daily probe makes: cheap, and it fails distinctly for every
# way the credential can be wrong.
PROBE_PATH = "/rest/api/3/myself"
# Once a day is plenty for a credential whose expiry is a date, and the host is
# spawned every five minutes.
PROBE_INTERVAL_SECONDS = 24 * 60 * 60

EXPIRY_WARNING_DAYS = 30


def _ignore(message):
    # type: (str) -> None
    pass


# --------------------------------------------------------------------------- #
# Credentials
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class JiraCredentials:
    """HTTP Basic against the Jira Cloud REST API: an account email and an API token.

    An API token rather than OAuth, deliberately. Its cost is a hard one — since
    December 2024 every new Atlassian API token carries a mandatory expiry of at
    most a year, and there is no indefinite token — but that expiry is a
    **scheduled event with a date known at creation time**, which a warning
    system can turn into a calendar reminder. OAuth trades it for a rotating
    refresh token (raced by three processes here: two host connections and the
    launchd run) and a grant the user can revoke at any moment, neither of which
    announces itself.

    `token_expires_at` is recorded at paste time because the expiry is not
    readable back from any API — the user picks the date in the Atlassian UI.
    """

    site_url: str
    email: str
    api_token: str
    token_expires_at: "date | None" = None

    @property
    def base_url(self) -> str:
        return (BASE_URL_OVERRIDE or self.site_url).rstrip("/")

    @property
    def authorization_header(self) -> str:
        pair = "{}:{}".format(self.email, self.api_token)
        return "Basic " + base64.b64encode(pair.encode("utf-8")).decode("ascii")

    def days_until_expiry(self, today=None):
        # type: (date | None) -> int | None
        if self.token_expires_at is None:
            return None
        return (self.token_expires_at - (today or date.today())).days

    def describe(self) -> str:
        """Never the token. The site and the account are the identifying half."""
        return "{} as {}".format(self.site_url, self.email)


def _parse_date(value):
    # type: (object) -> date | None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.strptime(value.strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def read_credentials(credentials_file=None):
    # type: (Path | None) -> JiraCredentials | None
    """The stored credential, or None if there is not a usable one on disk.

    Never raises and never logs the token: a missing or malformed credential is
    an ordinary state — most installs have none — and the caller decides what to
    do about it.
    """
    path = credentials_file or CREDENTIALS_FILE
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict):
        return None

    site_url = stored.get("siteUrl")
    email = stored.get("email")
    api_token = stored.get("apiToken")
    if not (isinstance(site_url, str) and isinstance(email, str) and isinstance(api_token, str)):
        return None
    if not (site_url.strip() and email.strip() and api_token.strip()):
        return None

    return JiraCredentials(
        site_url=site_url.strip(),
        email=email.strip(),
        api_token=api_token.strip(),
        token_expires_at=_parse_date(stored.get("tokenExpiresAt")),
    )


def write_credentials(credentials, credentials_file=None):
    # type: (JiraCredentials, Path | None) -> Path
    """Replace the credential file atomically, mode 0600 from the moment it exists.

    The temp file is created with the final mode rather than chmod-ed afterwards,
    so there is no window in which the token is world-readable.
    """
    path = credentials_file or CREDENTIALS_FILE
    payload = {
        "siteUrl": credentials.site_url,
        "email": credentials.email,
        "apiToken": credentials.api_token,
    }
    if credentials.token_expires_at is not None:
        payload["tokenExpiresAt"] = credentials.token_expires_at.isoformat()

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        handle_descriptor, temporary_name = tempfile.mkstemp(dir=str(path.parent))
        temporary_path = Path(temporary_name)
        os.fchmod(handle_descriptor, 0o600)
        with os.fdopen(handle_descriptor, "w", encoding="utf-8") as temp_handle:
            json.dump(payload, temp_handle, indent=2)
            temp_handle.write("\n")
        os.replace(str(temporary_path), str(path))
        os.chmod(str(path), 0o600)
    except BaseException:
        if temporary_path is not None:
            try:
                os.unlink(str(temporary_path))
            except OSError:
                pass
        raise
    return path


# --------------------------------------------------------------------------- #
# Transport
# --------------------------------------------------------------------------- #


class JiraError(Exception):
    """A call that did not succeed, carrying the status code so the cause can be named.

    401, 403, 404 and "no network at all" are four different problems with four
    different fixes, and reporting them as one generic failure is how a renamed
    site or a lost project permission goes unnoticed for a fortnight.
    """

    def __init__(self, message, status_code=None, body=None):
        # type: (str, int | None, str | None) -> None
        super().__init__(message)
        self.status_code = status_code
        self.body = body

    @property
    def cause(self) -> str:
        """The short name for what went wrong, for the log, the popup and the badge."""
        if self.status_code == 401:
            return "unauthorised"
        if self.status_code == 403:
            return "forbidden"
        if self.status_code == 404:
            return "notFound"
        if self.status_code == RATE_LIMIT_STATUS:
            return "rateLimited"
        if self.status_code is None:
            # A laptop is offline most nights it is shut. This must never raise
            # an alarm on its own.
            return "unreachable"
        return "httpError"

    @property
    def explanation(self) -> str:
        """Jira's own account of what was wrong, out of the response body.

        A 400 from `POST /project` is the case that needs this: the status code
        says only "you asked for something impossible", and the body says which
        field and why. Reporting the code alone turns a one-line fix into an
        afternoon, so anything that reaches a person prints this too.
        """
        if not self.body:
            return ""
        try:
            decoded = json.loads(self.body)
        except ValueError:
            return self.body.strip()[:500]
        if not isinstance(decoded, dict):
            return self.body.strip()[:500]

        parts = [str(message) for message in decoded.get("errorMessages") or []]
        field_errors = decoded.get("errors")
        if isinstance(field_errors, dict):
            parts.extend(
                "{}: {}".format(field, message) for field, message in field_errors.items()
            )
        return "; ".join(parts) or self.body.strip()[:500]


# Everything a write to the board can fail with. `QueueUnavailable` belongs here
# as much as `JiraError` does: resolving the project's statuses is itself a call,
# and it is made lazily, so the first thing a write does may be the thing that
# discovers Jira is unreachable. No write path may take the run down — an
# outcome that will not land is set aside, never thrown.
WRITE_FAILURES = (JiraError, QueueUnavailable)


class JiraClient:
    """Just enough HTTP for this plan, over `urllib.request`.

    A 429 is retried once and logged as itself; nothing else is retried here —
    the write path above this one owns its own, longer, retry policy, because
    only it knows which failures are expensive.
    """

    def __init__(self, credentials, log=_ignore, timeout_seconds=REQUEST_TIMEOUT_SECONDS):
        # type: (JiraCredentials, object, int) -> None
        self.credentials = credentials
        self._log = log
        self.timeout_seconds = timeout_seconds

    def request(self, method, path, body=None, query=None):
        # type: (str, str, object, dict | None) -> object
        url = self.credentials.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)

        encoded_body = None
        if body is not None:
            encoded_body = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url=url, data=encoded_body, method=method)
        request.add_header("Authorization", self.credentials.authorization_header)
        request.add_header("Accept", "application/json")
        if encoded_body is not None:
            request.add_header("Content-Type", "application/json")

        for attempt in (1, 2):
            try:
                with urllib.request.urlopen(
                    request, timeout=self.timeout_seconds, context=ssl.create_default_context()
                ) as response:
                    raw = response.read().decode("utf-8")
                    if not raw.strip():
                        return None
                    return json.loads(raw)
            except urllib.error.HTTPError as error:
                error_body = ""
                try:
                    error_body = error.read().decode("utf-8", "replace")
                except Exception:  # noqa: BLE001 - the body is a nicety, never the point
                    pass
                if error.code == RATE_LIMIT_STATUS and attempt == 1:
                    wait_seconds = _retry_after_seconds(error) or RATE_LIMIT_RETRY_SECONDS
                    self._log(
                        "Jira rate-limited {} {} — retrying in {}s".format(
                            method, path, wait_seconds
                        )
                    )
                    time.sleep(wait_seconds)
                    continue
                raise JiraError(
                    "{} {} returned {}".format(method, path, error.code),
                    status_code=error.code,
                    body=error_body,
                )
            except (urllib.error.URLError, OSError, ValueError) as error:
                raise JiraError("{} {} failed: {}".format(method, path, error))

        raise JiraError("{} {} was rate-limited twice".format(method, path), RATE_LIMIT_STATUS)


def _retry_after_seconds(error):
    # type: (urllib.error.HTTPError) -> int | None
    raw_value = error.headers.get("Retry-After") if error.headers else None
    try:
        return max(1, int(str(raw_value).strip()))
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Atlassian Document Format
# --------------------------------------------------------------------------- #

# Nodes whose children are a block of prose, separated from their neighbours by a
# blank line rather than run together.
_ADF_BLOCK_NODES = (
    "paragraph",
    "heading",
    "blockquote",
    "listItem",
    "panel",
    "tableCell",
    "tableHeader",
)


def flatten_adf(document):
    # type: (object) -> str
    """A card's description as the plain text a prompt is meant to be.

    The v3 API returns descriptions as Atlassian Document Format — a JSON
    document tree — and dropped naively into the prompt builder that would hand
    Claude a blob of JSON. This walks the tree instead: text nodes concatenate,
    block nodes separate with a blank line, `codeBlock` keeps its content
    verbatim and `hardBreak` is a newline.

    Lossy in principle, safe in practice, and the reason is worth stating: the
    run **only ever reads** descriptions, so this is a one-way conversion rather
    than a round trip and it cannot corrupt what is stored. The worst case is a
    prompt that reads slightly differently from what was typed, never a card
    rewritten into something else.

    A plain string is passed through, so a v2 response — wiki markup — or a stub
    server's simpler shape needs no special casing at the call site.
    """
    if document is None:
        return ""
    if isinstance(document, str):
        return document.strip()
    if not isinstance(document, dict):
        return ""

    blocks = []  # type: list[str]
    _flatten_adf_node(document, blocks)
    joined = "\n\n".join(block.strip("\n") for block in blocks if block.strip())
    return joined.strip()


def _flatten_adf_node(node, blocks):
    # type: (object, list[str]) -> None
    if not isinstance(node, dict):
        return

    node_type = node.get("type")

    if node_type == "text":
        _append_inline(blocks, node.get("text") or "")
        return
    if node_type == "hardBreak":
        _append_inline(blocks, "\n")
        return
    if node_type == "codeBlock":
        # Verbatim, and its own block: a fenced block in a prompt is usually the
        # part that has to survive exactly.
        code_parts = []  # type: list[str]
        for child in node.get("content") or []:
            if isinstance(child, dict) and child.get("type") == "text":
                code_parts.append(child.get("text") or "")
        blocks.append("".join(code_parts))
        blocks.append("")  # Force the next node into a block of its own.
        return
    if node_type in ("mention", "emoji"):
        attributes = node.get("attrs") or {}
        _append_inline(blocks, str(attributes.get("text") or attributes.get("shortName") or ""))
        return
    if node_type == "rule":
        blocks.append("---")
        blocks.append("")
        return

    starts_block = node_type in _ADF_BLOCK_NODES
    if starts_block:
        blocks.append("")

    for child in node.get("content") or []:
        _flatten_adf_node(child, blocks)

    if starts_block:
        blocks.append("")


def _append_inline(blocks, text):
    # type: (list[str], str) -> None
    if not blocks:
        blocks.append("")
    blocks[-1] = blocks[-1] + text


def adf_document(text):
    # type: (str) -> dict
    """Plain text as an ADF document — one paragraph per blank-line-separated block.

    The only place this module *writes* a document body: comments, and the
    descriptions `import_prompts` creates once at migration.
    """
    paragraphs = []  # type: list[dict]
    for block in (text or "").split("\n\n"):
        stripped = block.strip("\n")
        if not stripped.strip():
            continue
        content = []  # type: list[dict]
        for index, line in enumerate(stripped.split("\n")):
            if index:
                content.append({"type": "hardBreak"})
            if line:
                content.append({"type": "text", "text": line})
        paragraphs.append({"type": "paragraph", "content": content})
    if not paragraphs:
        paragraphs.append({"type": "paragraph", "content": []})
    return {"type": "doc", "version": 1, "content": paragraphs}


# --------------------------------------------------------------------------- #
# The card
# --------------------------------------------------------------------------- #


def _split_repository_line(body):
    # type: (str) -> tuple[str, Path | None]
    """Lift a leading `REPO:` line off a block of text, returning what is left."""
    repository_path = None
    remaining_lines = []  # type: list[str]
    for line in body.split("\n"):
        stripped_line = line.strip()
        if (
            repository_path is None
            and not remaining_lines
            and stripped_line.startswith(REPOSITORY_FIELD_PREFIX)
        ):
            repository_text = stripped_line[len(REPOSITORY_FIELD_PREFIX) :].strip()
            if repository_text:
                repository_path = Path(os.path.expanduser(repository_text))
                continue
        remaining_lines.append(line)

    return "\n".join(remaining_lines).strip(), repository_path


def prompt_from_issue(issue):
    # type: (dict) -> tuple[str, Path | None]
    """A card's prompt text and its `REPO:` path.

    **The prompt is the description, or the summary when the description says
    nothing more than a `REPO:` line.** Jira forces a summary, and that fallback
    is what stops it from being double entry: a prompt you can state in a
    sentence is one field on a phone, and a long one gets a title worth having
    on the board.

    "Nothing more than a `REPO:` line" rather than "empty", because pointing a
    one-sentence card at a repository is the obvious thing to want, and reading
    the result as an empty prompt made the card invisible to `next_todo` — a
    board with work on it reporting an empty queue.
    """
    fields = issue.get("fields") or {}
    prompt, repository_path = _split_repository_line(flatten_adf(fields.get("description")))
    if prompt:
        return prompt, repository_path

    summary_prompt, summary_repository = _split_repository_line(
        (fields.get("summary") or "").strip()
    )
    return summary_prompt, repository_path or summary_repository


@dataclass
class OutcomeReport:
    """What a finished prompt has to say for itself, for the card's comment.

    Not part of `QueueSource`'s minimum — the file source ignores it entirely —
    but the whole payoff of the board is that each card explains itself, and
    `result_text` (Claude's own closing message) is the only thing that can do
    that. Passed as one object rather than five arguments so the file source can
    keep ignoring it as more is added.
    """

    result_text: "str | None" = None
    exit_code: "int | None" = None
    turns: "int | None" = None
    cost_usd: "float | None" = None
    working_directory: "str | None" = None
    unmerged_branch: "str | None" = None


@dataclass
class OutcomeWrite:
    """One card's write-back, as data — so it can be retried, or set aside and replayed.

    Serialisable on purpose: a write that fails after the prompt has run is the
    expensive failure, because an unrecorded outcome means the prompt runs again
    tomorrow. Written to `jira-pending-writes.jsonl` and drained at the start of
    the next run.
    """

    issue_key: str
    column: str
    comment: "str | None" = None
    add_labels: "list[str]" = field(default_factory=list)
    remove_labels: "list[str]" = field(default_factory=list)
    status: str = ""

    def to_json(self) -> dict:
        return {
            "issueKey": self.issue_key,
            "column": self.column,
            "comment": self.comment,
            "addLabels": list(self.add_labels),
            "removeLabels": list(self.remove_labels),
            "status": self.status,
        }

    @staticmethod
    def from_json(stored):
        # type: (object) -> OutcomeWrite | None
        if not isinstance(stored, dict):
            return None
        issue_key = stored.get("issueKey")
        column = stored.get("column")
        if not isinstance(issue_key, str) or column not in COLUMN_KEYS:
            return None
        return OutcomeWrite(
            issue_key=issue_key,
            column=column,
            comment=stored.get("comment") if isinstance(stored.get("comment"), str) else None,
            add_labels=[label for label in stored.get("addLabels") or [] if isinstance(label, str)],
            remove_labels=[
                label for label in stored.get("removeLabels") or [] if isinstance(label, str)
            ],
            status=stored.get("status") if isinstance(stored.get("status"), str) else "",
        )


def comment_for_outcome(status, report):
    # type: (str, OutcomeReport) -> str | None
    """Claude's own account of the prompt, as the card's comment — or None.

    One comment per attempt, so a card re-queued three times reads as three
    attempts with three accounts. Nothing is written for the two outcomes that
    leave a queue entry alone — a session limit and a cancellation — because the
    prompt never really ran, and a comment for them would fill the card with
    noise every time a week ran out of window.
    """
    name = status_name_of(status)
    if name == STATUS_TODO or name == STATUS_DRAFT:
        return None

    lines = []  # type: list[str]
    if name == STATUS_COMPLETED:
        lines.append("Ran and completed.")
    elif name == STATUS_UNMERGED:
        branch = status_detail_of(status) or report.unmerged_branch or "an unnamed branch"
        lines.append("Ran and left the work on branch `{}` rather than merging it.".format(branch))
    elif name == STATUS_ERROR:
        lines.append("Ran and failed.")
    else:
        lines.append("Finished as '{}'.".format(status))

    if report.working_directory:
        lines.append("Repository: {}".format(report.working_directory))
    if name == STATUS_ERROR and report.exit_code is not None:
        lines.append("Exit code: {}".format(report.exit_code))

    detail_parts = []  # type: list[str]
    if report.turns is not None:
        detail_parts.append("{} turns".format(report.turns))
    if report.cost_usd is not None:
        detail_parts.append("${:.2f}".format(report.cost_usd))
    if detail_parts:
        lines.append(" · ".join(detail_parts))

    header = "\n".join(lines)
    account = (report.result_text or "").strip()
    return header + "\n\n" + account if account else header


# --------------------------------------------------------------------------- #
# The source
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ProjectStatuses:
    """The project's statuses, matched to the five columns this plan needs.

    Discovered rather than hard-coded, so renaming a column in Jira does not
    break the run — and a *missing* one is reported by `just jira-status` rather
    than discovered at 2 AM.
    """

    by_column: "dict[str, str]"
    missing: "list[str]"

    def name_for(self, column):
        # type: (str) -> str | None
        return self.by_column.get(column)


def resolve_project_statuses(client, project_key, configured_names=None):
    # type: (JiraClient, str, dict | None) -> ProjectStatuses
    """Match the project's real statuses to the five columns, case-insensitively."""
    wanted = dict(DEFAULT_STATUS_NAMES)
    for column, name in (configured_names or {}).items():
        if column in wanted and isinstance(name, str) and name.strip():
            wanted[column] = name.strip()

    response = client.request("GET", "/rest/api/3/project/{}/statuses".format(project_key))
    available = {}  # type: dict[str, str]
    for issue_type in response if isinstance(response, list) else []:
        for status in (issue_type or {}).get("statuses") or []:
            name = (status or {}).get("name")
            if isinstance(name, str):
                available[name.strip().lower()] = name.strip()

    by_column = {}
    missing = []
    for column in COLUMN_KEYS:
        actual = available.get(wanted[column].strip().lower())
        if actual is None:
            missing.append(wanted[column])
        else:
            by_column[column] = actual
    return ProjectStatuses(by_column=by_column, missing=missing)


class JiraQueueSource:
    """The To Do column, read `ORDER BY Rank ASC` — a `queue_source.QueueSource`.

    Everything downstream of the queue is untouched: `determine_outcome`,
    `queue_status_for_outcome` and the summary writer keep working in `STATUS_*`
    strings, and this class translates at the boundary.
    """

    def __init__(self, credentials, project_key, status_names=None, log=_ignore):
        # type: (JiraCredentials, str, dict | None, object) -> None
        self.credentials = credentials
        self.project_key = project_key
        self.configured_status_names = status_names or {}
        self._log = log
        self.client = JiraClient(credentials, log=log)
        self._statuses = None  # type: ProjectStatuses | None

    # -- plumbing ----------------------------------------------------------- #

    def describe(self) -> str:
        return "Jira {} on {}".format(self.project_key, self.credentials.site_url)

    def statuses(self) -> ProjectStatuses:
        if self._statuses is None:
            try:
                self._statuses = resolve_project_statuses(
                    self.client, self.project_key, self.configured_status_names
                )
            except JiraError as error:
                raise QueueUnavailable(
                    "Could not read the Jira project's statuses ({}): {}".format(
                        error.cause, error
                    )
                )
            if self._statuses.missing:
                self._log(
                    "Jira project {} is missing these columns: {}".format(
                        self.project_key, ", ".join(self._statuses.missing)
                    )
                )
        return self._statuses

    def _status_name(self, column):
        # type: (str) -> str | None
        return self.statuses().name_for(column)

    def _search(self, column, limit=50):
        # type: (str, int) -> list[dict]
        status_name = self._status_name(column)
        if status_name is None:
            return []
        jql = 'project = "{}" AND status = "{}" ORDER BY Rank ASC'.format(
            self.project_key, status_name
        )
        try:
            response = self.client.request(
                "GET",
                # `/search/jql`, not the older `/search`, which is deprecated on
                # Cloud. One page only, and deliberately: the queue is read
                # top-down and a paginator that re-sorted would silently
                # scramble it, which is the worst failure this design has.
                "/rest/api/3/search/jql",
                query={
                    "jql": jql,
                    "fields": "summary,description,labels,status",
                    "maxResults": limit,
                },
            )
        except JiraError as error:
            raise QueueUnavailable(
                "Could not read the Jira queue ({}): {}".format(error.cause, error)
            )
        issues = (response or {}).get("issues") if isinstance(response, dict) else None
        return [issue for issue in issues or [] if isinstance(issue, dict)]

    def _entry_from_issue(self, issue, status):
        # type: (dict, str) -> QueueEntry
        prompt, repository_path = prompt_from_issue(issue)
        return QueueEntry(
            status=status,
            handle=issue.get("key"),
            repository_path=repository_path,
            prompt=prompt,
        )

    # -- reading ------------------------------------------------------------ #

    def next_todo(self):
        # type: () -> QueueEntry | None
        for issue in self._search(COLUMN_TODO):
            entry = self._entry_from_issue(issue, STATUS_TODO)
            if entry.prompt and entry.handle:
                return entry
            # Skipping in silence is what makes a card carrying no prompt look
            # exactly like an empty board — the hardest version of this to
            # diagnose, since `just queue-list` still shows the card by summary.
            self._log(
                "Skipping Jira card {} — it carries no prompt text".format(
                    issue.get("key") or "?"
                )
            )
        return None

    def holds_a_todo(self) -> bool:
        try:
            return self.next_todo() is not None
        except QueueUnavailable as error:
            self._log(str(error))
            return False

    def remaining_todo_prompts(self, already_attempted):
        # type: (list[str]) -> list[str]
        try:
            issues = self._search(COLUMN_TODO)
        except QueueUnavailable as error:
            self._log(str(error))
            return []
        prompts = []
        for issue in issues:
            entry = self._entry_from_issue(issue, STATUS_TODO)
            if entry.prompt and entry.prompt not in already_attempted:
                prompts.append(entry.prompt)
        return prompts

    # -- writing ------------------------------------------------------------ #

    def start(self, entry: QueueEntry) -> None:
        """Move the card into In Progress, so the board shows what is running."""
        issue_key = entry.handle
        if not isinstance(issue_key, str):
            return
        try:
            self._transition(issue_key, COLUMN_IN_PROGRESS)
            # Picking a card up clears both run labels, so re-queueing a failed
            # or unmerged prompt stays a single gesture: drag it back to To Do
            # and nothing else.
            self._update_labels(issue_key, add=[], remove=list(RUN_LABELS))
        except WRITE_FAILURES as error:
            # Not fatal. The prompt is worth running even if the board did not
            # move; the sweep at the next run's start catches the mismatch.
            self._log("Could not move {} to In Progress: {}".format(issue_key, error))

    def abandon(self, entry: QueueEntry) -> None:
        """Put the card back in To Do — it was picked up, but never really ran.

        Called from the cancellation handler, which has a SIGTERM in hand and
        `os._exit` a line away, so this is best-effort by necessity: the sweep at
        the next run's start is what catches a card this could not move.
        """
        issue_key = entry.handle
        if not isinstance(issue_key, str):
            return
        try:
            self._transition(issue_key, COLUMN_TODO)
            self._log("Returned {} to To Do".format(issue_key))
        except WRITE_FAILURES as error:
            self._log("Could not return {} to To Do: {}".format(issue_key, error))

    def sweep_stale(self) -> None:
        """Return any card left in In Progress to To Do.

        A card in In Progress at the start of a run is stale by definition:
        launchd will not run two instances of one label, so no second run can be
        in flight. The cancellation handler does the same on the way out; this is
        the backstop for a hard kill.
        """
        try:
            stranded = self._search(COLUMN_IN_PROGRESS)
        except QueueUnavailable as error:
            self._log(str(error))
            return
        for issue in stranded:
            issue_key = issue.get("key")
            if not isinstance(issue_key, str):
                continue
            try:
                self._transition(issue_key, COLUMN_TODO)
                self._log("Swept {} back to To Do — stranded by an earlier run".format(issue_key))
            except WRITE_FAILURES as error:
                self._log("Could not sweep {} back to To Do: {}".format(issue_key, error))

    def record_outcome(self, entry, status, report=None):
        # type: (QueueEntry, str, OutcomeReport | None) -> str
        """Land the run's outcome on the card: column, labels and one comment."""
        issue_key = entry.handle
        if not isinstance(issue_key, str):
            return status

        plan = self.plan_write(issue_key, status, report or OutcomeReport())
        self.apply_write_with_retries(plan)
        return status

    def plan_write(self, issue_key, status, report):
        # type: (str, str, OutcomeReport) -> OutcomeWrite
        """What this outcome does to the card — the `:detail` split happens here.

        `unmerged:<branch>` exists because a text file has one field to carry
        both the status and the branch name. A board has columns, labels *and*
        comments, so the status name picks the column and the detail goes into
        the comment; no `:detail` parsing exists anywhere else on this side.
        """
        name = status_name_of(status)
        column = COLUMN_FOR_STATUS.get(name, COLUMN_IN_REVIEW)

        add_labels = []  # type: list[str]
        remove_labels = []  # type: list[str]
        if name == STATUS_UNMERGED:
            add_labels.append(LABEL_UNMERGED)
            remove_labels.append(LABEL_ERROR)
        elif name == STATUS_ERROR:
            add_labels.append(LABEL_ERROR)
            remove_labels.append(LABEL_UNMERGED)
        else:
            remove_labels.extend(RUN_LABELS)

        return OutcomeWrite(
            issue_key=issue_key,
            column=column,
            comment=comment_for_outcome(status, report),
            add_labels=add_labels,
            remove_labels=remove_labels,
            status=status,
        )

    def apply_write(self, plan: OutcomeWrite) -> None:
        """Transition, labels, comment — in that order, and each may raise."""
        self._transition(plan.issue_key, plan.column)
        self._update_labels(plan.issue_key, plan.add_labels, plan.remove_labels)
        if plan.comment:
            self.client.request(
                "POST",
                "/rest/api/3/issue/{}/comment".format(plan.issue_key),
                body={"body": adf_document(plan.comment)},
            )

    def apply_write_with_retries(self, plan: OutcomeWrite) -> bool:
        """Write the outcome, and set it aside for the next run if it will not go.

        The expensive failure in this whole design: an outcome that never lands
        means the prompt runs again tomorrow. So it is retried, then queued, then
        said loudly — never silently dropped.
        """
        last_error = None  # type: Exception | None
        for attempt in range(1, OUTCOME_WRITE_ATTEMPTS + 1):
            try:
                self.apply_write(plan)
                self._log("Jira card {} marked '{}'".format(plan.issue_key, plan.status))
                return True
            except WRITE_FAILURES as error:
                last_error = error
                if attempt < OUTCOME_WRITE_ATTEMPTS:
                    time.sleep(OUTCOME_WRITE_BACKOFF_SECONDS)

        append_pending_write(plan)
        self._log(
            "Could not record {} on Jira card {} ({}); set aside for the next run to replay".format(
                plan.status,
                plan.issue_key,
                getattr(last_error, "cause", None) or last_error or "unknown",
            )
        )
        return False

    def drain_pending_writes(self) -> int:
        """Replay outcomes an earlier run could not write. Returns how many landed."""
        pending = read_pending_writes()
        if not pending:
            return 0

        self._log("Replaying {} Jira write(s) an earlier run could not land".format(len(pending)))
        still_pending = []  # type: list[OutcomeWrite]
        written = 0
        for plan in pending:
            try:
                self.apply_write(plan)
                written += 1
            except WRITE_FAILURES as error:
                self._log(
                    "Still cannot record {} on {} ({})".format(
                        plan.status, plan.issue_key, getattr(error, "cause", None) or error
                    )
                )
                still_pending.append(plan)
        replace_pending_writes(still_pending)
        return written

    def _transition(self, issue_key, column):
        # type: (str, str) -> None
        """Move a card by *name*, since transition ids are per-project and per-workflow."""
        target_name = self._status_name(column)
        if target_name is None:
            raise JiraError(
                "The Jira project has no '{}' column".format(DEFAULT_STATUS_NAMES[column])
            )

        response = self.client.request(
            "GET", "/rest/api/3/issue/{}/transitions".format(issue_key)
        )
        transitions = (response or {}).get("transitions") if isinstance(response, dict) else None
        for transition in transitions or []:
            destination = (transition or {}).get("to") or {}
            if str(destination.get("name") or "").strip().lower() == target_name.strip().lower():
                self.client.request(
                    "POST",
                    "/rest/api/3/issue/{}/transitions".format(issue_key),
                    body={"transition": {"id": transition.get("id")}},
                )
                return

        # Already there is not a failure — a card the run never moved, or one a
        # person dragged in the meantime, is exactly where we want it.
        current = ((response or {}).get("currentStatus") or {}) if isinstance(response, dict) else {}
        if str(current.get("name") or "").strip().lower() == target_name.strip().lower():
            return
        raise JiraError("No transition from {} to '{}'".format(issue_key, target_name))

    def _update_labels(self, issue_key, add, remove):
        # type: (str, list[str], list[str]) -> None
        operations = [{"add": label} for label in add] + [{"remove": label} for label in remove]
        if not operations:
            return
        self.client.request(
            "PUT",
            "/rest/api/3/issue/{}".format(issue_key),
            body={"update": {"labels": operations}},
        )


# --------------------------------------------------------------------------- #
# Pending writes
# --------------------------------------------------------------------------- #


def append_pending_write(plan, pending_file=None):
    # type: (OutcomeWrite, Path | None) -> None
    path = pending_file or PENDING_WRITES_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(plan.to_json()) + "\n")
    except OSError:
        pass  # Already the fallback path; there is nowhere further down to go.


def read_pending_writes(pending_file=None):
    # type: (Path | None) -> list[OutcomeWrite]
    path = pending_file or PENDING_WRITES_FILE
    try:
        raw_lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    plans = []
    for line in raw_lines:
        if not line.strip():
            continue
        try:
            plan = OutcomeWrite.from_json(json.loads(line))
        except ValueError:
            plan = None
        if plan is not None:
            plans.append(plan)
    return plans


def replace_pending_writes(plans, pending_file=None):
    # type: (list[OutcomeWrite], Path | None) -> None
    path = pending_file or PENDING_WRITES_FILE
    try:
        if not plans:
            if path.exists():
                path.unlink()
            return
        with path.open("w", encoding="utf-8") as handle:
            for plan in plans:
                handle.write(json.dumps(plan.to_json()) + "\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# The credential probe — §5.4
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class JiraStatus:
    """What the last probe found, and how urgent it is.

    Written by the native host, which Chrome spawns every five minutes whenever
    it is open, and read by the popup. **The run is the wrong thing to discover a
    broken credential**: it fires at 2 AM, and only when the week is behind pace,
    which may be never for a fortnight. The extension's clock is the reliable
    one, and it is one you are awake for.
    """

    configured: bool
    ok: bool
    cause: "str | None" = None
    detail: "str | None" = None
    site_url: "str | None" = None
    account_email: "str | None" = None
    project_key: "str | None" = None
    days_until_expiry: "int | None" = None
    checked_at: "str | None" = None

    def to_json(self) -> dict:
        return {
            "configured": self.configured,
            "ok": self.ok,
            "cause": self.cause,
            "detail": self.detail,
            "siteUrl": self.site_url,
            "accountEmail": self.account_email,
            "projectKey": self.project_key,
            "daysUntilExpiry": self.days_until_expiry,
            "checkedAt": self.checked_at,
        }


def read_status(status_file=None):
    # type: (Path | None) -> dict | None
    path = status_file or STATUS_FILE
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return stored if isinstance(stored, dict) else None


def write_status(status, status_file=None):
    # type: (JiraStatus, Path | None) -> None
    path = status_file or STATUS_FILE
    temporary_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=str(path.parent), delete=False
        ) as temp_handle:
            json.dump(status.to_json(), temp_handle, indent=2)
            temp_handle.write("\n")
            temporary_path = Path(temp_handle.name)
        os.replace(str(temporary_path), str(path))
    except OSError:
        if temporary_path is not None:
            try:
                os.unlink(str(temporary_path))
            except OSError:
                pass


def probe_credentials(credentials, project_key=None, log=_ignore):
    # type: (JiraCredentials | None, str | None, object) -> JiraStatus
    """One `GET /rest/api/3/myself`, reported with its cause rather than as a generic failure.

    401 is a bad or expired credential, 403 a permission lost on the project, 404
    a project that is gone — and a connection error means nothing at all and must
    not raise an alarm, since a laptop is offline most nights it is shut.
    """
    checked_at = datetime.now(timezone.utc).isoformat()

    if credentials is None:
        return JiraStatus(
            configured=False,
            ok=False,
            cause="notConfigured",
            detail="No Jira credential on this machine",
            checked_at=checked_at,
        )

    client = JiraClient(credentials, log=log, timeout_seconds=PROBE_TIMEOUT_SECONDS)
    try:
        account = client.request("GET", PROBE_PATH)
    except JiraError as error:
        return JiraStatus(
            configured=True,
            ok=False,
            cause=error.cause,
            detail=str(error),
            site_url=credentials.site_url,
            account_email=credentials.email,
            project_key=project_key,
            days_until_expiry=credentials.days_until_expiry(),
            checked_at=checked_at,
        )

    account_email = credentials.email
    if isinstance(account, dict) and isinstance(account.get("emailAddress"), str):
        account_email = account["emailAddress"]

    return JiraStatus(
        configured=True,
        ok=True,
        site_url=credentials.site_url,
        account_email=account_email,
        project_key=project_key,
        days_until_expiry=credentials.days_until_expiry(),
        checked_at=checked_at,
    )


def probe_is_due(previous_status, now=None, interval_seconds=PROBE_INTERVAL_SECONDS):
    # type: (dict | None, datetime | None, int) -> bool
    """Throttle the probe to once a day, off the timestamp the last one recorded.

    The host is spawned every five minutes and a token's expiry is a date; a call
    per snapshot would be 288 a day to learn something that changes once.
    """
    if not previous_status:
        return True
    checked_at = previous_status.get("checkedAt")
    if not isinstance(checked_at, str):
        return True
    try:
        last = datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    moment = now or datetime.now(timezone.utc)
    return (moment - last).total_seconds() >= interval_seconds


def refresh_status_if_due(project_key=None, log=_ignore, now=None):
    # type: (str | None, object, datetime | None) -> dict | None
    """The daily probe, as the native host calls it. Returns the status now on disk."""
    previous = read_status()
    if not probe_is_due(previous, now):
        return previous
    status = probe_credentials(read_credentials(), project_key=project_key, log=log)
    write_status(status)
    return status.to_json()


# --------------------------------------------------------------------------- #
# Project setup and migration
# --------------------------------------------------------------------------- #


def find_project(client, project_name, project_key=None):
    # type: (JiraClient, str, str | None) -> dict | None
    """The project by key if one was named, else by exact name."""
    response = client.request(
        "GET",
        "/rest/api/3/project/search",
        query={"query": project_key or project_name, "maxResults": 50},
    )
    values = (response or {}).get("values") if isinstance(response, dict) else None
    for project in values or []:
        if not isinstance(project, dict):
            continue
        if project_key and str(project.get("key") or "").upper() == project_key.upper():
            return project
        if not project_key and str(project.get("name") or "").strip() == project_name:
            return project
    return None


def create_project(client, account_id, project_name=DEFAULT_PROJECT_NAME, project_key=DEFAULT_PROJECT_KEY):
    # type: (JiraClient, str, str, str) -> dict
    """A team-managed Jira Software project with a Kanban board.

    Needs Administer Jira permission, which the owner of a free site has by
    definition. A user pointed at somebody else's Jira fails here with a clear
    message and can name an existing project instead.
    """
    return client.request(
        "POST",
        "/rest/api/3/project",
        body={
            "key": project_key,
            "name": project_name,
            "projectTypeKey": "software",
            "projectTemplateKey": KANBAN_TEMPLATE_KEY,
            "leadAccountId": account_id,
            "assigneeType": "PROJECT_LEAD",
        },
    )


def create_card(client, project_key, summary, description, status_name=None):
    # type: (JiraClient, str, str, str, str | None) -> str
    """One card, created at the bottom of its column. Returns the issue key."""
    created = client.request(
        "POST",
        "/rest/api/3/issue",
        body={
            "fields": {
                "project": {"key": project_key},
                "summary": summary[:250],
                "description": adf_document(description),
                "issuetype": {"name": "Task"},
            }
        },
    )
    return str((created or {}).get("key") or "")


def summary_and_description_for_prompt(prompt, repository_path=None):
    # type: (str, Path | None) -> tuple[str, str]
    """A card's two fields from a queue entry.

    The first line becomes the summary and the whole prompt the description, so
    the board is scannable on a phone without the prompt itself being paraphrased
    — the description is what actually runs.
    """
    first_line = next((line.strip() for line in prompt.split("\n") if line.strip()), "Queued prompt")
    summary = first_line if len(first_line) <= 120 else first_line[:119] + "…"
    body = prompt
    if repository_path is not None:
        body = "{} {}\n\n{}".format(REPOSITORY_FIELD_PREFIX, repository_path, prompt)
    return summary, body


# --------------------------------------------------------------------------- #
# Migration
# --------------------------------------------------------------------------- #


def import_prompts(client, project_key, statuses, entries, log=_ignore):
    # type: (JiraClient, str, ProjectStatuses, list, object) -> int
    """Create one card per `prompts.txt` section, in the file's own order.

    Section order becomes board order because the cards are created in that
    order and Jira ranks new issues at the bottom. `completed` sections come
    across into Done rather than being dropped, so the history survives the move.
    """
    # One source for the whole migration, carrying the statuses already resolved
    # — it exists only to reuse `_transition`, which knows how to find a
    # transition by destination name.
    source = JiraQueueSource(client.credentials, project_key, log=log)
    source._statuses = statuses  # noqa: SLF001 - the same object, already resolved

    created = 0
    for entry in entries:
        if not entry.prompt:
            continue
        column = COLUMN_FOR_STATUS.get(entry.status_name, COLUMN_TODO)
        summary, description = summary_and_description_for_prompt(
            entry.prompt, entry.repository_path
        )
        issue_key = create_card(client, project_key, summary, description)
        if not issue_key:
            log("Could not create a card for: {}".format(summary))
            continue
        created += 1

        target_status = statuses.name_for(column)
        if column != COLUMN_TODO and target_status:
            try:
                source._transition(issue_key, column)  # noqa: SLF001
            except WRITE_FAILURES as error:
                log("Created {} but could not file it under {}: {}".format(
                    issue_key, target_status, error
                ))
        if entry.status_name == STATUS_UNMERGED:
            branch = status_detail_of(entry.status)
            if branch:
                client.request(
                    "POST",
                    "/rest/api/3/issue/{}/comment".format(issue_key),
                    body={
                        "body": adf_document(
                            "Imported from prompts.txt — the work is on branch `{}`.".format(branch)
                        )
                    },
                )
        log("Created {} — {}".format(issue_key, summary))
    return created


# The prompt `just probe-jira-adf` round-trips, chosen for what a document model
# is most likely to reshape: backticks, asterisks, underscores, a path with an
# underscore in it, and a fenced block.
ADF_PROBE_PROMPT = """Refactor `parseThing()` in ~/code/some_path/lib_helpers.py.

It should *not* touch the __init__ and it must keep the `--dry-run` flag working.

```python
def parseThing(raw_value: str) -> dict:
    return {"raw": raw_value}
```

Leave a note when you are done."""


# --------------------------------------------------------------------------- #
# Command line
# --------------------------------------------------------------------------- #


def _prompt(label, default=""):
    # type: (str, str) -> str
    suffix = " [{}]".format(default) if default else ""
    answer = input("{}{}: ".format(label, suffix)).strip()
    return answer or default


def _describe_expiry(days):
    # type: (int | None) -> str
    if days is None:
        return "unknown (no expiry date recorded)"
    if days < 0:
        return "EXPIRED {} days ago".format(-days)
    return "{} days".format(days)


def _load_configured(require_credentials=True):
    # type: (bool) -> tuple[JiraCredentials | None, str]
    """The credential and project key this machine is configured with."""
    import autonomous_work_settings

    settings = autonomous_work_settings.read_settings()
    project_key = (
        os.environ.get("AUTONOMOUS_WORK_JIRA_PROJECT") or settings.jira_project_key or ""
    )
    credentials = read_credentials()
    if credentials is None and require_credentials:
        print("No Jira credential at {} — run `just set-jira-credentials`.".format(CREDENTIALS_FILE))
    return credentials, project_key


def _set_credentials():
    # type: () -> int
    import getpass

    existing = read_credentials()

    print("Three things are needed, and this asks for them in order.\n")
    print("1. A Jira Cloud site. If you have none, the free plan at")
    print("   https://www.atlassian.com/software/jira/free takes a couple of minutes")
    print("   and covers everything here. Its address looks like")
    print("   https://yourname.atlassian.net")
    print("2. The email address you sign in to Atlassian with.")
    print("3. An API token, from")
    print("   https://id.atlassian.com/manage-profile/security/api-tokens")
    print("   Atlassian caps every token at one year and shows you the expiry date")
    print("   as it creates it — copy that date down, because no API can report it")
    print("   back and it is what the expiry warnings count from.\n")

    site_url = _prompt("Jira site URL", existing.site_url if existing else "")
    email = _prompt("Atlassian account email", existing.email if existing else "")
    api_token = getpass.getpass("API token (not echoed): ").strip()
    if not api_token and existing:
        api_token = existing.api_token
        print("Keeping the token already on file.")
    expiry_text = _prompt(
        "Token expiry (YYYY-MM-DD)",
        existing.token_expires_at.isoformat() if existing and existing.token_expires_at else "",
    )

    if not (site_url and email and api_token):
        print("\nSite URL, email and token are all required — nothing was written.")
        return 1

    credentials = JiraCredentials(
        site_url=site_url if site_url.startswith("http") else "https://" + site_url,
        email=email,
        api_token=api_token,
        token_expires_at=_parse_date(expiry_text),
    )
    path = write_credentials(credentials)
    print("Wrote {} (mode 0600)".format(path))

    status = probe_credentials(credentials)
    write_status(status)
    if status.ok:
        print("Credential works — {}".format(credentials.describe()))
        return 0

    print("\nCredential stored, but the check failed ({}): {}".format(status.cause, status.detail))
    # Four causes, four different fixes. A generic failure here is how somebody
    # spends twenty minutes re-pasting a token that was never the problem.
    print({
        "unauthorised": "The email or the token is wrong. Tokens are shown once — create a new one.",
        "notFound": "The site URL does not look like a Jira site. Check it in the browser.",
        "unreachable": "Could not reach the site at all — check the URL and your connection.",
        "forbidden": "The credential is valid but this account lacks access to that site.",
    }.get(status.cause, "Re-run this once you know what changed."))
    return 1


def _install(project_key_argument=None):
    # type: (str | None) -> int
    import autonomous_work_settings
    from dataclasses import replace

    if read_credentials() is None:
        if _set_credentials() != 0:
            return 1

    credentials = read_credentials()
    if credentials is None:
        return 1
    client = JiraClient(credentials, log=print)

    try:
        account = client.request("GET", PROBE_PATH)
    except JiraError as error:
        print("Could not reach {} ({}): {}".format(credentials.site_url, error.cause, error))
        return 1
    account_id = (account or {}).get("accountId")

    project_key = (project_key_argument or "").strip().upper() or None
    project = find_project(client, DEFAULT_PROJECT_NAME, project_key)

    if project is None and project_key:
        print("No project with key {} on {}.".format(project_key, credentials.site_url))
        return 1

    if project is None:
        print("Creating the '{}' project…".format(DEFAULT_PROJECT_NAME))
        try:
            project = create_project(client, account_id)
        except JiraError as error:
            print("Could not create the project: {}".format(error))
            if error.explanation:
                print("Jira said: {}".format(error.explanation))
            if error.status_code == 403:
                print(
                    "\nCreating a project needs Administer Jira permission, which this account "
                    "does not have."
                )
            print(
                "\nMake the project by hand instead — any Jira Software project will do — "
                "and pass its key:\n    just install-jira-queue MYKEY"
            )
            return 1
    else:
        print("Leaving the existing project alone: {}".format(project.get("key")))

    resolved_key = str(project.get("key") or DEFAULT_PROJECT_KEY)
    statuses = resolve_project_statuses(client, resolved_key)

    settings = autonomous_work_settings.read_settings()
    autonomous_work_settings.write_settings(
        replace(
            settings,
            queue_source=autonomous_work_settings.QUEUE_SOURCE_JIRA,
            jira_project_key=resolved_key,
        )
    )
    write_status(probe_credentials(credentials, project_key=resolved_key))

    board_url = "{}/jira/software/projects/{}/boards".format(credentials.base_url, resolved_key)

    print()
    print("Credential and project are set up. {} steps are left, and none of them".format(
        "Three" if statuses.missing else "Two"
    ))
    print("can be done from here.\n")

    step = 1
    if statuses.missing:
        # Not a shortcut this recipe is taking: the team-managed template makes
        # three columns, and Jira Cloud exposes no documented REST route for
        # adding one. Two clicks each, once — the same way `just setup` ends by
        # printing the one thing it cannot do itself.
        print("{}. Add the missing columns by hand. Measured, not assumed: the".format(step))
        print("   status itself can be created over the API, but getting it into a")
        print("   team-managed project's workflow — which is what makes it a column —")
        print("   has no route we could find. Two clicks each, once.")
        print("   Open {}".format(board_url))
        for name in statuses.missing:
            print("   then '+' to the right of the last column, and name it: {}".format(name))
        print("   (in a team-managed project, adding a column creates the status)\n")
        step += 1
    else:
        print("   (all five columns are already present on {})\n".format(board_url))

    print("{}. Point the extension at the board. Click its toolbar icon in Chrome,".format(step))
    print("   open Settings, set 'Queue source' to 'A Jira board' and 'Jira project")
    print("   key' to {}. This is not optional: the extension owns those two".format(resolved_key))
    print("   settings, and the next time it saves it overwrites what this just")
    print("   wrote to disk.\n")
    step += 1

    print("{}. Check it: just jira-status".format(step))
    print("   It answers site, project, credential, expiry, columns and queue depth")
    print("   in one screen. Then `just queue-list` shows what would run next.\n")

    print("To bring your existing prompts.txt across: just import-prompts-to-jira")
    print("It asks before creating anything and leaves the file alone.")
    return 0


def _status():
    # type: () -> int
    credentials, project_key = _load_configured(require_credentials=False)

    print("Credential file:  {}".format(CREDENTIALS_FILE))
    if credentials is None:
        print("Credential:       none — run `just set-jira-credentials`")
        return 1

    print("Site:             {}".format(credentials.site_url))
    print("Account:          {}".format(credentials.email))
    print("Project:          {}".format(project_key or "(not set)"))
    print("Token expires in: {}".format(_describe_expiry(credentials.days_until_expiry())))

    status = probe_credentials(credentials, project_key=project_key)
    write_status(status)
    if not status.ok:
        print("Credential:       FAILING ({}) — {}".format(status.cause, status.detail))
        return 1
    print("Credential:       valid")

    if not project_key:
        return 1

    client = JiraClient(credentials, log=print)
    try:
        statuses = resolve_project_statuses(client, project_key)
    except JiraError as error:
        print("Columns:          could not read them ({}): {}".format(error.cause, error))
        return 1

    if statuses.missing:
        print("Columns:          MISSING {}".format(", ".join(statuses.missing)))
    else:
        print("Columns:          all five present")

    source = JiraQueueSource(credentials, project_key, log=print)
    try:
        queued = source._search(COLUMN_TODO)  # noqa: SLF001 - this is the diagnostic
        in_progress = source._search(COLUMN_IN_PROGRESS)  # noqa: SLF001
    except QueueUnavailable as error:
        print("Queue depth:      unknown — {}".format(error))
        return 1
    print("Queue depth:      {} card(s) in To Do".format(len(queued)))
    if in_progress:
        print(
            "In Progress:      {} stranded card(s) — the next run sweeps them back".format(
                len(in_progress)
            )
        )
    print("Last probe:       {}".format(status.checked_at))
    return 0 if not statuses.missing else 1


def _list_queue():
    # type: () -> int
    credentials, project_key = _load_configured()
    if credentials is None or not project_key:
        return 1
    source = JiraQueueSource(credentials, project_key, log=print)
    try:
        issues = source._search(COLUMN_TODO)  # noqa: SLF001 - this is the diagnostic
    except QueueUnavailable as error:
        print(error)
        return 1
    if not issues:
        print("Nothing in To Do.")
        return 0
    print("What the next run would pick up, in rank order:\n")
    for position, issue in enumerate(issues, start=1):
        entry = source._entry_from_issue(issue, STATUS_TODO)  # noqa: SLF001
        summary = ((issue.get("fields") or {}).get("summary") or "").strip()
        marker = "→" if position == 1 else " "
        print("{} {}. [{}] {}".format(marker, position, issue.get("key"), summary))
        if entry.repository_path:
            print("       repo: {}".format(entry.repository_path))
    return 0


def _import_prompts(queue_file=None):
    # type: (Path | None) -> int
    credentials, project_key = _load_configured()
    if credentials is None or not project_key:
        return 1

    path = queue_file or (SCRIPT_DIRECTORY.parent / "prompts.txt")
    file_queue = queue_source.FileQueueSource(path, log=print)
    try:
        entries = file_queue.entries()
    except QueueUnavailable as error:
        print(error)
        return 1
    entries = [entry for entry in entries if entry.prompt]
    if not entries:
        print("Nothing to import from {}".format(path))
        return 0

    print("About to create {} card(s) in {} from {}.".format(len(entries), project_key, path))
    if _prompt("Type 'yes' to go ahead").lower() != "yes":
        print("Nothing created.")
        return 0

    client = JiraClient(credentials, log=print)
    statuses = resolve_project_statuses(client, project_key)
    created = import_prompts(client, project_key, statuses, entries, log=print)
    print("\nCreated {} card(s). {} is untouched — delete it by hand once you are happy.".format(
        created, path
    ))
    return 0


def _probe_adf():
    # type: () -> int
    """What a real prompt survives as, through v3 (ADF) and v2 (wiki markup).

    Phase 0's measurement, and it has to be run against a real site: the whole
    question is what Atlassian's document model does to text nobody controls.
    Creates one card, reads it back both ways, and deletes it.
    """
    credentials, project_key = _load_configured()
    if credentials is None or not project_key:
        return 1
    client = JiraClient(credentials, log=print)

    issue_key = create_card(client, project_key, "ADF probe (safe to delete)", ADF_PROBE_PROMPT)
    print("Created {}\n".format(issue_key))
    try:
        v3 = client.request(
            "GET", "/rest/api/3/issue/{}".format(issue_key), query={"fields": "description"}
        )
        v3_text = flatten_adf(((v3 or {}).get("fields") or {}).get("description"))
        v2 = client.request(
            "GET", "/rest/api/2/issue/{}".format(issue_key), query={"fields": "description"}
        )
        v2_text = flatten_adf(((v2 or {}).get("fields") or {}).get("description"))
    finally:
        try:
            client.request("DELETE", "/rest/api/3/issue/{}".format(issue_key))
            print("Deleted {}\n".format(issue_key))
        except JiraError as error:
            print("Could not delete {}: {} — delete it by hand.\n".format(issue_key, error))

    print("=== what was sent ===")
    print(ADF_PROBE_PROMPT)
    print("\n=== v3, flattened from ADF ===")
    print(v3_text)
    print("\n=== v2, wiki markup ===")
    print(v2_text)
    print("\n=== verdict ===")
    print("v3 round-trips exactly: {}".format(v3_text.strip() == ADF_PROBE_PROMPT.strip()))
    print("v2 round-trips exactly: {}".format(v2_text.strip() == ADF_PROBE_PROMPT.strip()))
    print("\nIf v3 is lossy where v2 is not, switch the read path to /rest/api/2/.")
    return 0


def _queue_source_report():
    # type: () -> int
    """Which source is configured, and is it reachable — the one-line sanity check."""
    import autonomous_work_settings

    settings = autonomous_work_settings.read_settings()
    configured = os.environ.get("AUTONOMOUS_WORK_QUEUE_SOURCE") or settings.queue_source
    if configured != autonomous_work_settings.QUEUE_SOURCE_JIRA:
        queue_file = SCRIPT_DIRECTORY.parent / "prompts.txt"
        print("Queue source: file — {}".format(queue_file))
        file_queue = queue_source.FileQueueSource(queue_file)
        try:
            entries = [
                entry for entry in file_queue.entries() if entry.status_name == STATUS_TODO
            ]
        except QueueUnavailable as error:
            print("Reachable:    no — {}".format(error))
            return 1
        print("Reachable:    yes — {} todo entr{}".format(
            len(entries), "y" if len(entries) == 1 else "ies"
        ))
        return 0

    credentials, project_key = _load_configured()
    print("Queue source: jira — project {}".format(project_key or "(not set)"))
    if credentials is None or not project_key:
        print("Reachable:    no — falling back to the file queue at 2 AM")
        return 1
    source = JiraQueueSource(credentials, project_key, log=print)
    try:
        issues = source._search(COLUMN_TODO)  # noqa: SLF001 - this is the diagnostic
    except QueueUnavailable as error:
        print("Reachable:    no — {}".format(error))
        return 1
    print("Reachable:    yes — {} card(s) in To Do".format(len(issues)))
    return 0


def main():
    # type: () -> int
    import argparse

    parser = argparse.ArgumentParser(description="The Jira board as the work queue.")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--install", action="store_true", help="Credential, project, statuses.")
    modes.add_argument("--set-credentials", action="store_true", help="Rotate the API token.")
    modes.add_argument("--status", action="store_true", help="Site, project, credential, columns.")
    modes.add_argument("--list", action="store_true", help="What the next run would pick up.")
    modes.add_argument("--source", action="store_true", help="Which queue, and is it reachable.")
    modes.add_argument("--import-prompts", action="store_true", help="Migrate prompts.txt.")
    modes.add_argument("--probe-adf", action="store_true", help="What a real prompt survives as.")
    parser.add_argument("project_key", nargs="?", help="An existing project to use, for --install.")
    arguments = parser.parse_args()

    try:
        if arguments.install:
            return _install(arguments.project_key)
        if arguments.set_credentials:
            return _set_credentials()
        if arguments.status:
            return _status()
        if arguments.list:
            return _list_queue()
        if arguments.source:
            return _queue_source_report()
        if arguments.import_prompts:
            return _import_prompts()
        if arguments.probe_adf:
            return _probe_adf()
    except (EOFError, KeyboardInterrupt):
        # Ctrl-C or Ctrl-D part way through the credential questions, which is a
        # perfectly ordinary way to change your mind. Nothing has been written
        # yet at any point one of these can arrive — the credential file is
        # written after the last question, not as the answers come in.
        print("\nStopped. Nothing was written.")
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
