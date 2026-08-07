# Plan: Claude Usage Optimizer — MV3 Chrome Extension (MVP)

> **Status: implemented 2026-08-07.** Phases 0–6 are done and `just check` passes
> (83 tests across 8 files). `dist/` builds and `just package` produces a zip.
> Section-by-section notes on what actually happened are inline below, marked
> **Built:**. The one thing still outstanding is the live-data verification in
> Phase 1 — see [What is still unverified](#what-is-still-unverified).

## Goal

A Chrome extension that shows Claude.ai 5-hour and weekly usage limits in a toolbar
popup, with a **pace** indicator telling you whether you are ahead of or behind the
even-burn rate for each window. No manual configuration of any kind.

## Requirements (from the brief)

| #   | Requirement                                                         | How it is met                                                                                |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | No pasting an org ID                                                | Service worker discovers it from `GET /api/organizations`                                    |
| 2   | Click toolbar icon → panel below the icon bar; click-outside closes | MV3 `action.default_popup` — this is exactly the native popup behaviour, no custom windowing |
| 3   | 5-hour window: start, finish, time left, % used, pace %             | `UsageWindowCard` component                                                                  |
| 4   | Weekly window: same fields                                          | Same component, different props                                                              |
| 5   | Refresh every 5 minutes                                             | `chrome.alarms` in the service worker (not a popup timer — see note)                         |

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
  "five_hour": { "utilization": 42, "resets_at": "2026-08-07T18:00:00Z" },
  "seven_day": { "utilization": 61, "resets_at": "2026-08-11T09:00:00Z" },
  "seven_day_opus": { "utilization": 12, "resets_at": "2026-08-11T09:00:00Z" },
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

**Built:** `src/extension/claudeUsageClient.ts`, all of the above plus:

- `fetch` and the org-ID cache are **injected**, so the client touches no
  `chrome.*` API and is tested against fakes rather than a browser.
- Normalisation went wider than planned: it also accepts `utilizationPercent`,
  `resetsAt`, a numeric utilisation delivered as a string, and reads a window
  _start_ (`starts_at` / `started_at` / `window_start`) if the API ever supplies
  one. Windows with no readable utilisation are dropped; a payload with no
  recognisable windows raises `MALFORMED_RESPONSE`.
- Stale-org retry deliberately **excludes** `NOT_LOGGED_IN` — a stale cache
  cannot explain "you are logged out", so retrying there would just double the
  failed requests.
- Error codes: `NOT_LOGGED_IN`, `NO_ORGANIZATIONS`, `HTTP_ERROR` (carries the
  status), `NETWORK_ERROR`, `MALFORMED_RESPONSE`. The popup maps each to its own
  headline and guidance copy.

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

**Built — and this assumption is still open.** It could not be checked: driving a
logged-in browser from the CLI did not work (see
[What is still unverified](#what-is-still-unverified)). Rather than block, the
code was written to survive either answer:

- `deriveWindowStatus` prefers a start reported by the API over the derived one,
  so if a start field appears the maths becomes correct automatically.
- When both ends are known it uses the **reported span** rather than the nominal
  5h/7d duration, so a window that is extended or shortened still paces right.
- If the weekly window turns out to be rolling, only `USAGE_WINDOW_DURATIONS_MS`
  and this function need revisiting — nothing in the UI encodes the assumption.

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

**Built, with these additions:**

```
src/
  lib/
    usageBadge.ts             #   deriveBadgeState(snapshot, now) — badge is pure too
    usagePopupData.ts         #   buildUsagePopupData(cacheEntry, now) -> UsagePopupData
    paceDescription.ts        #   "12 points ahead of pace" — the copy, unit-tested
  extension/
    messages.ts               #   popup -> worker refresh message
  components/
    usageFixtures.ts          #   Storybook fixtures, built via the real pace engine
popup.html                    #   at the repo root, not src/popup/index.html
```

Three deviations worth knowing:

1. **`popup.html` sits at the repo root.** Vite emits an HTML entry at a path
   relative to its root, so `src/popup/index.html` would have landed at
   `dist/src/popup/index.html`. Moving the entry to the root gives a clean
   `dist/popup.html` with no post-build path rewriting, and leaves the Vite
   config free of a `root` override that would have fought with Storybook.
2. **The popup does not fetch.** It sends `REFRESH_USAGE` to the service worker,
   which fetches, writes storage and updates the badge. One code path regardless
   of whether a refresh was triggered by the alarm or by opening the popup, and
   it keeps the network call on the `extension/` side of the boundary.
3. **`UsageCacheEntry` lives in `lib/usageTypes.ts`**, not in `usageStorage.ts`,
   so `buildUsagePopupData` can stay pure without `lib/` importing `extension/`.

### Types

```ts
type UsageWindowKind = 'fiveHour' | 'sevenDay';

interface UsageWindowSnapshot {
  kind: UsageWindowKind;
  utilizationPercent: number;
  resetsAt: string; // ISO 8601
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

**Built — the shipped types differ in two ways.** `UsageWindowKind` gained
`'sevenDayOpus'` (open decision 1), and `DerivedWindowStatus` became a
discriminated union rather than one flat interface, because "window inactive" is
a genuinely different shape — it has a `percentUsed` but no start, reset or pace:

```ts
type UsageWindowKind = 'fiveHour' | 'sevenDay' | 'sevenDayOpus';

interface UsageWindowSnapshot {
  kind: UsageWindowKind;
  utilizationPercent: number;
  resetsAt: string | null; // null = window not running
  startedAt: string | null; // populated only if the API reports one
}

type DerivedWindowStatus = ActiveWindowStatus | InactiveWindowStatus;
// ActiveWindowStatus adds `isActive: true` and `hasResetElapsed`, and clamps
// timeRemainingMs to >= 0 so a stale snapshot cannot render a negative span.
```

The union means the compiler forces every consumer to handle the inactive case;
a flat interface with optional fields would have let it be forgotten.

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

**Built as specified**, with `default_popup` at `popup.html` (see deviation 1
above) and the icon set generated from source. The permission set is exactly the
three listed. `chrome.tabs.create` is used to open claude.ai and needs no `tabs`
permission — that permission only gates _reading_ tab properties.

The alarm is created with `delayInMinutes: 0.1` alongside `periodInMinutes: 5`,
so the badge populates seconds after install rather than after the first
five-minute tick. `ensureRefreshAlarm()` also runs at the top level, so a worker
woken for any other reason re-asserts its alarm.

---

## 4. Tooling

All requested tools, with the roles they actually play:

| Tool                         | Role                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| pnpm                         | package manager; `packageManager` field pinned in `package.json`       |
| TypeScript                   | strict mode (per `CLAUDE.md`), `@types/chrome` for extension APIs      |
| Vite                         | build, plus `@crxjs/vite-plugin` for MV3 (see risk below)              |
| React + Tailwind + shadcn/ui | popup UI, per `CLAUDE.md` stack                                        |
| Vitest                       | unit tests for `src/lib/*`, mocked-fetch tests for `claudeUsageClient` |
| Storybook                    | every popup visual state as a story with fixtures                      |
| ESLint + Prettier            | `eslint-config-prettier` so they don't fight; Prettier owns formatting |
| just                         | single entry point for every command                                   |

### Build-tool risk

`@crxjs/vite-plugin` v2 is the ergonomic choice (HMR into the extension, manifest as
a typed TS module) but is still beta and has had maintenance gaps. **Fallbacks, in
order of preference:** `vite-plugin-web-extension`, or a plain multi-entry Vite build
(`popup/index.html` + `serviceWorker.ts` as a lib entry) with a static
`manifest.json` copied by a small post-build script. Decide this in Phase 0 — spike
it for an hour before committing, because switching later means redoing the build config.

**Decided: the plain-Vite fallback, no extension plugin at all.** Two config
files, run in sequence by `just build`:

- `vite.config.ts` — builds `popup.html`, and copies `public/` (holding
  `manifest.json` and the icons) to the root of `dist/`. `base: './'` because a
  `chrome-extension://` origin only resolves relative asset URLs.
- `vite.config.serviceWorker.ts` — a lib build with
  `rollupOptions.output.codeSplitting: false`, so `dist/serviceWorker.js` is one
  self-contained ES module with no shared chunks for Chrome to resolve at worker
  start-up. Runs with `emptyOutDir: false` so it does not wipe the popup build.

No beta dependency, nothing to break, and the whole build config is ~60 lines.
The cost is no HMR into a live extension — Storybook covers the UI loop instead,
which is where the iteration actually happens.

**Two other tooling notes.** TypeScript is pinned to 5.9: 7.0 is out, but no
stable `typescript-eslint` supports it yet (`>=4.8.4 <6.1.0` peer range), so
linting would have broken. And Storybook 10 needs no addon for the theme
toolbar — `globalTypes` plus a decorator renders each story light **and** dark
side by side, which is the default view.

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

All phases complete. Notes below record what actually happened.

### Phase 0 — Scaffold ✅

pnpm init, TypeScript strict, Vite + React, Tailwind, shadcn init, ESLint, Prettier,
Vitest, Storybook, justfile, `.gitignore`. Spike the MV3 build plugin choice.
**Exit:** `just check` passes on an empty project; a hello-world popup loads unpacked.

**Done.** Build plugin decided as above (plain Vite, two passes). `shadcn init`
was skipped in favour of hand-writing the two primitives actually needed
(`Button`, `Card`) in shadcn's own idiom — the CLI is interactive and would have
pulled in a generator for components that were never going to be used. Strict
mode is on plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and
`verbatimModuleSyntax`.

### Phase 1 — Data layer (do this before any UI) ✅ (partially verified)

`claudeUsageClient.ts` — org discovery, usage fetch, defensive normalisation,
stale-org retry, typed error codes (`NOT_LOGGED_IN`, `NO_ORGS`, `HTTP_*`).
**Verify the window-duration assumption against a real logged-in account here.**
**Exit:** a temporary popup button logs a real, correctly-typed usage snapshot; the
window-start derivation is confirmed or the pace model is revised.

**Client done, 21 tests against mocked fetch.** The live-account verification did
not happen — see [What is still unverified](#what-is-still-unverified). The pace
model was written to tolerate both answers instead, so this did not block the
later phases.

### Phase 2 — Pace engine ✅

`usagePace.ts`, `formatDuration.ts`, `formatClockTime.ts`, all pure, all with `now`
injected. Vitest covers: mid-window, window boundaries, ahead/behind/on-track
thresholds, expired window (`resetsAt` in the past), missing `resetsAt`, clamping.
**Exit:** full unit coverage of the maths, no UI yet.

**Done**, every listed case covered plus unparseable timestamps and
non-finite utilisation. Also added `usageBadge.ts` and `usagePopupData.ts` as
pure modules, so the badge and the popup's view model are unit-testable too.

### Phase 3 — UI in Storybook ✅

`UsageWindowCard`, `PaceIndicator`, `UsagePopup` built entirely against fixtures.
Stories for: loading, no-cache-first-run, logged out, on pace, ahead, behind,
window inactive, stale data. Light and dark.
**Exit:** every state reviewable in Storybook without loading the extension.

**Done**, 24 stories, each rendered light and dark side by side. Screenshotting
the built Storybook through headless Chrome caught two real bugs that reading the
code would not have:

1. The weekly card showed **identical Started and Resets values** — a seven-day
   window begins and ends on the same weekday, so `formatClockTimeWithDay`'s
   "Tue 19:00" could not tell them apart. Now includes the day number
   ("Tue 4, 19:00" vs "Tue 11, 19:00"), with a regression test.
2. The "on pace" fixtures were not on pace. The weekly fixture window is ~47%
   elapsed at the fixed `now`, not the ~65% assumed when writing them, so the
   supposedly-neutral story rendered amber.

### Phase 4 — Wire it up ✅

Service worker with `chrome.alarms`, storage cache, `PopupRoot` reading cache then
refreshing, toolbar badge showing the higher of the two utilisations.
**Exit:** loads unpacked, shows real data, auto-refreshes on the 5-minute alarm.

**Built.** The exit criterion is only partly demonstrated: the wiring is covered
by 8 tests against a hand-rolled fake `chrome` global (alarm → fetch → storage →
badge, message refresh, unknown-alarm ignored, logged-out, and
failure-keeps-last-snapshot), but it has not been watched running in a real
browser.

### Phase 5 — Polish ✅

Icons, manual refresh button, "updated Nm ago", error states, README, `just package`.

**Done.** Icons are generated from source by `scripts/generateIcons.js` — a
dependency-free PNG encoder (zlib + hand-rolled CRC32) that draws a supersampled
gauge ring at 16/32/48/128px, regenerated with `just icons`. Also: per-error-code
copy, a stale-data banner, a refresh-failed banner that keeps showing the last
known figures, and OS-theme following in the popup.

### Phase 6 — Update `CLAUDE.md` ✅

**Done** — every bullet below is now in `CLAUDE.md`, with the architecture rule
leading the file, and the naming-convention and TypeScript sections kept intact.

Once the extension is built and working, rewrite `CLAUDE.md` to describe _this_
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

## 6. Open decisions — all resolved

1. **Weekly Opus window** — the API returns `seven_day_opus`. Not in the brief, but
   `UsageWindowCard` is generic over window kind, so it is a config-line addition.
   Recommend shipping it as a third card; trivial to drop.

   **Resolved: shipped as a third card.** `'sevenDayOpus'` is a full
   `UsageWindowKind`, so it flows through the pace engine, the badge and the card
   with no special-casing. If the API stops returning it the window is simply
   dropped during normalisation and the card disappears — no error.

2. **Badge content** — proposal: highest utilisation across both windows, coloured by
   weekly pace status. Alternative is weekly-only, which is quieter.

   **Resolved: took the proposal.** `deriveBadgeState` returns the highest
   rounded utilisation across every window, coloured by weekly pace — amber
   ahead, blue behind, neutral on track — falling back to neutral when there is
   no weekly window. The number answers "how much have I used", the colour
   answers "should I care".

3. **Notifications** — deliberately out of scope for MVP; would need the
   `notifications` permission. Revisit once pace is proven useful in daily use.

   **Resolved: still out of scope.** Not built; the permission set stays at three.

## 7. Deferred: activity-weighted pace

The genuinely novel version of this feature, and the reason to keep history from day
one. Time-proportional pace treats 3am Sunday the same as 10am Tuesday. If the weekly
window's expected-burn curve were weighted by _your own_ historical activity
distribution, "ahead of pace" would mean something real for people who don't work
weekends. No existing extension does this — `tugrulcank-netizen` is the only one
persisting any history and only uses it for cost estimation.

**Cheap thing to do now that keeps the door open:** have the service worker append
each `{ fetchedAt, fiveHourPercent, sevenDayPercent }` sample to a capped ring buffer
(≈2000 entries) in `chrome.storage.local`. Costs almost nothing, needs no extra
permissions, and after a few weeks of use there is a real dataset to build the
weighted model against. Without it, Phase 2 of the product starts from zero data.

**Built.** `appendUsageHistorySample` writes to a 2000-entry ring buffer under
`usageHistory` on every successful refresh, including `sevenDayOpusPercent`.
Nothing reads it yet — that is the point. Data starts accumulating from first
install, so whenever the weighted model gets built it has real history behind it.

---

## What is still unverified

Two things could not be checked, both needing a browser and neither blocking the
build.

**1. The live API shape — the Phase 1 exit criterion.** Whether `resets_at − 7d`
is really the weekly window start, and whether the field spellings match §1. The
code defends against being wrong (see the Phase 2 note), but it has not been seen
against a real response. To settle it: open
`https://claude.ai/api/organizations` while signed in, then
`https://claude.ai/api/organizations/{uuid}/usage`, and compare against §1.

**2. That the extension loads and runs in Chrome.** `dist/` is complete and the
manifest is valid, but no one has watched the service worker register, the alarm
fire, or the badge paint.

Verifying #2 from the CLI turned out to be impossible:

- Chrome has **removed the `--load-extension` switch**, and
  `--disable-features=DisableLoadExtensionCommandLineSwitch` no longer revives it.
  Confirmed by dumping the profile's extension list after launch — only component
  extensions were present.
- `--headless=new` blocks navigating to `chrome-extension://` pages
  (`ERR_BLOCKED_BY_CLIENT`), so the popup cannot be inspected that way either.
- The Claude-in-Chrome integration refused to connect across three attempts and a
  Chrome restart, despite every prerequisite checking out (extension installed,
  native messaging host manifest and binary present and current, no API-key auth,
  Claude Code 2.1.223). No process ever spawned from
  `~/.claude/chrome/chrome-native-host`.

So loading it by hand is currently the only route: `chrome://extensions` →
Developer mode → **Load unpacked** → select `dist/`.
