#!/usr/bin/env python3
"""Unit tests for `codex_usage.py` — see `plans/codex-subscription-usage.md`.

`test-usage-host.py` covers the `getCodexUsage` dispatch itself, kept off the
real network by pointing at an address nothing listens on. The tests here are
the deeper logic that dispatch test cannot reach without a live Codex login:
window classification by `limit_window_seconds` (and its primary/secondary
fallback), the JWT `exp` check, the credential file round trip, and the
refresh-and-retry flow — the last of those against a stub HTTP server in this
process, the same trick `AUTONOMOUS_WORK_JIRA_BASE_URL` plays for Jira.
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import codex_usage  # noqa: E402  (must follow the sys.path line above)


def _jwt(claims):
    # type: (dict) -> str
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode("ascii")
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode("utf-8")).rstrip(b"=").decode("ascii")
    return "{}.{}.".format(header, payload)


class WindowClassificationTests(unittest.TestCase):
    def test_matches_by_duration_not_slot(self):
        # The plan is explicit that `primary` is not reliably "the 5-hour one".
        self.assertEqual(codex_usage.classify_window_kind(codex_usage.SESSION_WINDOW_SECONDS), "fiveHour")
        self.assertEqual(codex_usage.classify_window_kind(codex_usage.WEEKLY_WINDOW_SECONDS), "sevenDay")
        self.assertIsNone(codex_usage.classify_window_kind(3600))
        self.assertIsNone(codex_usage.classify_window_kind(None))

    def test_falls_back_to_slot_when_duration_missing(self):
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 40},
                "secondary_window": {"used_percent": 55},
            }
        }
        windows = codex_usage.normalise_windows(payload)
        kinds = {window["kind"]: window for window in windows}
        self.assertEqual(kinds["fiveHour"]["utilizationPercent"], 40)
        self.assertEqual(kinds["sevenDay"]["utilizationPercent"], 55)

    def test_a_sole_weekly_limit_moved_into_the_primary_slot_is_still_weekly(self):
        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 70,
                    "limit_window_seconds": codex_usage.WEEKLY_WINDOW_SECONDS,
                    "reset_after_seconds": 1000,
                },
            }
        }
        windows = codex_usage.normalise_windows(payload)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["kind"], "sevenDay")

    def test_drops_a_window_with_no_usable_percent(self):
        payload = {"rate_limit": {"primary_window": {"limit_window_seconds": 18000}}}
        self.assertEqual(codex_usage.normalise_windows(payload), [])

    def test_drops_additional_rate_limits(self):
        payload = {
            "rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18000}},
            "additional_rate_limits": [{"limit_name": "spark", "rate_limit": {"used_percent": 99}}],
        }
        windows = codex_usage.normalise_windows(payload)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["kind"], "fiveHour")

    def test_a_second_window_classified_the_same_way_is_dropped_not_overwritten(self):
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10, "limit_window_seconds": 18000},
                # Both report the 5-hour duration — a schema surprise, not a
                # real pair of session windows.
                "secondary_window": {"used_percent": 90, "limit_window_seconds": 18000},
            }
        }
        windows = codex_usage.normalise_windows(payload)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["utilizationPercent"], 10)

    def test_reports_a_real_start_from_the_actual_span(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 20,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 3600,
                },
            }
        }
        windows = codex_usage.normalise_windows(payload, now=now)
        window = windows[0]
        self.assertEqual(window["resetsAt"], "2026-01-01T01:00:00+00:00")
        self.assertEqual(window["startedAt"], "2025-12-31T20:00:00+00:00")

    def test_reset_at_epoch_seconds_wins_over_reset_after_seconds(self):
        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 20,
                    "limit_window_seconds": 18000,
                    "reset_at": 1735696800,  # 2025-01-01T02:00:00Z
                    "reset_after_seconds": 999999,
                },
            }
        }
        windows = codex_usage.normalise_windows(payload)
        self.assertEqual(windows[0]["resetsAt"], "2025-01-01T02:00:00+00:00")


class TokenExpiryTests(unittest.TestCase):
    def test_needs_refresh_within_slack_of_expiry(self):
        now = 1_000_000
        token = _jwt({"exp": now + 100})
        self.assertTrue(codex_usage.token_needs_refresh(token, now=now, slack_seconds=300))

    def test_does_not_need_refresh_well_before_expiry(self):
        now = 1_000_000
        token = _jwt({"exp": now + 3600})
        self.assertFalse(codex_usage.token_needs_refresh(token, now=now, slack_seconds=300))

    def test_an_undecodable_token_is_not_treated_as_needing_refresh(self):
        # Nothing to gain from refreshing blind — an actual 401 triggers the
        # same refresh path anyway.
        self.assertFalse(codex_usage.token_needs_refresh("not-a-jwt"))
        self.assertFalse(codex_usage.token_needs_refresh(_jwt({"sub": "no-exp-claim"})))


class AuthFileRoundTripTests(unittest.TestCase):
    def test_missing_file_reads_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(codex_usage._read_auth_file(Path(directory) / "auth.json"))

    def test_malformed_file_reads_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_text("not json", encoding="utf-8")
            self.assertIsNone(codex_usage._read_auth_file(path))

    def test_a_file_with_no_access_token_reads_as_none(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_text(json.dumps({"tokens": {}}), encoding="utf-8")
            self.assertIsNone(codex_usage._read_auth_file(path))

    def test_write_preserves_unknown_fields_and_sets_mode_0600(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "auth.json"
            path.write_text(
                json.dumps(
                    {
                        "tokens": {"access_token": "old", "refresh_token": "old-refresh"},
                        "OPENAI_API_KEY": None,
                        "last_refresh": "2020-01-01T00:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            credential = codex_usage._read_auth_file(path)
            credential["access_token"] = "new"
            credential["refresh_token"] = "new-refresh"

            codex_usage._write_auth_file(path, credential)

            rewritten = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(rewritten["tokens"]["access_token"], "new")
            self.assertEqual(rewritten["tokens"]["refresh_token"], "new-refresh")
            self.assertIn("OPENAI_API_KEY", rewritten)
            self.assertNotEqual(rewritten["last_refresh"], "2020-01-01T00:00:00Z")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class _Handler(BaseHTTPRequestHandler):
    state = None  # type: dict

    def log_message(self, *_args):
        pass

    def _reply(self, status_code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        state = self.state
        state["usage_requests"].append(self.headers.get("Authorization"))
        if state["usage_status"] == 200:
            return self._reply(200, state["usage_payload"])
        return self._reply(state["usage_status"], {"error": "unauthorized"})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler's naming
        state = self.state
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        state["refresh_requests"].append(body)
        if state["refresh_status"] == 200:
            return self._reply(200, state["refresh_payload"])
        return self._reply(state["refresh_status"], {"error": state["refresh_error_code"]})


class ReadCodexUsageAgainstAStubServerTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            "usage_status": 200,
            "usage_payload": {
                "rate_limit": {
                    "primary_window": {"used_percent": 30, "limit_window_seconds": 18000},
                    "secondary_window": {"used_percent": 45, "limit_window_seconds": 604800},
                }
            },
            "usage_requests": [],
            "refresh_status": 200,
            "refresh_payload": {"access_token": "refreshed-access-token"},
            "refresh_error_code": "refresh_token_expired",
            "refresh_requests": [],
        }

        handler = type("Handler", (_Handler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        base_url = "http://127.0.0.1:{}".format(self.server.server_address[1])
        self._previous_usage_url = codex_usage.CODEX_USAGE_URL
        self._previous_refresh_url = codex_usage.CODEX_TOKEN_REFRESH_URL
        codex_usage.CODEX_USAGE_URL = base_url + "/usage"
        codex_usage.CODEX_TOKEN_REFRESH_URL = base_url + "/refresh"

        self.temporary_directory = tempfile.TemporaryDirectory()
        self.auth_file = Path(self.temporary_directory.name) / "auth.json"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=5)
        codex_usage.CODEX_USAGE_URL = self._previous_usage_url
        codex_usage.CODEX_TOKEN_REFRESH_URL = self._previous_refresh_url
        self.temporary_directory.cleanup()

    def _write_auth_file(self, access_token, refresh_token="a-refresh-token"):
        self.auth_file.write_text(
            json.dumps(
                {
                    "tokens": {
                        "access_token": access_token,
                        "refresh_token": refresh_token,
                        "account_id": "acct-1",
                    },
                }
            ),
            encoding="utf-8",
        )

    def test_a_healthy_token_reaches_the_usage_endpoint_and_reports_both_windows(self):
        self._write_auth_file(_jwt({"exp": time.time() + 3600}))
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        self.assertTrue(result["ok"])
        kinds = {window["kind"]: window["utilizationPercent"] for window in result["windows"]}
        self.assertEqual(kinds, {"fiveHour": 30, "sevenDay": 45})
        self.assertTrue(self.state["usage_requests"][0].startswith("Bearer "))

    def test_a_near_expiry_token_is_refreshed_before_the_usage_call(self):
        self._write_auth_file(_jwt({"exp": time.time() + 30}))
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        self.assertTrue(result["ok"])
        self.assertEqual(self.state["usage_requests"][0], "Bearer refreshed-access-token")
        rewritten = json.loads(self.auth_file.read_text(encoding="utf-8"))
        self.assertEqual(rewritten["tokens"]["access_token"], "refreshed-access-token")

    def test_a_fresh_401_gets_exactly_one_refresh_and_retry(self):
        self._write_auth_file(_jwt({"exp": time.time() + 3600}))
        # The token looks healthy, so the proactive check will not refresh it —
        # only the 401 itself should trigger the retry.
        self.state["usage_status"] = 401
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        # The stub always answers 401, so the retried call fails too — this is
        # exercising that exactly one retry happens, not that it succeeds.
        self.assertFalse(result["ok"])
        self.assertEqual(len(self.state["refresh_requests"]), 1)
        self.assertEqual(len(self.state["usage_requests"]), 2)

    def test_an_expired_refresh_token_is_reported_as_not_logged_in(self):
        self._write_auth_file(_jwt({"exp": time.time() + 30}))
        self.state["refresh_status"] = 400
        self.state["refresh_error_code"] = "refresh_token_expired"
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "NOT_LOGGED_IN")

    def test_a_transient_refresh_failure_falls_through_to_the_existing_token(self):
        self._write_auth_file(_jwt({"exp": time.time() + 30}))
        self.state["refresh_status"] = 500
        self.state["refresh_error_code"] = "server_error"
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        # The existing (still technically valid) token is tried anyway.
        self.assertTrue(result["ok"])

    def test_missing_auth_file_is_not_logged_in_without_any_network_call(self):
        result = codex_usage.read_codex_usage(auth_file=Path(self.temporary_directory.name) / "missing.json")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "NOT_LOGGED_IN")
        self.assertEqual(self.state["usage_requests"], [])

    def test_a_malformed_usage_response_is_reported_cleanly(self):
        self._write_auth_file(_jwt({"exp": time.time() + 3600}))
        self.state["usage_payload"] = {"plan_type": "pro"}  # no rate_limit at all
        result = codex_usage.read_codex_usage(auth_file=self.auth_file)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "MALFORMED_RESPONSE")


if __name__ == "__main__":
    unittest.main()
