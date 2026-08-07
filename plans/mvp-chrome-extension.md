# Plan: Claude Usage Optimizer — MV3 Chrome Extension (MVP)

## Goal

A Chrome extension that shows Claude.ai 5-hour and weekly usage limits in a toolbar
popup, with a **pace** indicator telling you whether you are ahead of or behind the
even-burn rate for each window. No manual configuration of any kind.

## Requirements (from the brief)

| # | Requirement | How it is met |
|---|---|---|
| 1 | No pasting an org ID | Service worker discovers it from `GET /api/organizations` |
| 2 | Click toolbar icon → panel below the icon bar; click-outside closes | MV3 `action.default_popup` — this is exactly the native popup behaviour, no custom windowing |
| 3 | 5-hour window: start, finish, time left, % used, pace % | `UsageWindowCard` component |
| 4 | Weekly window: same fields | Same component, different props |
| 5 | Refresh every 5 minutes | `chrome.alarms` in the service worker (not a popup timer — see note) |

---

## 1. How the data is obtained

Two unauthenticated-by-us calls that ride on the user's existing `claude.ai` session
cookie. Verified against the shipped source of `sshnox/Claude-Usage-Tracker` v2.1.0,
which does exactly this in production.

### Step 1 — discover the organization ID

```
GET https://claude.ai/api/organizations
credentials: 'include'
```

Returns an array of orgs. Pick the one whose `capabilities` array includes `"chat"`,
falling back to the first entry (accounts with a team membership have several).
Cache `uuid` in `chrome.storage.local` for 24h.

### Step 2 — fetch usage

```
GET https://claude.ai/api/organizations/{orgId}/usage
credentials: 'include'
```

Response shape (the fields we consume):

```jsonc
{
  "five_hour":       { "utilization": 42, "resets_at": "2026-08-07T18:00:00Z" },
  "seven_day":       { "utilization": 61, "resets_at": "2026-08-11T09:00:00Z" },
  "seven_day_opus":  { "utilization": 12, "resets_at": "2026-08-11T09:00:00Z" }
}
```

**Defensive normalisation** (borrowed from sshnox, who handles a schema that has
already changed once): accept `utilization ?? utilization_pct`, accept
`resets_at ?? reset_at`, and treat a missing `resets_at` as "window inactive"
rather than as zero.

**Stale-org retry:** if the usage call returns any HTTP error, bust the cached org
ID, re-discover once, and retry. Covers the user leaving a team.

**Auth failure:** `401`/`403` → surface "Not logged in to Claude.ai" with a link that
opens `https://claude.ai`. Never show a raw HTTP error.

---

## 2. Pace: the core feature

`oov/claude-usage-monitor` is the only prior art with a pace indicator, and its model
is time-proportional (`monitor.js:36`):

```
expectedPercent = elapsed / totalPeriod * 100
```

We keep that as the v1 model but improve the presentation and fix one conceptual
problem.

### Derivation

The API gives `resets_at` but no window start, so:

```
windowStartedAt = resetsAt - windowDurationMs   // 5h or 7d, per window kind
elapsedMs       = now - windowStartedAt
pacePercent     = clamp(elapsedMs / windowDurationMs * 100, 0, 100)
paceDelta       = percentUsed - pacePercent     // positive = burning too fast
```

> **Assumption to verify against live data:** that the window is exactly 5h / 7d long
> and therefore that `resets_at - duration` is the true start. This holds for fixed
> windows. If the weekly window turns out to be rolling, the derived start is wrong
> and pace for that card must be reworked. Check this in Phase 1 with a real account
> before building UI on top of it.

### Presentation (improvement over oov)

oov renders expected-usage as a second ring/bar and leaves the comparison to your
eyes. We show a **scalar** as well, because that is the number you actually act on:

- `paceDelta > +5` → "**12 points ahead of pace**" (amber/red — you will run out early)
- `paceDelta < -5` → "**8 points behind pace**" (blue — you have headroom)
- otherwise → "**On pace**" (neutral)

### Colour treatment — identical on both windows

Both cards get the full colour treatment: ahead of pace is amber/red, behind is blue,
on-pace is neutral. `PaceIndicator` therefore takes no per-window behaviour flag and
renders purely from `paceStatus`, which keeps the component and its stories simple.

