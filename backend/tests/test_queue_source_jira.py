#!/usr/bin/env python3
"""Unit tests for the Jira queue source, against a stub Jira in this process.

The stub is why `AUTONOMOUS_WORK_JIRA_BASE_URL` exists — the same trick
`AUTONOMOUS_WORK_LAUNCHCTL` plays for the scheduling paths, and the reason every
transition, label and comment this design writes can be exercised without an
Atlassian account. It models issues in memory rather than replaying fixtures, so
a test asserts on the board's *state* afterwards rather than on the shape of the
call that got there.

What is deliberately not covered: `_install`, `_probe_adf` and the rest of the
command line. They exist to be pointed at a real site — `probe-jira-adf`'s whole
question is what Atlassian's document model does to text nobody controls, and a
stub that answered it would only be answering itself.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import queue_source  # noqa: E402  (must follow the sys.path line above)
import queue_source_jira as jira  # noqa: E402  (same)


# --------------------------------------------------------------------------- #
# The stub
# --------------------------------------------------------------------------- #

PROJECT_KEY = "FCP"
ALL_STATUS_NAMES = list(jira.DEFAULT_STATUS_NAMES.values())


class FakeJiraState:
    """A board, in memory: issues with a status, labels, a description and comments."""

    def __init__(self):
        self.issues = {}  # type: dict
        self.order = []  # type: list
        self.statuses = list(ALL_STATUS_NAMES)
        self.requests = []  # type: list
        self.next_status_code = None  # Forced failure for the next call, once.
        self.fail_writes = False
        self._counter = 0

    def add_issue(self, summary, description=None, status="To Do", labels=None):
        self._counter += 1
        key = "{}-{}".format(PROJECT_KEY, self._counter)
        self.issues[key] = {
            "key": key,
            "fields": {
                "summary": summary,
                "description": description,
                "labels": list(labels or []),
                "status": {"name": status},
            },
            "comments": [],
        }
        self.order.append(key)
        return key

    def issues_in(self, status_name):
        return [
            self.issues[key]
            for key in self.order
            if self.issues[key]["fields"]["status"]["name"] == status_name
        ]


class _Handler(BaseHTTPRequestHandler):
    state = None  # type: FakeJiraState

    def log_message(self, *_args):
        pass  # The test output is not the place for an access log.

    # -- helpers ------------------------------------------------------------ #

    def _reply(self, status_code, payload=None):
        body = json.dumps(payload if payload is not None else {}).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _forced_failure(self):
        state = self.state
        if state.next_status_code is not None:
            code = state.next_status_code
            state.next_status_code = None
            self._reply(code, {"errorMessages": ["forced"]})
            return True
        return False

    # -- routes ------------------------------------------------------------- #

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        state = self.state
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        state.requests.append(("GET", parsed.path, query))
        if self._forced_failure():
            return

        if parsed.path == "/rest/api/3/myself":
            return self._reply(200, {"accountId": "abc123", "emailAddress": "a@example.com"})

        if parsed.path == "/rest/api/3/project/{}/statuses".format(PROJECT_KEY):
            return self._reply(
                200, [{"name": "Task", "statuses": [{"name": name} for name in state.statuses]}]
            )

        if parsed.path == "/rest/api/3/search/jql":
            jql = (query.get("jql") or [""])[0]
            wanted = jql.split('status = "')[1].split('"')[0]
            return self._reply(200, {"issues": state.issues_in(wanted), "isLast": True})

        if parsed.path.endswith("/transitions"):
            key = parsed.path.split("/")[-2]
            issue = state.issues.get(key)
            if issue is None:
                return self._reply(404)
            return self._reply(
                200,
                {
                    "currentStatus": issue["fields"]["status"],
                    "transitions": [
                        {"id": str(index), "to": {"name": name}}
                        for index, name in enumerate(state.statuses)
                        if name != issue["fields"]["status"]["name"]
                    ],
                },
            )

        return self._reply(404)

    def do_POST(self):  # noqa: N802
        state = self.state
        parsed = urllib.parse.urlparse(self.path)
        body = self._body()
        state.requests.append(("POST", parsed.path, body))
        if self._forced_failure() or (state.fail_writes and self._reply(500) is None):
            return

        if parsed.path.endswith("/transitions"):
            key = parsed.path.split("/")[-2]
            transition_id = int(body["transition"]["id"])
            state.issues[key]["fields"]["status"] = {"name": state.statuses[transition_id]}
            return self._reply(204)

        if parsed.path.endswith("/comment"):
            key = parsed.path.split("/")[-2]
            state.issues[key]["comments"].append(jira.flatten_adf(body.get("body")))
            return self._reply(201, {"id": "1"})

        return self._reply(404)

    def do_PUT(self):  # noqa: N802
        state = self.state
        parsed = urllib.parse.urlparse(self.path)
        body = self._body()
        state.requests.append(("PUT", parsed.path, body))
        if self._forced_failure() or (state.fail_writes and self._reply(500) is None):
            return

        key = parsed.path.split("/")[-1]
        labels = state.issues[key]["fields"]["labels"]
        for operation in body.get("update", {}).get("labels", []):
            if "add" in operation and operation["add"] not in labels:
                labels.append(operation["add"])
            if "remove" in operation and operation["remove"] in labels:
                labels.remove(operation["remove"])
        return self._reply(204)


class StubJiraTestCase(unittest.TestCase):
    """One stub server per test, on a port the OS picks."""

    def setUp(self):
        self.state = FakeJiraState()
        handler = type("BoundHandler", (_Handler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        # A short poll interval only because `shutdown()` waits for the serve
        # loop to notice, and the default 0.5s would be most of this suite's
        # runtime across a server per test.
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True
        )
        self.thread.start()
        self._server_running = True

        self._previous_base_url = jira.BASE_URL_OVERRIDE
        jira.BASE_URL_OVERRIDE = "http://127.0.0.1:{}".format(self.server.server_address[1])

        self._directory = tempfile.TemporaryDirectory()
        self._previous_pending = jira.PENDING_WRITES_FILE
        jira.PENDING_WRITES_FILE = Path(self._directory.name) / "jira-pending-writes.jsonl"

        self.credentials = jira.JiraCredentials(
            site_url="https://example.atlassian.net", email="a@example.com", api_token="token"
        )
        self.logged = []  # type: list
        self.source = jira.JiraQueueSource(
            self.credentials, PROJECT_KEY, log=self.logged.append
        )

        # The write retries sleep between attempts, which is right in a run and
        # pure waiting here. Nothing in these tests is about the delay itself.
        self._previous_backoff = jira.OUTCOME_WRITE_BACKOFF_SECONDS
        jira.OUTCOME_WRITE_BACKOFF_SECONDS = 0

    def stop_jira(self):
        """Take the stub off its port entirely, so calls are refused rather than hung.

        Closing the socket as well as stopping the loop is the point: a port
        still bound but no longer accepting leaves every request sitting until
        its 30-second timeout, which makes for a slow test rather than a
        realistic one.
        """
        if self._server_running:
            self._server_running = False
            self.server.shutdown()
            self.server.server_close()

    def tearDown(self):
        jira.OUTCOME_WRITE_BACKOFF_SECONDS = self._previous_backoff
        jira.BASE_URL_OVERRIDE = self._previous_base_url
        jira.PENDING_WRITES_FILE = self._previous_pending
        self.stop_jira()
        self._directory.cleanup()

    def status_of(self, issue_key):
        return self.state.issues[issue_key]["fields"]["status"]["name"]

    def labels_of(self, issue_key):
        return self.state.issues[issue_key]["fields"]["labels"]


# --------------------------------------------------------------------------- #
# Pure logic — no server needed
# --------------------------------------------------------------------------- #


class FlattenAdfTests(unittest.TestCase):
    """The likeliest source of a subtly wrong prompt, so it is measured against
    what a real prompt actually contains: backticks, asterisks, underscores, a
    path with an underscore in it, and a fenced block."""

    def _document(self, *content):
        return {"type": "doc", "version": 1, "content": list(content)}

    def _paragraph(self, *texts):
        return {"type": "paragraph", "content": [{"type": "text", "text": t} for t in texts]}

    def test_paragraphs_are_separated_by_a_blank_line(self):
        document = self._document(self._paragraph("First."), self._paragraph("Second."))
        self.assertEqual(jira.flatten_adf(document), "First.\n\nSecond.")

    def test_punctuation_a_document_model_might_reshape_survives(self):
        document = self._document(
            self._paragraph("Refactor `parseThing()` in ~/code/some_path/lib_helpers.py "),
            self._paragraph("It should *not* touch the __init__ or the --dry-run flag."),
        )
        flattened = jira.flatten_adf(document)
        self.assertIn("`parseThing()`", flattened)
        self.assertIn("~/code/some_path/lib_helpers.py", flattened)
        self.assertIn("*not*", flattened)
        self.assertIn("__init__", flattened)

    def test_a_code_block_keeps_its_content_verbatim(self):
        document = self._document(
            self._paragraph("Do this:"),
            {"type": "codeBlock", "content": [{"type": "text", "text": "a = 1\nb = 2"}]},
            self._paragraph("Then stop."),
        )
        self.assertEqual(jira.flatten_adf(document), "Do this:\n\na = 1\nb = 2\n\nThen stop.")

    def test_a_hard_break_is_a_newline_inside_one_block(self):
        document = self._document(
            {
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "one"},
                    {"type": "hardBreak"},
                    {"type": "text", "text": "two"},
                ],
            }
        )
        self.assertEqual(jira.flatten_adf(document), "one\ntwo")

    def test_a_plain_string_passes_through(self):
        # A v2 response is wiki markup, not a tree, and needs no special casing
        # at the call site.
        self.assertEqual(jira.flatten_adf("just text"), "just text")

    def test_nothing_at_all_is_an_empty_string(self):
        self.assertEqual(jira.flatten_adf(None), "")
        self.assertEqual(jira.flatten_adf(12), "")

    def test_a_document_written_here_round_trips(self):
        original = "First line.\n\nSecond block\nwith a break."
        self.assertEqual(jira.flatten_adf(jira.adf_document(original)), original)


class PromptFromIssueTests(unittest.TestCase):
    def _issue(self, summary, description=None):
        return {"key": "FCP-1", "fields": {"summary": summary, "description": description}}

    def test_the_description_is_the_prompt(self):
        prompt, repository = jira.prompt_from_issue(
            self._issue("A short title", jira.adf_document("The real prompt."))
        )
        self.assertEqual(prompt, "The real prompt.")
        self.assertIsNone(repository)

    def test_an_empty_description_falls_back_to_the_summary(self):
        # What stops Jira's forced summary from being double entry: a prompt you
        # can state in a sentence is one field on a phone.
        prompt, _ = jira.prompt_from_issue(self._issue("Tidy up the log formatting"))
        self.assertEqual(prompt, "Tidy up the log formatting")

    def test_a_repo_line_is_lifted_off_the_top(self):
        prompt, repository = jira.prompt_from_issue(
            self._issue("t", jira.adf_document("REPO: ~/code/thing\n\nDo the thing."))
        )
        self.assertEqual(repository, Path("~/code/thing").expanduser())
        self.assertEqual(prompt, "Do the thing.")

    def test_a_repo_line_below_the_prompt_is_left_in_the_text(self):
        prompt, repository = jira.prompt_from_issue(
            self._issue("t", jira.adf_document("Do the thing.\n\nREPO: ~/code/thing"))
        )
        self.assertIsNone(repository)
        self.assertIn("REPO: ~/code/thing", prompt)


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.path = Path(self._directory.name) / "jira-credentials.json"

    def tearDown(self):
        self._directory.cleanup()

    def test_a_written_credential_is_0600_and_reads_back(self):
        from datetime import date

        written = jira.JiraCredentials(
            site_url="https://example.atlassian.net",
            email="a@example.com",
            api_token="secret",
            token_expires_at=date(2027, 1, 1),
        )
        jira.write_credentials(written, self.path)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(jira.read_credentials(self.path), written)

    def test_a_missing_or_incomplete_credential_is_simply_absent(self):
        self.assertIsNone(jira.read_credentials(self.path))
        self.path.write_text('{"siteUrl": "https://x", "email": ""}', encoding="utf-8")
        self.assertIsNone(jira.read_credentials(self.path))

    def test_days_until_expiry_counts_down_and_goes_negative(self):
        from datetime import date

        credentials = jira.JiraCredentials("s", "e", "t", token_expires_at=date(2026, 1, 10))
        self.assertEqual(credentials.days_until_expiry(date(2026, 1, 1)), 9)
        self.assertEqual(credentials.days_until_expiry(date(2026, 1, 20)), -10)

    def test_an_unrecorded_expiry_is_unknown_rather_than_zero(self):
        self.assertIsNone(jira.JiraCredentials("s", "e", "t").days_until_expiry())

    def test_describing_a_credential_never_includes_the_token(self):
        described = jira.JiraCredentials("https://x", "a@example.com", "secret").describe()
        self.assertNotIn("secret", described)


class ErrorCauseTests(unittest.TestCase):
    """A failed probe is reported with its cause: four problems, four fixes."""

    def test_each_status_code_names_its_own_problem(self):
        self.assertEqual(jira.JiraError("x", 401).cause, "unauthorised")
        self.assertEqual(jira.JiraError("x", 403).cause, "forbidden")
        self.assertEqual(jira.JiraError("x", 404).cause, "notFound")
        self.assertEqual(jira.JiraError("x", 429).cause, "rateLimited")
        self.assertEqual(jira.JiraError("x", 500).cause, "httpError")

    def test_no_status_code_at_all_means_unreachable(self):
        # A laptop is offline most nights it is shut; this must never raise an
        # alarm on its own.
        self.assertEqual(jira.JiraError("x").cause, "unreachable")


class ProbeThrottleTests(unittest.TestCase):
    def test_a_probe_that_has_never_run_is_due(self):
        self.assertTrue(jira.probe_is_due(None))
        self.assertTrue(jira.probe_is_due({}))

    def test_a_probe_from_an_hour_ago_is_not_due(self):
        from datetime import datetime, timedelta, timezone

        now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        recent = {"checkedAt": (now - timedelta(hours=1)).isoformat()}
        self.assertFalse(jira.probe_is_due(recent, now))

    def test_a_probe_from_yesterday_is_due(self):
        from datetime import datetime, timedelta, timezone

        now = datetime(2026, 8, 28, 12, 0, tzinfo=timezone.utc)
        old = {"checkedAt": (now - timedelta(hours=25)).isoformat()}
        self.assertTrue(jira.probe_is_due(old, now))

    def test_an_unparseable_timestamp_is_due_rather_than_never(self):
        self.assertTrue(jira.probe_is_due({"checkedAt": "who knows"}))


class WritePlanTests(unittest.TestCase):
    """§9's table, as data — the column, the labels and whether a comment is written."""

    def setUp(self):
        self.source = jira.JiraQueueSource(
            jira.JiraCredentials("s", "e", "t"), PROJECT_KEY
        )

    def _plan(self, status, report=None):
        return self.source.plan_write("FCP-1", status, report or jira.OutcomeReport())

    def test_completed_goes_to_done_with_no_run_labels(self):
        plan = self._plan(queue_source.STATUS_COMPLETED)
        self.assertEqual(plan.column, jira.COLUMN_DONE)
        self.assertEqual(plan.add_labels, [])
        self.assertEqual(sorted(plan.remove_labels), sorted(jira.RUN_LABELS))
        self.assertIn("completed", plan.comment)

    def test_an_unmerged_branch_goes_to_in_review_and_is_named_in_the_comment(self):
        # The `:detail` convention stops at this boundary: the status name picks
        # the column, and the branch — the one thing that status exists to carry
        # — goes into the comment.
        plan = self._plan(queue_source.unmerged_status("add-widget"))
        self.assertEqual(plan.column, jira.COLUMN_IN_REVIEW)
        self.assertEqual(plan.add_labels, [jira.LABEL_UNMERGED])
        self.assertEqual(plan.remove_labels, [jira.LABEL_ERROR])
        self.assertIn("add-widget", plan.comment)

    def test_an_error_goes_to_in_review_under_the_other_label(self):
        plan = self._plan(queue_source.STATUS_ERROR, jira.OutcomeReport(exit_code=2))
        self.assertEqual(plan.column, jira.COLUMN_IN_REVIEW)
        self.assertEqual(plan.add_labels, [jira.LABEL_ERROR])
        self.assertIn("Exit code: 2", plan.comment)

    def test_a_session_limit_returns_the_card_to_to_do_and_writes_no_comment(self):
        # The prompt never really ran. A comment here would fill the card with
        # noise every time a week ran out of window.
        plan = self._plan(queue_source.STATUS_TODO)
        self.assertEqual(plan.column, jira.COLUMN_TODO)
        self.assertIsNone(plan.comment)

    def test_claudes_own_account_is_the_body_of_the_comment(self):
        plan = self._plan(
            queue_source.STATUS_COMPLETED,
            jira.OutcomeReport(result_text="I renamed the thing.", turns=7, cost_usd=0.42),
        )
        self.assertIn("I renamed the thing.", plan.comment)
        self.assertIn("7 turns", plan.comment)
        self.assertIn("$0.42", plan.comment)

    def test_a_plan_survives_being_written_to_disk_and_read_back(self):
        plan = self._plan(queue_source.STATUS_ERROR)
        self.assertEqual(jira.OutcomeWrite.from_json(plan.to_json()), plan)

    def test_a_malformed_stored_plan_is_dropped_rather_than_trusted(self):
        self.assertIsNone(jira.OutcomeWrite.from_json({"issueKey": "FCP-1", "column": "nope"}))
        self.assertIsNone(jira.OutcomeWrite.from_json("not a dict"))


