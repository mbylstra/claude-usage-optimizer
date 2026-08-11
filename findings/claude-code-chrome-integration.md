# Claude Code ↔ Chrome integration — can this session use it?

Source: <https://code.claude.com/docs/en/chrome>
Checked: 2026-08-11

## Verdict

**Yes.** The integration is live in this session. Every prerequisite is met, the
browser tools are present, and a read-only call round-tripped to the extension
and came back with a real answer.

The one thing not verified is a _state-changing_ action (creating a tab,
navigating, clicking). That was left alone deliberately — it would open a window
in the running Chrome — so the last inch of the chain is inferred rather than
measured. Everything up to it is measured.

## What the feature is

Claude Code drives the **Claude in Chrome** browser extension from the CLI:
navigate, click, type, read the DOM, read console messages and network requests,
screenshot, upload files, record GIFs. It opens new tabs in the user's existing
Chrome and inherits the browser's login state, so it can act on any already
signed-in site without an API connector. Login pages and CAPTCHAs pause and hand
back to the human.

## Prerequisites, against this machine

| Requirement                              | Documented                         | Here                                                                                                                | ✓   |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --- |
| Chromium-based browser                   | Chrome / Edge / Brave / Arc / …    | Google Chrome, macOS (Darwin 25.5.0)                                                                                | ✓   |
| Claude in Chrome extension               | ≥ 1.0.36                           | **1.0.85** (`fcoeoabgfenejglbffodgkkbkcdhcgfn`)                                                                     | ✓   |
| Claude Code                              | ≥ 2.1.206 for the install prompt   | **2.1.227**                                                                                                         | ✓   |
| Direct Anthropic plan (Pro/Max/Team/Ent) | required                           | no `ANTHROPIC_API_KEY` in the environment; session is `/login`-style                                                | ✓   |
| Native messaging host config             | must exist                         | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json` | ✓   |
| Not WSL, not a third-party provider      | Bedrock / Vertex / Foundry are out | native macOS, direct                                                                                                | ✓   |

`~/.claude.json` also carries `claudeInChromeDefaultEnabled: true` and
`hasCompletedClaudeInChromeOnboarding: true` — Chrome is on by default, so no
`--chrome` flag is needed per session.

## Evidence from this session

1. **Tools are exposed.** The full `mcp__claude-in-chrome__*` surface is
   available (deferred, loaded via `ToolSearch` in one batched call):
   `navigate`, `computer`, `read_page`, `get_page_text`, `find`, `form_input`,
   `javascript_tool`, `read_console_messages`, `read_network_requests`,
   `browser_batch`, `gif_creator`, `file_upload`, tab management, and the
   browser-selection tools.

2. **A browser is actually connected.** `list_connected_browsers` returned one
   live client:

   ```json
   { "deviceId": "a6d1eabe-…", "name": "Browser 1", "osPlatform": "macOS", "isLocal": true }
   ```

   One browser only, so no disambiguation prompt is pending.

3. **A read-only call reached the extension and answered.**
   `tabs_context_mcp` (no `createIfEmpty`, so genuinely read-only) returned
   _"No tab group exists for this session. Use createIfEmpty: true to create
   one."_ That is a real reply about real browser state, not a transport error —
   which is the useful signal. A broken chain gives _"Browser extension is not
   connected"_ or _"Receiving end does not exist"_ instead.

## What using it would cost, in permissions

- The **first** browser action asks approval for the `claude-in-chrome` skill.
- Creating the tab group needs `createIfEmpty: true`, which the docs class as
  state-changing (v2.1.199+) and which prompts even though the enclosing tool is
  otherwise read-only. Same rule for `clear` on the console/network readers and
  `save_to_disk` on a screenshot.
- **Site-level** permissions are the extension's, not Claude Code's. They are
  managed in the extension's own settings, so a site Claude has not been granted
  will refuse regardless of what the CLI approves.
- In plan mode, reads run unprompted and writes prompt.

## Things worth knowing before relying on it

- **Context cost.** `claudeInChromeDefaultEnabled` loads the browser tools into
  every session. The docs flag this as a real context-consumption increase and
  suggest turning it off and using `--chrome` on demand. In this session the
  tools arrive _deferred_ — names only, schemas fetched on request — which is
  what keeps that cost down; batch the `ToolSearch` into one call.
- **Modal dialogs are fatal.** A JS `alert`/`confirm`/`prompt` blocks all
  browser events and the extension stops receiving commands until a human
  dismisses it. Don't trigger them.
- **Idle service worker.** The extension's MV3 service worker can go idle in a
  long session and silently break the connection; `/chrome` → "Reconnect
  extension" is the fix. (The same MV3 lifetime problem this repo works around
  with `chrome.alarms` and a per-connection native host.)
- **Recordings capture logged-in state.** GIFs include whatever is on screen,
  account details included.

## Relevance to this repo

Two of this project's own hard-won lessons are visible in the same machinery,
which makes the docs page a useful cross-check rather than just background:

- The integration uses **native messaging** with a host config keyed to an
  extension ID, exactly as `.claude-scripts/usage-host.py` does — and it lives
  in the same `NativeMessagingHosts/` directory as this project's
  `com.claudeusageoptimizer.usagehost.json`. Chrome reads that directory at
  startup, which is why a fresh install often needs a Chrome restart.
- The idle-service-worker failure mode the docs describe is the same constraint
  that pushed the run-log stream out of the service worker and into the page.

Practically: browser tools here mean the popup and `run-log.html` could be
driven and screenshotted directly, instead of via `just run-log-preview` on
fixtures.

## To confirm the last inch

Ask for a concrete browser action — e.g. _"open a tab on localhost and screenshot
the popup"_ — and approve the skill prompt. That exercises the state-changing
path this write-up stopped short of.
