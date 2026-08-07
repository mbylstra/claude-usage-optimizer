# Claude Usage Optimizer

A Chrome MV3 extension showing Claude.ai usage limits with a **pace** indicator —
whether you are ahead of or behind an even burn for each window.

## Architecture — the rule that matters

**`chrome.*` is never called from a React component.**

```
src/
  lib/          pure TypeScript, zero browser-extension dependencies
                pace maths, formatters, view-model construction, badge, types
  extension/    the only place chrome.* is touched
                claudeUsageClient.ts, usageStorage.ts, serviceWorker.ts, messages.ts
  components/   pure React, props in only — plus ui/ for shadcn primitives
  popup/        PopupRoot.tsx — the one component that talks to extension/
```

This is the constraint that keeps Storybook and Vitest usable, and the one most
likely to be violated by accident. Two things follow from it:

- `claudeUsageClient.ts` lives in `extension/` but takes `fetch` and its
  organization-ID cache as injected dependencies, so it touches no browser API
  and is testable with a fake.
- `UsagePopup` receives a fully-derived view model from `buildUsagePopupData`
  and renders it. Every visual state is therefore reachable from a fixture.

When adding a feature, ask which of the four directories it belongs in before
writing it. Maths and formatting go in `lib/` even if only one component uses
them.

## Commands

`just` is the entry point for everything. Do not run raw pnpm/vite/vitest
commands — add a recipe instead.

```sh
just check           # typecheck + lint + format-check + test — the gate
just build           # production build into dist/
just test-watch      # tests in watch mode
just storybook       # every UI state, both themes
just --list          # everything else
```

**`just check` must pass before work is considered done.**

## Testing conventions

- Pure functions in `src/lib` take `now` as an explicit `Date` argument and
  **never read the clock**. This is what makes the pace maths deterministic.
  `deriveWindowStatus(snapshot, now)`, not `deriveWindowStatus(snapshot)`.
- Every new UI state gets a Storybook story with a hand-written fixture in
  `src/components/usageFixtures.ts`. Fixtures are built by running real
  snapshots through the real pace engine, never by hand-writing a
  `DerivedWindowStatus` — that way a story cannot show a state the engine would
  never produce.
- The service worker is tested against a hand-rolled fake `chrome` global
  (`serviceWorker.test.ts`), which exercises the real call shapes.

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

## Tech Stack

- **Language**: TypeScript with strict mode enabled
- **Styling**: Tailwind CSS v4 with the Vite plugin, CSS-first config in
  `src/index.css`
- **UI Components**: shadcn/ui-style primitives, hand-written in
  `src/components/ui/`
- **Icons**: Lucide React
- **Build Tool**: Vite with React plugin

## Naming Conventions

- **ALWAYS prefer readability over brevity** when naming things we control
  (variables, functions, classes, files). A few extra characters typed once
  saves thousands of moments of confusion reading code later.
- When naming variables, consider potential ambiguity in context (e.g., `data`
  could mean anything — prefer `userProfileData`; `result` tells you nothing —
  prefer `validatedToken`).
- AI tends to over-index on brief names from training data. Actively resist this.

## TypeScript

- Avoid `any` type unless absolutely necessary — strict mode is enabled
- Leverage TypeScript's type system to catch errors at compile time
