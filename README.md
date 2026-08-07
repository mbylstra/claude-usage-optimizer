# Claude Usage Optimizer

A Chrome extension that shows your Claude.ai usage limits in the toolbar, with a
**pace** indicator telling you whether you are ahead of or behind an even burn.

Knowing you are at 61% is only half the picture. Knowing you are at 61% with 47%
of the week gone is the half you act on.

No configuration of any kind — the extension discovers your organization itself
and rides on the claude.ai session you are already signed in to.

## What it shows

For the 5-hour session window, the weekly window, and the weekly Opus window:

- percent used, and when the window started and resets
- how long is left
- **pace**: `percent used − percent of the window elapsed`, rendered as
  "12 points ahead of pace" (amber), "8 points behind pace" (blue), or
  "On pace" (neutral)

Each bar carries a vertical line marking the even-burn point, so the number and
the picture say the same thing.

The toolbar badge shows the highest utilisation across all windows, coloured by
how the _weekly_ window is pacing — that being the one where running ahead is a
genuine budget breach rather than just a busy afternoon.

## Install it locally

```sh
just install
just build
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` directory
4. Pin the extension, and make sure you are signed in to <https://claude.ai>

Data refreshes every 5 minutes in the background, and again whenever you open
the popup.

> Chrome removed the `--load-extension` command-line switch, so loading it
> through the UI is the only route.

## Commands

`just` is the entry point for everything:

```sh
just check           # typecheck + lint + format-check + test — the gate
just build           # production build into dist/
just test            # unit tests
just storybook       # every popup state, in both themes, without a browser extension
just package         # zip dist/ for a Web Store upload
just --list          # everything else
```

## How it is put together

The rule that makes the tooling worth having: **`chrome.*` is never called from
a React component.**

```
src/
  lib/          pure TypeScript, no browser-extension dependencies
                pace maths, formatters, view-model construction, types
  extension/    the only place chrome.* is touched
                API client, storage, service worker
  components/   pure React, props in only
  popup/        PopupRoot — the one component that talks to extension/
```

Two consequences worth keeping:

- Pure functions in `src/lib` take `now` as an explicit argument and never read
  the clock. That is what makes the pace maths testable.
- `UsagePopup` renders a fully-derived view model, so every visual state —
  loading, logged out, ahead, behind, window inactive, stale, refresh-failed —
  is a Storybook story with a hand-written fixture and no extension host.

### The claude.ai API

Unofficial and undocumented. Two calls, both riding the session cookie:

```
GET https://claude.ai/api/organizations
GET https://claude.ai/api/organizations/{orgId}/usage
```

Responses are normalised defensively — the client accepts several spellings of
each field, drops windows it cannot read, and treats a missing reset time as
"window inactive" rather than as a reset at the epoch. A failing usage call
busts the cached organization ID and retries once, which covers leaving a team.

**One assumption is still unverified against live data:** the API reports when a
window _resets_ but not when it started, so the start is derived as
`resets_at − 5h/7d`. That holds for fixed windows. If the weekly window turns
out to be rolling, weekly pace is wrong and needs reworking. The normaliser
already prefers a real start field (`starts_at` / `started_at` / `window_start`)
if the API ever supplies one.

### MV3 constraints

Periodic work goes through `chrome.alarms`, never `setInterval` — the service
worker is killed when idle, and an interval would simply stop firing. The
permission set is deliberately tiny: `storage`, `alarms`, and host access to
`https://claude.ai/*`. No content script, no `cookies`, no `tabs`.

### Usage history

Every successful refresh appends a `{ fetchedAt, fiveHourPercent,
sevenDayPercent, sevenDayOpusPercent }` sample to a capped ring buffer in
`chrome.storage.local`. Nothing reads it yet. It exists so that an
activity-weighted pace model — one that knows 3am Sunday is not 10am Tuesday —
has a real dataset to be built against later, instead of starting from zero.

## Privacy

Everything stays on your machine. The extension talks to claude.ai and nothing
else; there is no analytics, no server, and no telemetry.
