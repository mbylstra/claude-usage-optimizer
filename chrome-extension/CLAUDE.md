# Claude Usage Optimizer — `chrome-extension/`

The Chrome MV3 extension. The repo-wide map and the `just` command list are
in the root `CLAUDE.md`; the native host and autonomous-work scheduler are in
`backend/CLAUDE.md`.

## Architecture — the rule that matters

**`chrome.*` is never called from a React component.**

```
chrome-extension/
  lib/          pure TypeScript, zero browser-extension dependencies
                pace maths, formatters, view-model construction, toolbar title,
                types
  extension/    the only place chrome.* is touched
                claudeUsageClient.ts, usageStorage.ts, serviceWorker.ts, messages.ts
  components/   pure React, props in only — plus ui/ for shadcn primitives
  popup/        PopupRoot.tsx — the one component that talks to extension/
  runLog/       RunLogRoot.tsx — the same, for the detached run-log window
```

This is the constraint most likely to be violated by accident. Because the
library code has no browser dependencies, `claudeUsageClient.ts` takes `fetch`
and its organization-ID cache as injected dependencies, making the real call
shapes inspectable without mocking.

When adding a feature, ask which of the five directories it belongs in before
writing it. Maths and formatting go in `lib/` even if only one component uses
them.

There are **two extension pages**, `popup.html` and `run-log.html`, each with a
root component that is the only one in its tree allowed to touch `extension/`.
They may share build chunks; only the service worker may not.

## The claude.ai API

Unofficial and undocumented. Two calls, riding the user's session cookie via
`credentials: 'include'` and the `https://claude.ai/*` host permission:

```
GET https://claude.ai/api/organizations
GET https://claude.ai/api/organizations/{orgId}/usage
```

The response shape is documented in `plans/mvp-chrome-extension.md` §1.

**Normalise defensively.** The schema has changed before and will again. The
client accepts several spellings of each field (`utilization` / `utilization_pct`,
`resets_at` / `reset_at`), drops windows it cannot read, and treats a missing
reset time as "window inactive" rather than as a reset at the epoch. A failing
usage call busts the cached org ID and retries once — that covers the user
leaving a team.

**Unverified assumption:** the API reports when a window _resets_ but not when it
started, so the start is derived as `resets_at − 5h/7d`. If the weekly window is
actually rolling, weekly pace is wrong. `normaliseUsageResponse` already prefers
a real start field (`starts_at` / `started_at` / `window_start`) if one ever
appears, and `deriveWindowStatus` trusts the reported span over the nominal
duration when both ends are known.

## MV3 constraints

- Periodic work goes through **`chrome.alarms`, never `setInterval`** — the
  service worker is killed when idle, and an interval simply stops firing.
- Keep the permission set minimal. Currently `storage`, `alarms`, and host
  access to `https://claude.ai/*`. No content script, no `cookies`, no `tabs`
  permission (`chrome.tabs.create` does not require one).
- The popup asks the service worker to refresh via `chrome.runtime.sendMessage`
  rather than fetching itself, so network, storage and badge updates all happen
  in one place.
- The build is two Vite passes: the popup, then the service worker as a single
  self-contained ES module with no shared chunks for Chrome to resolve.

**An unpacked extension is only half as fresh as it looks, and every settings
message carries a build stamp because of it.** `popup.html` and its bundle are
re-read from disk every time the popup opens; the **service worker is replaced
only when Chrome reloads the extension**, and the reload button has been observed
not to take. The failure is invisible from every angle you would normally check:
the source is right, `dist/` is right, the UI shows the new fields — and the
worker relaying them to the native host is weeks old. It cost most of a morning
once, spent fixing a sender that was never running.

So both Vite passes `define` a `BUILD_STAMP` (declared in
`extension/buildStamp.d.ts`), `syncAutonomousWorkSettings` sends it, and
`usage-host.py` logs it beside the arriving key list. One line of
`backend/usage-host.log` now answers "is Chrome running what I just built?" —
`unstamped` means it is not. **Quit and reopen Chrome; reloading may not be
enough.**

The same log line prints the message's keys _before_ they are parsed, because
`parse_settings` substitutes a default for anything absent — after it runs, "the
extension never sent this field" and "the extension sent the default" are
indistinguishable, which is the shape every version-skew bug here takes.

Relatedly, `syncAutonomousWorkSettings` **spreads the settings object** rather
than naming each field. Fields were dropped twice by a hand-written payload that
someone forgot to extend; only `scheduleTime` is spelled out, since it is the one
field whose shape differs from the mirrored file's.
