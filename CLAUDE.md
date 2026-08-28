# Claude Usage Optimizer

A Chrome MV3 extension showing Claude.ai usage limits with a **pace** indicator —
whether you are ahead of or behind an even burn for each window.

## Top-level layout

Two top-level directories hold code; the rest is docs and the work queue.

```
chrome-extension/   the Chrome MV3 extension — see below. Owns node_modules/,
                     package.json and the whole Vite/TS/eslint/prettier toolchain,
                     since none of that applies to backend/.
backend/             the native-messaging host + autonomous-work scheduler —
                     see "Autonomous work scheduler" below. stdlib-only Python,
                     deliberately dependency-free.
findings/            postmortems
marketing/           the Chrome Web Store listing assets
plans/               design docs
summaries/           what each night's run actually did, one file per day.
                     Written by the scheduler, gitignored, for a person to read.
```

`justfile` and `CLAUDE.md` stay at the repository root, as does `prompts.txt`
(explained below — though the queue can also live on a Jira board instead) — everything else that is specific to one side lives inside
its directory. `summaries/` is at the top level for the same reason
`prompts.txt` is: the queue and the report on it are the two files here meant to
be read and edited by hand, so neither is buried in `backend/`.

## Where the rest of the guidance lives

The two code directories carry their own always-scoped guidance, loaded only when
you are working under them:

- **`chrome-extension/CLAUDE.md`** — the `chrome.*`-is-never-called-from-React
  architecture rule and the five-directory breakdown, the unofficial/undocumented
  claude.ai API and its defensive normalisation, and the MV3 constraints
  (`chrome.alarms` not `setInterval`, the minimal permission set, the two-pass
  build, the stale-service-worker / `BUILD_STAMP` trap).
- **`backend/CLAUDE.md`** — the autonomous-work scheduler and its pace gate, the
  three launch agents, resuming after the 5-hour window resets, the native host
  and the live run-log stream, `unmerged:<branch>` handling, and the Jira board
  as an alternative queue (including the credential and its warning system).

## Commands

`just` is the entry point for everything. Do not run raw pnpm/vite commands —
add a recipe instead. Never use `git add` or `git commit` — that is for the user
to do.

```sh
just setup           # everything a fresh clone needs, in one command
just check           # typecheck + lint + format-check — the gate
just build           # production build into chrome-extension/dist/
just --list          # everything else
```

`just setup` runs the install recipes in order and ends by printing the one
step it cannot do itself: loading the unpacked extension, which needs a human
to click through `chrome://extensions`.

**Every `install-*` recipe must stay safe to re-run at any point**, because
`setup` chains them and is the first thing to reach for when something has come
unstuck. They rewrite their output from a template, or compare and leave an
up-to-date file alone; none appends or accumulates. Keep it that way when adding
one. The single exception is `install-autonomous-work`, which reloads the launch
agent and so stops a nightly run in flight — recorded as a cancellation, leaving
the queue entry `todo`.

**`just check` must pass before work is considered done.**

## Naming Conventions

- **ALWAYS prefer readability over brevity** when naming things we control
  (variables, functions, classes, files). A few extra characters typed once
  saves thousands of moments of confusion reading code later.
- When naming variables, consider potential ambiguity in context (e.g., `data`
  could mean anything — prefer `userProfileData`; `result` tells you nothing —
  prefer `validatedToken`).
- AI tends to over-index on brief names from training data. Actively resist this.