# --------------------------------------------------------------------------- #
# Against the stub
# --------------------------------------------------------------------------- #


class ReadingTheQueueTests(StubJiraTestCase):
    def test_the_first_card_in_to_do_is_what_runs_next(self):
        first = self.state.add_issue("First", jira.adf_document("Do the first thing."))
        self.state.add_issue("Second", jira.adf_document("Do the second thing."))
        entry = self.source.next_todo()
        self.assertEqual(entry.handle, first)
        self.assertEqual(entry.prompt, "Do the first thing.")
        self.assertEqual(entry.status, queue_source.STATUS_TODO)

    def test_cards_in_other_columns_are_not_picked_up(self):
        self.state.add_issue("Drafted", jira.adf_document("Not ready."), status="Draft")
        self.state.add_issue("Done", jira.adf_document("Finished."), status="Done")
        self.assertIsNone(self.source.next_todo())
        self.assertFalse(self.source.holds_a_todo())

    def test_the_read_is_ordered_by_rank(self):
        self.state.add_issue("First", jira.adf_document("One."))
        self.state.add_issue("Second", jira.adf_document("Two."))
        self.source.next_todo()
        search = [call for call in self.state.requests if call[1] == "/rest/api/3/search/jql"][0]
        self.assertIn("ORDER BY Rank ASC", search[2]["jql"][0])

    def test_a_dead_credential_is_unavailable_rather_than_an_empty_queue(self):
        # The distinction §5.5 turns on: running nothing is safe, and treating
        # this as "nothing queued" would be a lie the summary then repeats.
        self.state.next_status_code = 401
        with self.assertRaises(queue_source.QueueUnavailable):
            self.source.next_todo()

    def test_holds_a_todo_reports_false_and_logs_when_jira_is_unreachable(self):
        self.state.next_status_code = 401
        self.assertFalse(self.source.holds_a_todo())
        self.assertTrue(any("Could not read" in line for line in self.logged))

    def test_remaining_prompts_exclude_the_ones_already_attempted(self):
        self.state.add_issue("First", jira.adf_document("One."))
        self.state.add_issue("Second", jira.adf_document("Two."))
        self.assertEqual(self.source.remaining_todo_prompts(["One."]), ["Two."])


