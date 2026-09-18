#!/usr/bin/env python3
"""Codex/ChatGPT subscription usage, read for display only.

See `plans/codex-subscription-usage.md`. This module reads the Codex CLI's own
credential (`~/.codex/auth.json`), calls the same undocumented usage endpoint
the CLI itself polls, and hands back normalised `fiveHour` / `sevenDay` windows.
Nothing here feeds the autonomous-work scheduler — that is a hard constraint
from the plan, not an oversight: this module is read, normalised and cached by
the extension, and nothing downstream of it touches the scheduler, the pace
gate, or `claude-usage.json`.

**Constraints inherited from `usage-host.py`, and non-negotiable:**

* **stdlib-only, and 3.9-compatible.** Chrome spawns the host with an
  environment we do not control, so a dependency would fail in ways that are
  near-undebuggable from inside a browser.
* **Never write the raw token to `usage-host.log`.** Only the outcome —
  success, or an error code — is worth logging, the same restraint
  `queue_source_jira.py` takes with the Jira API token.
* **`read_codex_usage` never raises.** A credential or network hiccup is not
  worth losing a `getCodexUsage` reply over; see its docstring.

**The percentage is Codex's own `used_percent`, verbatim.** Never estimated
from local token counts or session-log scanning — see the plan's "The
percentage must come from Codex's own servers" section for why.
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _ignore(_message):
    # type: (str) -> None
    pass


def _environment_path(name, default):
    # type: (str, Path) -> Path
    raw_value = os.environ.get(name)
    return Path(os.path.expanduser(raw_value)) if raw_value else default


# `$CODEX_HOME/auth.json` when the Codex CLI has that set, else `~/.codex/auth.json`
# — the same fallback `openusage` and `codex-reset-checker` use. Overridable again
# for the tests, the same trick `AUTONOMOUS_WORK_JIRA_CREDENTIALS_FILE` plays.
_CODEX_HOME = os.environ.get("CODEX_HOME")
_DEFAULT_AUTH_FILE = (
    Path(os.path.expanduser(_CODEX_HOME)) / "auth.json"
    if _CODEX_HOME
    else Path.home() / ".codex" / "auth.json"
)
AUTH_FILE = _environment_path("CODEX_USAGE_AUTH_FILE", _DEFAULT_AUTH_FILE)

# Overridable so the tests can point the whole transport at a local stub — the
# same trick `AUTONOMOUS_WORK_JIRA_BASE_URL` plays for Jira.
CODEX_USAGE_URL = os.environ.get("CODEX_USAGE_URL_OVERRIDE") or "https://chatgpt.com/backend-api/wham/usage"
CODEX_TOKEN_REFRESH_URL = (
    os.environ.get("CODEX_USAGE_TOKEN_REFRESH_URL_OVERRIDE") or "https://auth.openai.com/oauth/token"
)
# The Codex CLI's own OAuth client ID — public, embedded in the CLI binary
# itself (confirmed in openusage's CodexUsageClient.swift), not a secret.
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

SESSION_WINDOW_SECONDS = 5 * 60 * 60
WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

# The same 5-minute slack the `codex` CLI itself uses before it refreshes.
REFRESH_SLACK_SECONDS = 5 * 60

REQUEST_TIMEOUT_SECONDS = 10

# OAuth error codes that mean the login itself is gone, not a transient hiccup
# — mapped the way `openusage`'s `CodexAuthStore` does.
REFRESH_LOGIN_REQUIRED_CODES = (
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
)


class _CodexHttpError(Exception):
    def __init__(self, status_code, body):
        # type: (int, str) -> None
        super().__init__("Codex usage endpoint returned {}".format(status_code))
        self.status_code = status_code
        self.body = body


class _CodexNetworkError(Exception):
    pass


class _RefreshRequiresLogin(Exception):
    """The refresh token itself is dead — only `codex login` fixes this."""


class _RefreshTransientFailure(Exception):
    """A 5xx or network failure refreshing — worth retrying next poll, not a login problem."""


# --------------------------------------------------------------------------- #
# The credential file
# --------------------------------------------------------------------------- #


def _read_auth_file(path):
    # type: (Path) -> dict | None
    """The stored credential, or None if there is not a usable one on disk.

    Never raises: a missing or malformed `auth.json` (Codex never installed, or
    never logged in) is an ordinary state, not a fault.
    """
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict):
        return None

    tokens = stored.get("tokens")
    if not isinstance(tokens, dict):
        return None

    access_token = tokens.get("access_token")
    if not (isinstance(access_token, str) and access_token.strip()):
        return None

    refresh_token = tokens.get("refresh_token")
    id_token = tokens.get("id_token")
    account_id = tokens.get("account_id")

    return {
        "access_token": access_token,
        "refresh_token": refresh_token if isinstance(refresh_token, str) else None,
        "id_token": id_token if isinstance(id_token, str) else None,
        "account_id": account_id if isinstance(account_id, str) else None,
        # Kept verbatim so a rewrite after a refresh never drops a field this
        # module does not know about (`OPENAI_API_KEY`, for instance).
        "_raw": stored,
    }


def _write_auth_file(path, credential):
    # type: (Path, dict) -> None
    """Replace `auth.json` atomically, mode 0600 from the moment it exists.

    Follows `queue_source_jira.write_credentials` exactly, not
    `usage-host.py`'s `write_snapshot` — that one leaves the temp file at
    default permissions, which would land a rotated refresh token
    world-readable for the (short) window before nothing chmods it back down.
    A `codex` process refreshing concurrently can never observe a
    half-written file, since the replace is atomic.
    """
    raw = dict(credential.get("_raw") or {})
    tokens = dict(raw.get("tokens") or {})
    tokens["access_token"] = credential["access_token"]
    if credential.get("refresh_token") is not None:
        tokens["refresh_token"] = credential["refresh_token"]
    if credential.get("id_token") is not None:
        tokens["id_token"] = credential["id_token"]
    raw["tokens"] = tokens
    raw["last_refresh"] = datetime.now(timezone.utc).isoformat()

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = None
    try:
        handle_descriptor, temporary_name = tempfile.mkstemp(dir=str(path.parent))
        temporary_path = Path(temporary_name)
        os.fchmod(handle_descriptor, 0o600)
        with os.fdopen(handle_descriptor, "w", encoding="utf-8") as temp_handle:
            json.dump(raw, temp_handle, indent=2)
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


# --------------------------------------------------------------------------- #
# The access token's own expiry
# --------------------------------------------------------------------------- #


def _decode_jwt_exp(access_token):
    # type: (str) -> float | None
    """The `exp` claim, read without verifying the signature.

    This is a local trust decision about our own stored token, not an auth
    check — the server is what actually enforces the token's validity.
    """
    parts = access_token.split(".")
    if len(parts) != 3:
        return None
    segment = parts[1]
    padding = "=" * (-len(segment) % 4)
    try:
        decoded = base64.urlsafe_b64decode(segment + padding)
        claims = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    return exp if isinstance(exp, (int, float)) else None


def token_needs_refresh(access_token, now=None, slack_seconds=REFRESH_SLACK_SECONDS):
    # type: (str, float | None, int) -> bool
    """Within `slack_seconds` of expiry, or already past it.

    An access token this module cannot decode is not treated as needing a
    refresh — there is nothing to gain from refreshing blind, and an actual
    401 from the usage call triggers the same refresh path anyway.
    """
    exp = _decode_jwt_exp(access_token)
    if exp is None:
        return False
    moment = now if now is not None else time.time()
    return exp - moment <= slack_seconds


# --------------------------------------------------------------------------- #
# Refreshing the access token
# --------------------------------------------------------------------------- #


def _read_error_body(error):
    # type: (urllib.error.HTTPError) -> str
    try:
        return error.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - the body is a nicety, never the point
        return ""


def _oauth_error_code(body):
    # type: (str) -> str | None
    try:
        decoded = json.loads(body)
    except ValueError:
        return None
    if isinstance(decoded, dict):
        value = decoded.get("error")
        return value if isinstance(value, str) else None
    return None


def _refresh_access_token(credential, auth_file, log=_ignore):
    # type: (dict, Path, object) -> dict
    """POST a refresh, rotate `auth.json`, and return the updated credential.

    Raises `_RefreshRequiresLogin` when the refresh token itself is dead, and
    `_RefreshTransientFailure` for anything that might clear up on its own —
    the caller decides what each means for the reply it sends back.
    """
    refresh_token = credential.get("refresh_token")
    if not refresh_token:
        raise _RefreshRequiresLogin()

    body = json.dumps(
        {
            "grant_type": "refresh_token",
            "client_id": CODEX_OAUTH_CLIENT_ID,
            "refresh_token": refresh_token,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        url=CODEX_TOKEN_REFRESH_URL,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(
            request, timeout=REQUEST_TIMEOUT_SECONDS, context=ssl.create_default_context()
        ) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        error_code = _oauth_error_code(_read_error_body(error))
        log("Codex token refresh failed ({}): {}".format(error.code, error_code or "unrecognised"))
        if error_code in REFRESH_LOGIN_REQUIRED_CODES:
            raise _RefreshRequiresLogin()
        raise _RefreshTransientFailure("refresh returned {}".format(error.code))
    except (urllib.error.URLError, OSError) as error:
        log("Codex token refresh failed: {}".format(error))
        raise _RefreshTransientFailure(str(error))

    try:
        rotated = json.loads(raw)
    except ValueError:
        raise _RefreshTransientFailure("refresh response was not JSON")
    if not isinstance(rotated, dict) or not isinstance(rotated.get("access_token"), str):
        raise _RefreshTransientFailure("refresh response carried no access_token")

    new_credential = dict(credential)
    for key in ("access_token", "refresh_token", "id_token"):
        if isinstance(rotated.get(key), str):
            new_credential[key] = rotated[key]

    _write_auth_file(auth_file, new_credential)
    log("Codex access token refreshed")
    return new_credential


# --------------------------------------------------------------------------- #
# The usage call
# --------------------------------------------------------------------------- #


def _call_usage_endpoint(access_token, account_id=None, log=_ignore):
    # type: (str, str | None, object) -> dict
    request = urllib.request.Request(
        url=CODEX_USAGE_URL,
        headers={
            "Authorization": "Bearer {}".format(access_token),
            "Accept": "application/json",
            "User-Agent": "claude-usage-optimizer/codex-usage",
        },
    )
    if account_id:
        request.add_header("ChatGPT-Account-Id", account_id)

    try:
        with urllib.request.urlopen(
            request, timeout=REQUEST_TIMEOUT_SECONDS, context=ssl.create_default_context()
        ) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        raise _CodexHttpError(error.code, _read_error_body(error))
    except (urllib.error.URLError, OSError) as error:
        raise _CodexNetworkError(str(error))

    try:
        parsed = json.loads(raw)
    except ValueError as error:
        raise _CodexNetworkError("Could not parse Codex's response: {}".format(error))
    if not isinstance(parsed, dict):
        raise _CodexNetworkError("Codex's response was not an object")
    return parsed


def _error_for_http_failure(error):
    # type: (_CodexHttpError) -> dict
    if error.status_code in (401, 403):
        return {
            "code": "NOT_LOGGED_IN",
            "message": "Codex's login has expired — run `codex login` again.",
            "httpStatus": error.status_code,
        }
    return {
        "code": "HTTP_ERROR",
        "message": "chatgpt.com returned an unexpected response ({}).".format(error.status_code),
        "httpStatus": error.status_code,
    }


# --------------------------------------------------------------------------- #
# Turning the response into `fiveHour` / `sevenDay` windows
# --------------------------------------------------------------------------- #


def classify_window_kind(limit_window_seconds):
    # type: (object) -> str | None
    """Match the window's own reported duration, not its slot in the payload.

    Codex can move a temporarily sole weekly limit into the primary slot, so
    `primary` is not reliably "the 5-hour one" — see the plan's note on this.
    """
    if limit_window_seconds == SESSION_WINDOW_SECONDS:
        return "fiveHour"
    if limit_window_seconds == WEEKLY_WINDOW_SECONDS:
        return "sevenDay"
    return None


def _normalise_window_fields(window, kind, now=None):
    # type: (dict, str, datetime | None) -> dict | None
    used_percent = window.get("used_percent")
    if not isinstance(used_percent, (int, float)):
        return None

    resets_at_epoch = window.get("reset_at")
    reset_after_seconds = window.get("reset_after_seconds")
    limit_window_seconds = window.get("limit_window_seconds")
    moment = now or datetime.now(timezone.utc)

    resets_at = None
    if isinstance(resets_at_epoch, (int, float)):
        resets_at = datetime.fromtimestamp(resets_at_epoch, tz=timezone.utc)
    elif isinstance(reset_after_seconds, (int, float)):
        resets_at = moment + timedelta(seconds=reset_after_seconds)

    # A real reported start, not the `resetsAt - nominal duration` guess the
    # Claude side is forced into — Codex tells us the actual span.
    started_at = None
    if resets_at is not None and isinstance(limit_window_seconds, (int, float)):
        started_at = resets_at - timedelta(seconds=limit_window_seconds)

    return {
        "kind": kind,
        "utilizationPercent": used_percent,
        "resetsAt": resets_at.isoformat() if resets_at is not None else None,
        "startedAt": started_at.isoformat() if started_at is not None else None,
    }


def normalise_windows(payload, log=_ignore, now=None):
    # type: (dict, object, datetime | None) -> list
    """`rate_limit.primary_window` / `secondary_window`, classified and normalised.

    `additional_rate_limits` (the Spark/model-specific limits) is dropped
    entirely — out of scope per the plan's Goal.
    """
    rate_limit = payload.get("rate_limit") if isinstance(payload, dict) else None
    if not isinstance(rate_limit, dict):
        return []

    slots = []
    primary = rate_limit.get("primary_window")
    secondary = rate_limit.get("secondary_window")
    if isinstance(primary, dict):
        slots.append(("primary", primary))
    if isinstance(secondary, dict):
        slots.append(("secondary", secondary))

    # Only used when a slot's own `limit_window_seconds` is missing or
    # unrecognised — the compatibility fallback the plan (and `openusage`)
    # describe, never the primary source of truth.
    fallback_kind_by_slot = {"primary": "fiveHour", "secondary": "sevenDay"}

    windows = []
    used_kinds = set()
    for slot, window in slots:
        kind = classify_window_kind(window.get("limit_window_seconds"))
        if kind is None:
            kind = fallback_kind_by_slot[slot]
            log(
                "Codex {} window has no recognised limit_window_seconds — assuming {}".format(
                    slot, kind
                )
            )
        if kind in used_kinds:
            log(
                "Codex {} window classified as {}, which a previous window already claimed — dropping it".format(
                    slot, kind
                )
            )
            continue

        normalised = _normalise_window_fields(window, kind, now=now)
        if normalised is None:
            continue
        used_kinds.add(kind)
        windows.append(normalised)

    return windows


# --------------------------------------------------------------------------- #
# The `getCodexUsage` message
# --------------------------------------------------------------------------- #


def _read_codex_usage(auth_file, log, now):
    # type: (Path | None, object, float | None) -> dict
    path = auth_file or AUTH_FILE
    credential = _read_auth_file(path)
    if credential is None:
        return {
            "ok": False,
            "error": {
                "code": "NOT_LOGGED_IN",
                "message": "Codex is not logged in on this machine — run `codex login`.",
            },
        }

    if token_needs_refresh(credential["access_token"], now=now):
        try:
            credential = _refresh_access_token(credential, path, log=log)
        except _RefreshRequiresLogin:
            return {
                "ok": False,
                "error": {
                    "code": "NOT_LOGGED_IN",
                    "message": "Codex's login has expired — run `codex login` again.",
                },
            }
        except _RefreshTransientFailure as error:
            # The token we already have may still work for a few more
            # minutes — try it rather than giving up on a refresh hiccup.
            log("Continuing with the existing token after a transient refresh failure: {}".format(error))

    try:
        payload = _call_usage_endpoint(credential["access_token"], credential.get("account_id"), log=log)
    except _CodexHttpError as error:
        if error.status_code not in (401, 403):
            return {"ok": False, "error": _error_for_http_failure(error)}

        # A fresh 401/403 gets exactly one refresh-and-retry — bounded, so a
        # persistently failing refresh cannot loop.
        try:
            credential = _refresh_access_token(credential, path, log=log)
        except _RefreshRequiresLogin:
            return {
                "ok": False,
                "error": {
                    "code": "NOT_LOGGED_IN",
                    "message": "Codex's login has expired — run `codex login` again.",
                },
            }
        except _RefreshTransientFailure:
            return {"ok": False, "error": _error_for_http_failure(error)}

        try:
            payload = _call_usage_endpoint(
                credential["access_token"], credential.get("account_id"), log=log
            )
        except _CodexHttpError as retried_error:
            return {"ok": False, "error": _error_for_http_failure(retried_error)}
        except _CodexNetworkError as retried_error:
            return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": str(retried_error)}}
    except _CodexNetworkError as error:
        return {"ok": False, "error": {"code": "NETWORK_ERROR", "message": str(error)}}

    windows = normalise_windows(payload, log=log)
    if not windows:
        return {
            "ok": False,
            "error": {
                "code": "MALFORMED_RESPONSE",
                "message": "Codex did not report any usable usage windows.",
            },
        }
    return {"ok": True, "windows": windows}


def read_codex_usage(auth_file=None, log=_ignore, now=None):
    # type: (Path | None, object, float | None) -> dict
    """The `getCodexUsage` message's implementation.

    Reads `auth.json` (or `$CODEX_HOME/auth.json`) fresh on every call — no
    in-memory token cache, since each `sendNativeMessage` is already its own
    process — refreshing the access token first if it is near expiry, then
    calls `CODEX_USAGE_URL` and returns `{"ok": True, "windows": [...]}` or
    `{"ok": False, "error": {...}}`.

    Never raises: a credential or network hiccup is not worth losing this
    reply over, the same restraint `probe_jira_credential` takes.
    """
    try:
        return _read_codex_usage(auth_file, log, now)
    except Exception as error:  # noqa: BLE001 - see the docstring
        log("Codex usage check failed unexpectedly: {!r}".format(error))
        return {
            "ok": False,
            "error": {
                "code": "NETWORK_ERROR",
                "message": "Codex usage check failed unexpectedly.",
            },
        }