Worth knowing about the 5-hour window while reading it: it resets unconditionally, so
capacity you don't use is forfeited rather than carried forward. "Ahead of pace" early
in a session is often fine — it means you're working, and the window will wipe clean
regardless. The warning is still the right signal when you want a session to last
(you'll hit the cap before the reset at this rate), it just isn't the same kind of
budget breach that being ahead on the weekly window is.

---

## 3. Architecture

The hard boundary that makes Storybook and Vitest worth having: **no `chrome.*` API
call ever appears inside a React component.**

```
src/
  lib/                        # pure TypeScript, zero browser-extension deps
    usagePace.ts              #   deriveWindowStatus(snapshot, now) -> DerivedWindowStatus
    formatDuration.ts         #   "2h 14m left"
    formatClockTime.ts        #   "6:00 PM"
    usageTypes.ts             #   shared types
  extension/                  # the only place chrome.* is touched
    claudeUsageClient.ts      #   discoverOrganizationId(), fetchUsageSnapshot()
    usageStorage.ts           #   read/write chrome.storage.local
    serviceWorker.ts          #   alarms, fetch loop, badge
  components/                 # pure React, props-in only
    UsageWindowCard.tsx
    PaceIndicator.tsx
    UsagePopup.tsx            #   pure: takes UsagePopupData
    ui/                       #   shadcn primitives
  popup/
    PopupRoot.tsx             #   the only component that talks to extension/
    index.html
    main.tsx
```

`UsagePopup` receives a fully-derived view model and renders it. That makes every
visual state — loading, logged-out, ahead of pace, behind, window inactive, stale
data — a Storybook story with a hand-written fixture, and no extension host needed.

### Types

```ts
type UsageWindowKind = 'fiveHour' | 'sevenDay';

interface UsageWindowSnapshot {
  kind: UsageWindowKind;
  utilizationPercent: number;
  resetsAt: string;           // ISO 8601
}

interface DerivedWindowStatus {
  kind: UsageWindowKind;
  windowStartedAt: Date;
  windowResetsAt: Date;
  timeRemainingMs: number;
  percentUsed: number;
  pacePercent: number;
  paceDeltaPercentagePoints: number;
  paceStatus: 'ahead' | 'behind' | 'onTrack';
}
```

`deriveWindowStatus(snapshot, now)` takes `now` as an explicit argument — never reads
the clock internally. This is what makes the pace maths testable.

### Why the 5-minute refresh lives in the service worker

A `setInterval` in the popup dies the moment the popup closes, so it would only ever
fire while you are looking at it. Instead:

- `chrome.alarms.create('refreshUsage', { periodInMinutes: 5 })` in the service worker
- Handler fetches, writes `{ snapshot, fetchedAt }` to `chrome.storage.local`,
  updates the toolbar badge
- Popup on open: render cached data **immediately**, then fire one fresh fetch and
  re-render — no spinner-on-open if a cache exists
- Popup shows "updated 2m ago" from `fetchedAt`, and flags data older than ~15m as stale

MV3 service workers are killed when idle; `chrome.alarms` is the supported mechanism
for waking them and survives this correctly. `setInterval` in a service worker does not.

### manifest.json

```jsonc
{
  "manifest_version": 3,
  "name": "Claude Usage Optimizer",
  "permissions": ["storage", "alarms"],
  "host_permissions": ["https://claude.ai/*"],
  "background": { "service_worker": "serviceWorker.js", "type": "module" },
  "action": { "default_popup": "popup/index.html", "default_icon": { ... } }
}
```

Deliberately minimal: **no content script, no `cookies` permission, no `tabs`**. The
`credentials: 'include'` fetch from the service worker carries the session cookie by
virtue of the host permission alone. Keeping the permission set this small is also the
easiest path through Chrome Web Store review.

---

## 4. Tooling

All requested tools, with the roles they actually play:

| Tool | Role |
|---|---|
| pnpm | package manager; `packageManager` field pinned in `package.json` |
| TypeScript | strict mode (per `CLAUDE.md`), `@types/chrome` for extension APIs |
| Vite | build, plus `@crxjs/vite-plugin` for MV3 (see risk below) |
| React + Tailwind + shadcn/ui | popup UI, per `CLAUDE.md` stack |
| Vitest | unit tests for `src/lib/*`, mocked-fetch tests for `claudeUsageClient` |
| Storybook | every popup visual state as a story with fixtures |
| ESLint + Prettier | `eslint-config-prettier` so they don't fight; Prettier owns formatting |
| just | single entry point for every command |

### Build-tool risk

`@crxjs/vite-plugin` v2 is the ergonomic choice (HMR into the extension, manifest as
a typed TS module) but is still beta and has had maintenance gaps. **Fallbacks, in
order of preference:** `vite-plugin-web-extension`, or a plain multi-entry Vite build
(`popup/index.html` + `serviceWorker.ts` as a lib entry) with a static
`manifest.json` copied by a small post-build script. Decide this in Phase 0 — spike
it for an hour before committing, because switching later means redoing the build config.

### justfile

```
just install         # pnpm install
just dev             # vite dev (HMR)
just build           # production build -> dist/
just test            # vitest run
just test-watch      # vitest
just lint            # eslint
just format          # prettier --write
just format-check    # prettier --check
just typecheck       # tsc --noEmit
just storybook       # storybook dev
just build-storybook
just check           # typecheck + lint + format-check + test  (pre-commit gate)
just package         # zip dist/ for Web Store upload
```

---

## 5. Phases

### Phase 0 — Scaffold
pnpm init, TypeScript strict, Vite + React, Tailwind, shadcn init, ESLint, Prettier,
Vitest, Storybook, justfile, `.gitignore`. Spike the MV3 build plugin choice.
**Exit:** `just check` passes on an empty project; a hello-world popup loads unpacked.

### Phase 1 — Data layer (do this before any UI)
`claudeUsageClient.ts` — org discovery, usage fetch, defensive normalisation,
stale-org retry, typed error codes (`NOT_LOGGED_IN`, `NO_ORGS`, `HTTP_*`).
**Verify the window-duration assumption against a real logged-in account here.**
**Exit:** a temporary popup button logs a real, correctly-typed usage snapshot; the
window-start derivation is confirmed or the pace model is revised.

### Phase 2 — Pace engine
`usagePace.ts`, `formatDuration.ts`, `formatClockTime.ts`, all pure, all with `now`
injected. Vitest covers: mid-window, window boundaries, ahead/behind/on-track
thresholds, expired window (`resetsAt` in the past), missing `resetsAt`, clamping.
**Exit:** full unit coverage of the maths, no UI yet.

### Phase 3 — UI in Storybook
`UsageWindowCard`, `PaceIndicator`, `UsagePopup` built entirely against fixtures.
Stories for: loading, no-cache-first-run, logged out, on pace, ahead, behind,
window inactive, stale data. Light and dark.
**Exit:** every state reviewable in Storybook without loading the extension.

### Phase 4 — Wire it up
Service worker with `chrome.alarms`, storage cache, `PopupRoot` reading cache then
refreshing, toolbar badge showing the higher of the two utilisations.
**Exit:** loads unpacked, shows real data, auto-refreshes on the 5-minute alarm.

### Phase 5 — Polish
Icons, manual refresh button, "updated Nm ago", error states, README, `just package`.

### Phase 6 — Update `CLAUDE.md`
Once the extension is built and working, rewrite `CLAUDE.md` to describe *this*
project rather than generic web-frontend guidance. It currently predates the
codebase, so it says nothing about how the extension is actually laid out. Add:

- **Architecture rule** — the `src/lib` / `src/extension` / `src/components` split,
  and the hard boundary that `chrome.*` is never called from a React component.
  This is the single most useful thing to write down; it's the constraint that keeps
  Storybook and Vitest usable and the one most likely to be violated by accident.
- **Commands** — that `just` is the entry point for everything, and that `just check`
  is the gate to run before considering work done. Do not list raw pnpm/vite commands.
- **Testing conventions** — pure functions in `src/lib` take `now` as an explicit
  argument and never read the clock; new UI states get a Storybook story with a fixture.
- **The claude.ai API** — that it is unofficial and undocumented, that responses must
  be normalised defensively, and a pointer to the response shape in section 1 of
  this plan.
- **MV3 constraints** — periodic work goes through `chrome.alarms`, never
  `setInterval`, because the service worker is killed when idle. Keep the permission
  set minimal.

Keep the existing naming-convention and TypeScript sections — they still apply.

---

## 6. Open decisions

1. **Weekly Opus window** — the API returns `seven_day_opus`. Not in the brief, but
   `UsageWindowCard` is generic over window kind, so it is a config-line addition.
   Recommend shipping it as a third card; trivial to drop.
2. **Badge content** — proposal: highest utilisation across both windows, coloured by
   weekly pace status. Alternative is weekly-only, which is quieter.
3. **Notifications** — deliberately out of scope for MVP; would need the
   `notifications` permission. Revisit once pace is proven useful in daily use.

## 7. Deferred: activity-weighted pace

The genuinely novel version of this feature, and the reason to keep history from day
one. Time-proportional pace treats 3am Sunday the same as 10am Tuesday. If the weekly
window's expected-burn curve were weighted by *your own* historical activity
distribution, "ahead of pace" would mean something real for people who don't work
weekends. No existing extension does this — `tugrulcank-netizen` is the only one
persisting any history and only uses it for cost estimation.

**Cheap thing to do now that keeps the door open:** have the service worker append
each `{ fetchedAt, fiveHourPercent, sevenDayPercent }` sample to a capped ring buffer
(≈2000 entries) in `chrome.storage.local`. Costs almost nothing, needs no extra
permissions, and after a few weeks of use there is a real dataset to build the
weighted model against. Without it, Phase 2 of the product starts from zero data.
