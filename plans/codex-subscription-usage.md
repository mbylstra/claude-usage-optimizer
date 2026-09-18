# Plan: Codex subscription usage (display only)

## Goal

Show ChatGPT/Codex usage — the same 5-hour and weekly pace cards the popup
already shows for Claude — below the Claude section, gated by a toggle in
Settings. Off by default.

**Explicitly out of scope:** anything that feeds the autonomous-work scheduler
or the runner. `run-autonomous-work.py`'s pace gate, the `claude-usage.json`
export, the suggested-model notification, and the usage-limit-warning
notifications all stay Claude-only. Codex numbers are read, normalised, cached,
and rendered — nothing else touches them. This is worth stating as a hard
constraint rather than an aspiration, because §5 below shows the Claude refresh
path several of those things are already wired into, and it would be easy to
add Codex "alongside" them by accident.

## Why this needs the native host, not a browser fetch

Claude's usage rides `credentials: 'include'` against `claude.ai` because the
extension already holds a `claude.ai` session cookie via `host_permissions`.
Codex has no equivalent browser session to ride: the Codex CLI authenticates
itself via `codex login` and stores the result in `~/.codex/auth.json`
(`0600`, containing `auth_mode`, `OPENAI_API_KEY`, `tokens`, `last_refresh`) —
confirmed by inspecting that file on this machine. A Chrome extension cannot
read an arbitrary file on disk, so there is no way to get from "user has run
`codex login`" to "extension can call the usage endpoint" without something
outside the browser sandbox in between.

That something already exists: `backend/usage-host.py`, the native-messaging
host installed by `just install-usage-host`. It already reads one local
credential file it doesn't own (the Jira token, via `queue_source_jira.py`)
and reports a status object back over native messaging without the secret
itself crossing that boundary — `probe_jira_credential()` /
`queue_source_jira.read_status()`. Codex follows the identical shape: a new
sibling module reads `~/.codex/auth.json`, calls the usage endpoint, and
returns normalised percentages and reset times. The token itself never leaves
the host process.

**Consequence worth naming:** `usageSnapshotExporter.ts` already says outright
that "most users will never install" this host. Codex usage will only work for
people who run `just install-usage-host` — same population as the Jira
integration today, not the general Chrome Web Store install base. The Settings
toggle's copy and error state need to say this plainly (§6), and `just setup`
already installs the host by default (`justfile:13`), so anyone who ran setup
already has it; only a person on an older install needs the extra step.

## The percentage must come from Codex's own servers

Non-negotiable, and worth stating before anything else: the number shown is
whatever `used_percent` Codex's backend reports, verbatim. **Never** estimated
from local token counts or session-log scanning. Two independent reasons:

1. There is no public, stable way to translate tokens into "how much of my
   Codex allowance is left" — the conversion from tokens to credits/quota is
   opaque, subscription-tier-dependent, and — per OpenAI's own changelog
   history — has already changed shape more than once. Any local estimate
   would be a guess dressed up as a number.
2. It's also just unnecessary: the server already computes this, correctly,
   per-account, and hands it back on every usage call. `usedPercent` is the
   whole feature — everything else in this plan exists to fetch it, cache it,
   and draw it with the component that already exists.

This is confirmed as the right approach by the one mature prior-art project
that does exactly this (§ below): it explicitly documents "OpenUsage preserves
Codex's reported `used_percent` verbatim" as a design decision, and its local
session-log reading is used *only* for a separate, clearly-labelled dollar-
spend estimate — never blended into the live percentage meter. Same split
applies here: `backend/codex_usage.py` calls the usage endpoint for the
percentage; nothing reads `~/.codex/sessions/` or counts a single token.

## Confirmed via public prior art (not a guess)

Unofficial and undocumented, exactly like `claude.ai`'s API — see
`chrome-extension/CLAUDE.md`'s "normalise defensively" section, which is the
house precedent for building against an API nobody published, and the MVP
plan's own §1, which verified against a reference implementation
(`sshnox/Claude-Usage-Tracker`) before writing any code.