class PickingACardUpTests(StubJiraTestCase):
    def test_starting_moves_the_card_and_clears_both_run_labels(self):
        # Re-queueing has to stay a single gesture: drag it back to To Do, and
        # nothing else.
        key = self.state.add_issue(
            "Retry me", jira.adf_document("Do it."), labels=[jira.LABEL_ERROR]
        )
        self.source.start(self.source.next_todo())
        self.assertEqual(self.status_of(key), "In Progress")
        self.assertEqual(self.labels_of(key), [])

    def test_a_failed_start_does_not_stop_the_prompt_running(self):
        self.state.add_issue("Run me", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.state.next_status_code = 500
        self.source.start(entry)  # Must not raise: the prompt is worth running.
        self.assertTrue(any("In Progress" in line for line in self.logged))

    def test_abandoning_puts_the_card_back_in_to_do(self):
        key = self.state.add_issue("Cancel me", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.source.start(entry)
        self.source.abandon(entry)
        self.assertEqual(self.status_of(key), "To Do")

    def test_a_card_stranded_in_progress_is_swept_back(self):
        # launchd will not run two instances of one label, so a card in
        # In Progress at the start of a run can only be an earlier run's wreckage.
        key = self.state.add_issue("Stranded", jira.adf_document("x"), status="In Progress")
        self.source.sweep_stale()
        self.assertEqual(self.status_of(key), "To Do")


class RecordingTheOutcomeTests(StubJiraTestCase):
    def _run_and_record(self, status, report=None):
        key = self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.source.start(entry)
        left_as = self.source.record_outcome(entry, status, report)
        return key, left_as

    def test_a_completed_prompt_lands_in_done_with_its_own_account(self):
        key, left_as = self._run_and_record(
            queue_source.STATUS_COMPLETED,
            jira.OutcomeReport(result_text="Renamed the helper.", turns=4),
        )
        self.assertEqual(left_as, queue_source.STATUS_COMPLETED)
        self.assertEqual(self.status_of(key), "Done")
        self.assertEqual(self.labels_of(key), [])
        self.assertIn("Renamed the helper.", self.state.issues[key]["comments"][0])

    def test_work_left_on_a_branch_lands_in_in_review_under_its_label(self):
        key, _ = self._run_and_record(
            queue_source.unmerged_status("add-widget"),
            jira.OutcomeReport(result_text="Left it on a branch.", working_directory="/tmp/x"),
        )
        self.assertEqual(self.status_of(key), "In Review")
        self.assertEqual(self.labels_of(key), [jira.LABEL_UNMERGED])
        comment = self.state.issues[key]["comments"][0]
        self.assertIn("add-widget", comment)
        self.assertIn("/tmp/x", comment)

    def test_a_failure_lands_in_the_same_column_under_the_other_label(self):
        key, _ = self._run_and_record(queue_source.STATUS_ERROR, jira.OutcomeReport(exit_code=1))
        self.assertEqual(self.status_of(key), "In Review")
        self.assertEqual(self.labels_of(key), [jira.LABEL_ERROR])

    def test_a_session_limit_returns_the_card_to_to_do_silently(self):
        key, _ = self._run_and_record(queue_source.STATUS_TODO)
        self.assertEqual(self.status_of(key), "To Do")
        self.assertEqual(self.state.issues[key]["comments"], [])

    def test_one_comment_per_attempt_rather_than_one_per_card(self):
        # What prompts.txt structurally cannot do: a card re-queued three times
        # reads as three attempts with three accounts.
        key = self.state.add_issue("Work", jira.adf_document("Do it."))
        for attempt in range(3):
            entry = self.source.next_todo() or queue_source.QueueEntry(
                queue_source.STATUS_TODO, key, None, "Do it."
            )
            self.source.record_outcome(
                entry,
                queue_source.STATUS_ERROR,
                jira.OutcomeReport(result_text="Attempt {}".format(attempt)),
            )
            self.source._transition(key, jira.COLUMN_TODO)  # noqa: SLF001 - stands in for a drag
        self.assertEqual(len(self.state.issues[key]["comments"]), 3)


class WriteFailureTests(StubJiraTestCase):
    """The expensive failure: an unrecorded outcome means the prompt runs again."""

    def test_an_outcome_that_will_not_write_is_set_aside_rather_than_dropped(self):
        key = self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.state.fail_writes = True
        self.source.record_outcome(entry, queue_source.STATUS_COMPLETED)

        pending = jira.read_pending_writes()
        self.assertEqual([plan.issue_key for plan in pending], [key])
        self.assertEqual(pending[0].column, jira.COLUMN_DONE)
        self.assertTrue(any("set aside" in line for line in self.logged))

    def test_the_next_run_drains_what_the_last_one_could_not_write(self):
        key = self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.state.fail_writes = True
        self.source.record_outcome(entry, queue_source.STATUS_COMPLETED)

        self.state.fail_writes = False
        self.assertEqual(self.source.drain_pending_writes(), 1)
        self.assertEqual(self.status_of(key), "Done")
        self.assertEqual(jira.read_pending_writes(), [])

    def test_a_write_that_still_will_not_land_stays_pending(self):
        self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.state.fail_writes = True
        self.source.record_outcome(entry, queue_source.STATUS_COMPLETED)
        self.assertEqual(self.source.drain_pending_writes(), 0)
        self.assertEqual(len(jira.read_pending_writes()), 1)

    def test_jira_going_away_entirely_sets_the_outcome_aside_rather_than_raising(self):
        # The statuses are resolved lazily, so the first call a write makes can
        # be the one that discovers Jira is unreachable — and that arrives as
        # QueueUnavailable rather than JiraError. No write path may take the run
        # down: the prompt has already run, and its outcome is the expensive
        # thing to lose.
        self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.source._statuses = None  # noqa: SLF001 - forces the lazy resolve to happen again
        self.stop_jira()  # Jira, gone entirely, mid-run.
        self.source.record_outcome(entry, queue_source.STATUS_COMPLETED)
        self.assertEqual(len(jira.read_pending_writes()), 1)

    def test_draining_an_empty_file_does_nothing(self):
        self.assertEqual(self.source.drain_pending_writes(), 0)


class StatusDiscoveryTests(StubJiraTestCase):
    def test_the_five_columns_are_found_by_name(self):
        statuses = jira.resolve_project_statuses(self.source.client, PROJECT_KEY)
        self.assertEqual(statuses.missing, [])
        self.assertEqual(statuses.name_for(jira.COLUMN_IN_REVIEW), "In Review")

    def test_a_missing_column_is_reported_rather_than_discovered_at_2am(self):
        self.state.statuses = ["To Do", "In Progress", "Done"]
        statuses = jira.resolve_project_statuses(self.source.client, PROJECT_KEY)
        self.assertEqual(sorted(statuses.missing), ["Draft", "In Review"])

    def test_a_renamed_column_is_matched_by_the_configured_name(self):
        self.state.statuses = ["Draft", "Next up", "In Progress", "In Review", "Done"]
        statuses = jira.resolve_project_statuses(
            self.source.client, PROJECT_KEY, {jira.COLUMN_TODO: "Next up"}
        )
        self.assertEqual(statuses.missing, [])
        self.assertEqual(statuses.name_for(jira.COLUMN_TODO), "Next up")

    def test_matching_ignores_case(self):
        self.state.statuses = ["draft", "TO DO", "In Progress", "in review", "Done"]
        statuses = jira.resolve_project_statuses(self.source.client, PROJECT_KEY)
        self.assertEqual(statuses.missing, [])

    def test_a_missing_column_does_not_take_the_run_down(self):
        self.state.statuses = ["To Do", "In Progress", "Done"]
        self.state.add_issue("Work", jira.adf_document("Do it."))
        entry = self.source.next_todo()
        self.source.record_outcome(entry, queue_source.STATUS_ERROR)
        self.assertTrue(any("set aside" in line for line in self.logged))


class ProbeTests(StubJiraTestCase):
    def test_a_working_credential_probes_clean(self):
        status = jira.probe_credentials(self.credentials, PROJECT_KEY)
        self.assertTrue(status.ok)
        self.assertTrue(status.configured)
        self.assertEqual(status.project_key, PROJECT_KEY)

    def test_a_dead_credential_is_reported_with_its_cause(self):
        self.state.next_status_code = 401
        status = jira.probe_credentials(self.credentials, PROJECT_KEY)
        self.assertFalse(status.ok)
        self.assertEqual(status.cause, "unauthorised")

    def test_no_credential_at_all_is_not_configured_rather_than_broken(self):
        status = jira.probe_credentials(None)
        self.assertFalse(status.configured)
        self.assertEqual(status.cause, "notConfigured")

    def test_a_probed_status_never_carries_the_token(self):
        payload = json.dumps(jira.probe_credentials(self.credentials, PROJECT_KEY).to_json())
        self.assertNotIn("token", payload)


if __name__ == "__main__":
    unittest.main()