A `strings` pass over the installed `codex` binary turned up candidate
endpoints and field names, but rather than guess further from that, a web
search turned up working, maintained open-source implementations of this
*exact* integration — one of them a stdlib-only Python CLI, the closest
possible match to what `codex_usage.py` needs to be. Read directly from their
source (not just their docs):

- **[robinebers/openusage](https://github.com/robinebers/openusage)** — a
  multi-provider usage-bar app; its Codex provider
  (`Sources/OpenUsage/Providers/Codex/CodexUsageClient.swift`,
  `CodexUsageMapper.swift`, `CodexAuthStore.swift`) is the fullest reference.
- **[ashenafee/codex-reset-checker](https://github.com/ashenafee/codex-reset-checker)**
  — a stdlib-only Python CLI (`urllib.request`, no dependencies) hitting a
  sibling endpoint with the identical auth pattern; its `fetch_reset_credits`
  is close to a template for `codex_usage.py`'s own HTTP call.
- Corroborated independently by two `openai/codex` GitHub issues
  ([#10869](https://github.com/openai/codex/issues/10869),
  [#37445](https://github.com/openai/codex/issues/37445)) reporting the CLI's
  own background polling of the same endpoint.

**Confirmed request:**

```
GET https://chatgpt.com/backend-api/wham/usage
Authorization: Bearer <tokens.access_token from ~/.codex/auth.json>
Accept: application/json
User-Agent: <anything identifiable>
ChatGPT-Account-Id: <tokens.account_id>   # optional, sent when known
```

`auth.json`'s shape (matches what was found by inspection earlier, now with
field names confirmed against `CodexAuthStore.swift`):

```json
{
  "tokens": {
    "access_token": "…",   // short-lived JWT, has an "exp" claim
    "refresh_token": "…",
    "id_token": "…",
    "account_id": "…"
  },
  "last_refresh": "2026-…",
  "OPENAI_API_KEY": null
}
```

**Confirmed response shape (the fields this plan consumes):**

```jsonc
{
  "rate_limit": {
    "primary_window":   { "used_percent": 42, "limit_window_seconds": 18000,  "reset_at": 1234567890 },
    "secondary_window": { "used_percent": 61, "limit_window_seconds": 604800, "reset_after_seconds": 345600 }
  },
  // Model-specific limits (e.g. GPT-5.3-Codex-Spark) — same primary/secondary
  // shape, under a different name. Out of scope; see "not reused" below.
  "additional_rate_limits": [ { "limit_name": "…", "rate_limit": { "...": "..." } } ],
  "plan_type": "pro" // cosmetic; not used by this plan
}
```

Two details matter more than they look:

- **`limit_window_seconds` and `reset_at`/`reset_after_seconds` are real,
  reported fields** — Codex tells us both the window's actual duration and its
  actual reset time, unlike Claude's API which only ever gives a reset time
  and forces the 5h/7d duration to be assumed. This removes most of the
  "unverified assumption" risk the Claude side still carries (see below).
- **Windows are classified by `limit_window_seconds`, not by
  `primary`/`secondary` position.** `openusage`'s own docs are explicit that
  Codex "can move a temporarily sole weekly limit into the primary slot" — so
  `primary` is *not* reliably "the 5-hour one". `normaliseCodexUsageResponse`
  must match `limit_window_seconds` against `18000` (5h) / `604800` (7d) to
  decide which window is which, falling back to the primary=5h/secondary=7d
  slot mapping only when the duration is missing or unrecognised — exactly
  the compatibility fallback `openusage` documents.
- **401/403 means the access token needs a refresh**, not necessarily a dead
  login — see the refresh flow in `backend/codex_usage.py` below.

## Data flow

```
codex CLI ──login──> ~/.codex/auth.json (0600, OAuth token)
                              │
                    backend/codex_usage.py reads it, calls
                    the chatgpt.com/backend-api endpoint,
                    returns normalised JSON — never the token
                              │
                    backend/usage-host.py dispatches
                    a new "getCodexUsage" message type
                              ▲
                    chrome.runtime.sendNativeMessage
                              │
        extension/codexUsageSource.ts (new; chrome.* stays confined
        to extension/, per the five-directory rule)
                              │
        normalises the reply the same defensive way
        claudeUsageClient.ts does — accepts several field
        spellings, drops windows it can't read
                              │
        extension/codexUsageStorage.ts writes chrome.storage.local
        under its own key, independent of the Claude cache
                              │
        popup/PopupRoot.tsx reads it, builds a view model,
        passes it to a new components/CodexUsageSection.tsx —
        which renders the *existing* UsageWindowCard
```

## What gets reused as-is

The pace engine turns out to already be provider-agnostic — nothing in it
mentions Claude by name except display labels, and the two window kinds Codex
needs (`fiveHour`, `sevenDay`) already exist with the right durations:

- `lib/usageTypes.ts` — `UsageWindowKind`, `USAGE_WINDOW_DURATIONS_MS`,
  `PACE_SEVERITY_THRESHOLDS_MS`, `COMFORTABLE_HEADROOM_THRESHOLD_MS`,
  `UsageSnapshot`, `UsageWindowSnapshot`, `DerivedWindowStatus`,
  `UsageCacheEntry` — all consumed unchanged. Codex snapshots simply never
  populate `sevenDayOpus`.
- `lib/usagePace.ts` (`deriveUsageStatuses`, `deriveWindowStatus`,
  `highestUtilizationPercent`) — unchanged, called a second time against the
  Codex snapshot.
- `lib/paceTone.ts`, `lib/windowTickMarks.ts`, `lib/formatClockTime.ts`,
  `lib/formatDuration.ts` — unchanged.
- `components/UsageWindowCard.tsx` — unchanged, rendered once per Codex
  window, same as it is for Claude.

**Not reused:** `lib/suggestedModel.ts` and `lib/usagePopupData.ts`'s
`suggestedModel` field. `deriveSuggestedModel` reads `fiveHour`/`sevenDay`
utilisation to recommend Opus/Sonnet/Haiku — Codex has both of those window
kinds too, so calling `buildUsagePopupData` unmodified against a Codex
snapshot would silently produce an Anthropic model recommendation from OpenAI
usage numbers. `lib/codexUsagePopupData.ts` is a new, smaller function with the
same `loading` / `error` / `ready` shape minus that field.

**The window-duration assumption mostly does *not* carry over — Codex's
response is better data than Claude's.** Claude's API only reports a reset
time, forcing `deriveWindowStatus` to derive the window start as
`resetsAt − 5h/7d` (see `usagePace.ts`'s existing note and
`plans/mvp-chrome-extension.md` §2). Codex's `wham/usage` response reports
`limit_window_seconds` and an actual `reset_at`/`reset_after_seconds` per
window — real data, not an assumption. `deriveWindowStatus` itself already
prefers a reported start/span over the nominal duration when one is given, so
this mostly falls out for free: `codex_usage.py` should pass through the
server's own reset time as `resetsAt`, and `USAGE_WINDOW_DURATIONS_MS` is only
ever a fallback for a payload that (unexpectedly) omits `limit_window_seconds`
— not the primary source of truth it is forced to be for Claude. Still worth a
guard: if a response's `limit_window_seconds` for the "5h" slot is ever
something other than `18000`, log it and use the reported value's derived
duration rather than silently coercing to the constant.

## New: `lib/codexUsagePopupData.ts`

```ts
export interface CodexUsagePopupLoading { state: 'loading' }
export interface CodexUsagePopupError { state: 'error'; error: UsageErrorInfo }
export interface CodexUsagePopupReady {
  state: 'ready';
  windows: DerivedWindowStatus[];
  fetchedAt: Date;
  isStale: boolean;
  refreshError: UsageErrorInfo | null;
}
export type CodexUsagePopupData =
  | CodexUsagePopupLoading | CodexUsagePopupError | CodexUsagePopupReady;

export function buildCodexUsagePopupData(
  entry: UsageCacheEntry | null,
  now: Date,
): CodexUsagePopupData
```

Structurally identical to `buildUsagePopupData` minus `suggestedModel` — kept
as its own function rather than an optional field on the existing one, so nothing
about the Claude path has to change shape to accommodate a feature it doesn't
have.

## New: `extension/codexUsageStorage.ts`

Sibling of `usageStorage.ts`, scoped to just the Codex cache — it does not
touch `organizationId`, `usageHistory`, `suggestedModel`, or any of the
Claude-specific keys in that file:

```ts
const CODEX_USAGE_CACHE_STORAGE_KEY = 'codexUsageCache';
export const CODEX_USAGE_CACHE_CHANGE_KEY = CODEX_USAGE_CACHE_STORAGE_KEY;

export async function readCodexUsageCache(): Promise<UsageCacheEntry | null>
export async function writeCodexUsageCache(entry: UsageCacheEntry): Promise<void>
```

Reuses the existing `UsageCacheEntry` type (`{ snapshot, fetchedAt, error }`)
— it was already written generically ("what the service worker persists and
the popup renders from"), so it needs no Codex-specific variant.

## New: `extension/codexUsageSource.ts`

The `chrome.*`-touching half — `chrome.runtime.sendNativeMessage` — plus
defensive normalisation of whatever the host hands back, mirroring
`claudeUsageClient.ts`'s posture toward a schema that can change under it:

```ts
const NATIVE_HOST_NAME = 'com.claudeusageoptimizer.usagehost'; // same host
const GET_CODEX_USAGE_MESSAGE_TYPE = 'getCodexUsage';

export async function fetchCodexUsageSnapshot(): Promise<UsageSnapshot> {
  // sends { type: 'getCodexUsage' }, expects { ok: true, windows: [...] }
  // or { ok: false, error: { code, message } }
  // throws a ClaudeUsageError-shaped error (reusing UsageErrorCode) so the
  // existing errorHeadline/errorGuidance mapping in UsagePopup.tsx-adjacent
  // code can be reused rather than duplicated
}
```

Reuses the *existing* native host — no new host to register, no new
`nativeMessaging` manifest entry, no new `just install-*` recipe. It is a new
message type on a host that already exists for exactly this kind of
optional, best-effort integration.

**Error codes.** `UsageErrorCode` (`lib/usageTypes.ts`) gains one new member:
`HOST_UNAVAILABLE` — distinct from `NETWORK_ERROR`, because "the native host
isn't installed" and "the host is installed but chatgpt.com didn't respond"
call for different guidance copy (§6). Every `switch` over `UsageErrorCode`
has to gain a case for it — `UsagePopup.tsx`'s `errorHeadline`/`errorGuidance`
both `default` today, so a missed case fails quietly as generic copy rather
than a type error. Grep for `UsageErrorCode` before considering this done.

## New: `backend/codex_usage.py`

Stdlib-only, 3.9-compatible, same constraints as every other module
`usage-host.py` imports — see that file's own docstring for why (Chrome spawns
it with an environment the repo doesn't control). `urllib.request` is enough;
`codex-reset-checker`'s `fetch_reset_credits` (cited above) is a working
template for exactly this shape of call against a sibling endpoint.

```python
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token"
# The Codex CLI's own OAuth client ID — public, embedded in the CLI binary
# itself (confirmed in openusage's CodexUsageClient.swift), not a secret.
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

SESSION_WINDOW_SECONDS = 5 * 60 * 60
WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

def read_codex_usage():
    # type: () -> dict
    """Reads ~/.codex/auth.json (or $CODEX_HOME/auth.json), refreshing the
    access token first if it's near expiry, calls CODEX_USAGE_URL, and
    returns {"ok": True, "windows": [...]} or {"ok": False, "error": {...}}.

    The token never appears in usage-host.log — only success/failure and the
    window kinds returned, the same restraint queue_source_jira already takes
    with the Jira token.
    """
```

**Token refresh: the plan's earlier draft said "never write to `auth.json`" —
now-confirmed prior art changes that call.** Codex access tokens are
short-lived JWTs (`exp` typically under an hour); the CLI itself refreshes and
rewrites `auth.json` automatically whenever it runs.
`CodexAuthStore.needsRefresh` in `openusage` checks the token's own `exp`
claim with a 5-minute slack — "the same 5-minute slack the `codex` CLI itself
uses" — rather than guessing a wall-clock age. A polling extension that never
refreshes would show "expired, run `codex`" for however long the user goes
between actually using the CLI, which is a bad failure mode for a background
usage indicator. So `codex_usage.py` should refresh, matching the confirmed
flow:

1. Decode the JWT `access_token`'s `exp` claim (no signature verification
   needed — this is a local trust decision about our own stored token, not an
   auth check) and refresh only when within 5 minutes of expiry, or on an
   actual `401`/`403` from the usage call.
2. Refresh via `POST https://auth.openai.com/oauth/token` with
   `grant_type=refresh_token`, `client_id=app_EMoamEEZ73f0CkXaXp7hrann`,
   `refresh_token=<tokens.refresh_token>`.
3. On success, write the rotated `access_token`/`refresh_token`/`id_token`
   back to `auth.json` — **atomically**, the same
   `tempfile.NamedTemporaryFile` + `os.replace` pattern `usage-host.py`
   already uses for `write_snapshot` (`usage-host.py:181-197`), so a `codex`
   process refreshing concurrently can never observe a half-written file.
4. On a refresh failure, map the OAuth error code the way `openusage` does:
   `refresh_token_expired` / `refresh_token_reused` / `refresh_token_invalidated`
   all mean "run `codex` to log in again" (`NOT_LOGGED_IN`-shaped); anything
   else (a 5xx, a network failure) is a transient `NETWORK_ERROR` worth
   retrying next poll, not a login problem.

**Everything else about credential handling still holds:**

- Read the file fresh on every `getCodexUsage` message — no in-memory token
  cache across messages (each message is already its own process; see
  `usage-host.py`'s docstring on `sendNativeMessage` spawning one process per
  call, so a fresh read costs nothing extra).
- Log the message type and outcome (`ok` / `error.code`) to `usage-host.log`,
  the same way the settings sync logs its key list — but never the token, the
  API key, or the raw response body.
- If `~/.codex/auth.json` doesn't exist at all (Codex CLI never installed or
  never logged in), that's `NOT_LOGGED_IN`, not a crash — same posture as
  `queue_source_jira.read_status()` toward a missing credential file.
- Drop `additional_rate_limits` entirely (the Spark/model-specific limits) —
  out of scope per the Goal; only `rate_limit.primary_window` /
  `secondary_window`, classified by `limit_window_seconds` (§ above), become
  `fiveHour` / `sevenDay` windows.

`backend/usage-host.py` changes:

```python
MESSAGE_TYPE_CODEX_USAGE = "getCodexUsage"
...
if message_type == MESSAGE_TYPE_CODEX_USAGE:
    return codex_usage.read_codex_usage()
```

mirroring the `MESSAGE_TYPE_JIRA_STATUS` dispatch exactly.

## Settings: the toggle

`lib/settingsTypes.ts` — new **top-level** field on `ExtensionSettings`
(sibling of `notificationsEnabled`, not nested under `autonomousWork`): it's a
display preference, not a scheduler input, and nothing about it needs to
reach `backend/autonomous-work-settings.json` or be mirrored to the host at
all — the extension simply stops asking for Codex usage when it's off.

```ts
export interface ExtensionSettings {
  notificationsEnabled: boolean;
  codexUsageEnabled: boolean; // new
  autonomousWork: AutonomousWorkSettings;
}
export const DEFAULT_CODEX_USAGE_ENABLED = false;
```

`normaliseExtensionSettings` gets the same "anything but a real boolean falls
back to the default" branch the other booleans in that function already use.

`components/SettingsPage.tsx` — a new `Card`, styled like the existing
Notifications card at the top of the screen (`Switch` + one line of
description), reading:

> **Codex usage** — Show ChatGPT/Codex 5-hour and weekly usage below your
> Claude usage. Needs the native host from `just install-usage-host` (already
> installed if you ran `just setup`) and a machine where you've run
> `codex login`.

No "send test" button, no per-window configuration — the requirement is a
single on/off switch, and `UsageWindowCard` already carries all the display
logic.

## Popup wiring

`components/UsagePopup.tsx` (or `PopupRoot.tsx`, whichever ends up holding the
conditional — see below) grows one more optional block, rendered only when
`settings.codexUsageEnabled`:

```tsx
{settings.codexUsageEnabled && (
  <CodexUsageSection data={codexData} now={now} />
)}
```

`components/CodexUsageSection.tsx` (new) — pure, props in only, same
constraint every other file in `components/` follows:

```tsx
export interface CodexUsageSectionProps {
  data: CodexUsagePopupData;
  now: Date;
}
```

Renders a small heading ("Codex") plus a loading skeleton / error state /
`UsageWindowCard` list, reusing the same three-state branch `UsagePopup.tsx`
already has for Claude — copy the shape, don't invent a fourth state.

`PopupRoot.tsx` changes:

- New state: `const [codexCacheEntry, setCodexCacheEntry] = useState<UsageCacheEntry | null>(null)`.
- The existing `requestRefresh` callback (which sends `REFRESH_USAGE` and
  waits for the reply) is the natural place to *also* trigger a Codex refresh
  — but see the constraint below on keeping this a sibling call, not a merge.
- The `chrome.storage.onChanged` listener (`PopupRoot.tsx:266-282`) needs a
  third branch for `CODEX_USAGE_CACHE_CHANGE_KEY`, or the section will only
  ever show whatever was cached when the popup opened and never live-update.
- `minContentHeightPx`: toggling Codex on partway through a popup's life grows
  the tracked floor as intended (`ResizeObserver` already handles growth);
  toggling it back off will **not** shrink the popup back down for the rest of
  that popup's open lifetime, since the floor only ever grows. This already
  matches how the settings/usage view switch behaves today (see the comment at
  `PopupRoot.tsx:100-104`) — worth a one-line note in the PR description, not
  a bug to fix, since "fixing" it would mean the settings page shrinking too.

## Refresh path — a separate function, not a branch in `refreshUsage`

`extension/serviceWorker.ts`'s `refreshUsage()` does far more than fetch and
cache: `exportUsageSnapshot` (writes `backend/claude-usage.json`, the
scheduler's pace input), `appendUsageHistorySample` (a Claude-shaped
history-sample schema), `applyToolbarTitle`, `deriveSuggestedModel` +
`notifyModelChange`, `deriveNewUsageLimitWarnings` +
`notifyUsageLimitWarnings`, and `applyJiraCredentialBadge`. None of these are
things Codex usage should touch — that's the "ignored by the runner and
scheduler" requirement made concrete. So:

```ts
async function refreshCodexUsage(): Promise<void> {
  const settings = await readExtensionSettings();
  if (!settings.codexUsageEnabled) return; // don't spawn the host for nothing

  try {
    const snapshot = await fetchCodexUsageSnapshot();
    await writeCodexUsageCache({ snapshot, fetchedAt: new Date().toISOString(), error: null });
  } catch (error) {
    const previous = await readCodexUsageCache();
    await writeCodexUsageCache({
      snapshot: previous?.snapshot ?? null,
      fetchedAt: previous?.fetchedAt ?? null,
      error: toUsageErrorInfo(error),
    });
  }
}
```

Called alongside `refreshUsage()`, on the *same* `chrome.alarms` alarm
(`REFRESH_ALARM_NAME`, every 5 minutes) — not a second alarm, since there's no
reason for Codex to poll on a different cadence, and MV3's alarm minimum is
already the constraint that set the existing period. Also called from the
`REFRESH_USAGE` message handler, alongside `refreshUsage()`, so the popup's
manual refresh button updates both sections in one press without
`RefreshUsageResponse`'s shape having to widen — the popup picks the Codex
update up through the storage listener, same as the alarm-triggered refresh
does.

## `BUILD_STAMP` / stale-worker trap

`chrome-extension/CLAUDE.md` is explicit that this exact failure mode — "the
toggle is visible, the source is right, but the service worker relaying it is
weeks old" — has already cost a morning once, over a settings field. A new
native-host message type is precisely that shape of change. Concretely:

- After wiring `getCodexUsage` end to end, **quit and reopen Chrome** before
  testing — reloading the extension has been observed not to be enough.
- Have `codex_usage.py`'s dispatch log the arriving message type the way
  `usage-host.py` already logs the settings key list on `setAutonomousWorkSettings`,
  so `usage-host.log` can answer "did a getCodexUsage message even arrive?"
  independent of whether Chrome's build is current.

## Testing

- `lib/codexUsagePopupData.ts` — unit tests mirroring `usagePopupData`'s
  existing ones (loading / error-with-no-snapshot / ready / stale / refresh-
  error-with-stale-snapshot), minus anything about `suggestedModel`.
- `extension/codexUsageSource.ts` — unit tests for the normalisation, same
  style as `claudeUsageClient.ts`'s tests: several field-name spellings
  accepted, a window with no readable utilisation dropped, a fully
  unrecognisable payload raising `MALFORMED_RESPONSE`, `HOST_UNAVAILABLE`
  surfaced distinctly from a host-reported failure.
- `components/CodexUsageSection.tsx` — a Storybook story per state (loading,
  error, ready with both windows, ready with only one window active), the
  same coverage pattern `UsageWindowCard` and `UsagePopup` already have.
- `backend/test-usage-host.py` — a new case for `MESSAGE_TYPE_CODEX_USAGE`
  dispatching to `codex_usage.read_codex_usage`, plus a case for a missing
  `auth.json` producing a clean `NOT_LOGGED_IN`-shaped error rather than an
  exception reaching `handle_message`'s catch-all.
- `just check` (typecheck + lint + format-check) is the gate per the root
  `CLAUDE.md`, but it **skips Python tests** — run `just test-autonomous-work`
  too once `backend/codex_usage.py` exists, since that's the only thing that
  actually exercises it.
- Manual verification: toggle Codex on with no `codex login` ever run on the
  machine (expect a clean "not logged in" state, not a spinner forever);
  toggle it on with a real login (expect two cards below the Claude ones,
  updating on the same 5-minute cadence); toggle it off (expect the section to
  disappear immediately, no lingering host calls on the next alarm tick).

## Open questions to resolve during implementation, not before

The endpoint, auth flow, refresh mechanism, and response shape are confirmed
against working source (§ above), not guessed — the remaining open items are
narrower:

- **`$CODEX_HOME` support.** `openusage` and `codex-reset-checker` both check
  a `CODEX_HOME` environment variable before falling back to `~/.codex`
  (`codex-reset-checker` also checks `~/.config/codex`). `usage-host.py` is
  spawned by Chrome with an environment it doesn't fully control, so whether
  `CODEX_HOME` is even visible there needs a quick check; if not, hardcoding
  `~/.codex/auth.json` is a reasonable v1 scope-cut (it's what this plan found
  the credential at on this machine) with a one-line note that a custom
  `CODEX_HOME` isn't supported yet.
- **Whether a fresh 401 (not just a near-expiry token) should attempt exactly
  one refresh-and-retry**, the same shape `claudeUsageClient.ts`'s stale-org
  retry already uses for a different failure. Almost certainly yes — it's what
  `openusage` does — but worth confirming the retry is bounded to one attempt
  so a persistently-failing refresh can't loop.
- **Whether the manifest needs a new host permission.** It shouldn't — the
  network call happens inside `backend/codex_usage.py` (a plain Python
  process, not the extension), so `chrome-extension/public/manifest.json`'s
  `host_permissions` stays `https://claude.ai/*` only. Worth confirming this
  assumption holds once `codex_usage.py` is real, since a mistaken shortcut
  (e.g. trying to fetch from the service worker directly) would need
  `https://chatgpt.com/*` added and a much harder cookie-based auth story that
  this plan deliberately avoids.

## Sources consulted

- [robinebers/openusage](https://github.com/robinebers/openusage) —
  `CodexUsageClient.swift`, `CodexUsageMapper.swift`, `CodexAuthStore.swift`,
  `docs/providers/codex.md`
- [ashenafee/codex-reset-checker](https://github.com/ashenafee/codex-reset-checker)
  — `src/codex_reset_checker/cli.py`
- [openai/codex#10869](https://github.com/openai/codex/issues/10869),
  [openai/codex#37445](https://github.com/openai/codex/issues/37445) —
  corroborating the CLI's own use of `wham/usage`
- Local inspection of `~/.codex/auth.json` (shape only, no secret values) and
  `strings` on the installed `codex-cli 0.154.0` binary
