# Plan: The queue file in an Obsidian vault

> **Status: rejected. Not being built.** It was chosen over the gist, Google Doc
> and GitHub issues designs, and then lost to a Jira board — see
> `plans/work-queue-as-a-jira-board.md` §1. The short version: keeping the file
> and moving it bought the queue a phone, but inherited a markdown editor that
> renders `===` as a heading (§5 below), a conflict window it could not close
> (§9), and an eviction failure that looks exactly like an empty queue (§7).
> Everything below is kept as the record of a design that was worked out properly
> and still lost. The rejected issues design is now at
> `plans/rejected/work-queue-as-github-issues.md`.

## Goal

`prompts.txt` lives at the repository root on one Mac. It is the file this
project most expects to be edited by hand, and the one file you cannot reach
from anywhere else.

Move it into an **Obsidian vault** — an ordinary folder, synced by something the
user already runs — and add the small amount of code that makes a queue file
outside the repository safe to depend on.

Not in scope: any sync code of our own. This project never touches the network
for the queue, and never learns which sync tool is behind the path.

## 1. What choosing Obsidian decides — and what it does not

**Obsidian is the editor. It is not a sync mechanism.** A vault is a folder on
disk; Obsidian opens it. Sync is a separate, independent choice (§3), and this
is the assumption most likely to send the setup down a wrong turn, because
"Obsidian Sync" exists as a product and reads like a requirement. It is not one.

What Obsidian buys: the best plain-text editing surface on a phone, on both
Android and iOS, free, with real line selection — which matters because
**reordering sections by cut-and-paste is the single ergonomic property that won
the file its argument** against issues.

What it costs: two settings and a CSS snippet, because Obsidian is a *markdown*
editor and our file is not markdown. §5 and §6 are those costs, and §5 in
particular will otherwise cost somebody a confused morning.

## 2. The rule that shapes the design

> **Sync a folder, not an app.**

If the queue is an ordinary file in an ordinary folder, the sync mechanism and
the editor are independent and either can be swapped in five minutes. If it
lives inside one app's private storage, the editor is fixed by the sync.

This has a concrete consequence for Obsidian specifically:

- **On Android**, a vault is a folder you point Obsidian at. Any sync tool can
  maintain it, and any other editor can also open the file. This is the shape to
  aim for.
- **On iOS**, an Obsidian-Sync vault lives in the app's sandbox where nothing
  else can reach it. That violates the rule above. On iOS, prefer a vault in
  iCloud Drive (reachable through the Files app by any editor) over Obsidian
  Sync.
- **On iOS, Obsidian cannot open a vault from a third-party Files provider at
  all** — only its own app storage or iCloud Drive. It needs real directory
  read/write and file watching, which providers do not give it. **This rules
  Google Drive and Dropbox out as vault hosts on iOS entirely**, however they
  are configured. Verify before committing if iOS matters; plan on it being
  true.

## 3. Choosing the sync

All four present the same thing to the Mac: a file in a folder.

| Sync | Mac vault path | Cost | Notes |
| --- | --- | --- | --- |
| **Syncthing** | any folder | free | Nothing on anyone's server. Android battery management can delay a push. |
| **Autosync / FolderSync** → Drive or Dropbox | any folder | free | Uses an existing account. One more moving part. |
| **Obsidian Sync** | any folder | ~$5/mo | End-to-end encrypted, and keeps file version history — the only option here that can *recover* from a conflict. Sandboxed on iOS (§2). |
| **iCloud Drive** | `~/Library/Mobile Documents/…` | free | Apple devices only — **no Android client exists**. Needs a TCC grant and the placeholder handling in §7. |

**Recommended placement: a plain folder outside the gated ones**, e.g.
`~/code/queue-vault/`. `~/Desktop`, `~/Documents`, `~/Downloads`,
`~/Library/Mobile Documents` and `~/Library/CloudStorage` are each TCC-gated, and
a **launchd** run is refused silently with `Operation not permitted` — see
CLAUDE.md, "Protected folders". A plain folder needs no grant at all, and every
sync tool above will mirror one.

**Keep the vault outside the git repository.** `prompts.txt` is gitignored
because it is somebody's personal task list; a vault inside the repo would also
drag `.obsidian/` into it.

### Google Drive in particular — the weakest of the four, and why

Drive is the option most people already have, so it needs its objections stated
rather than implied. Seven, roughly in order of how much each would bite here:

1. **Streaming evicts file contents, and it is the default.** Files are not on
   disk until opened. A 2 AM read may need the network, and offline it fails
   looking exactly like a missing file — the same trap as §7's iCloud
   placeholder, except opt-*out* rather than opt-in. The folder must be marked
   **Available offline**.
2. **The mount is TCC-gated.** `~/Library/CloudStorage/GoogleDrive-<email>/`
   needs the folder grant on the re-signed private uv, and is not in
   `PROTECTED_FOLDERS` today, so it is currently unmeasured.
3. **It is a virtual filesystem, which weakens the atomic write.** §7's
   `os.replace` is a hard guarantee on APFS and a weaker one on a macOS File
   Provider volume. This is the only objection here that touches durability
   rather than convenience.
4. **Drive for Desktop must be running and signed in.** Auth expires
   periodically and sync stops silently until somebody clicks — the failure
   where an 11 PM edit never arrives and nothing says so.
5. **Two moving parts on Android**, since Drive's provider cannot be edited in
   place: a mirror app with its own schedule (15–60 minutes on free tiers) and
   its own battery restrictions.
6. **Conflict copies are named unpredictably** — a `(1)` suffix or a device
   name, rather than a stable pattern. That makes §11's conflict detector harder
   to write than for Syncthing's `.sync-conflict-`.
7. **Not end-to-end encrypted.** It is the user's own storage, so it meets the
   "not shared" bar, but Google holds the plaintext.

**The workaround that removes the first three.** Do not use the CloudStorage
mount. Drive for Desktop can mirror an *arbitrary local folder* — "Folders from
your computer" → Add folder → Sync with Google Drive. Point it at
`~/code/queue-vault` and the file sits on plain APFS: no TCC grant, real
`os.replace` atomicity, no eviction, while still being in Drive.

Two caveats on that workaround, both worth checking before relying on it: such
folders appear in Drive's separate **Computers** section rather than My Drive,
and whether Autosync can mirror *from* Computers on Android is unverified.

**And on iOS none of this matters**, because §2 rules Drive out as a vault host
there regardless.

## 4. The vault holds two things, not one

This is the part worth building for, and it comes free.

CLAUDE.md describes `prompts.txt` and `summaries/` as *"the two files here meant
to be read and edited by hand"*. The issues plan called "somewhere to read the
account of what happened" its real prize — today Claude's closing message lands
in `summaries/YYYY-MM-DD.md` on the Mac, the one place you cannot read it from a
train. The vault gets that prize without a line of new code, because
**`AUTONOMOUS_WORK_SUMMARIES_DIR` already exists** as an override and the
summaries are already markdown, which Obsidian renders properly.

```
~/code/queue-vault/
  prompts.md              the queue        → AUTONOMOUS_WORK_QUEUE_FILE
  summaries/2026-08-27.md the report on it → AUTONOMOUS_WORK_SUMMARIES_DIR
  .obsidian/snippets/monospace.css         → §6
```

Write the queue on the train; read what it did over breakfast, on the same
phone, in the same app. §8 makes the summaries directory a settable path rather
than an environment variable so this is reachable from the Settings screen.

## 5. Markdown hazards — the section that saves a morning

Our format is not markdown, and Obsidian's default rendering mode actively
misreads it.

**A line of `===` is a setext H1.** In markdown, `===` *underneath* text makes
that text a level-one heading. Our `SECTION_SEPARATOR_PREFIX` is exactly `===`,
so in Live Preview every section separator turns the last line of the previous
prompt into a giant heading — **and hides the separator itself**. The structure
of the file becomes invisible in the one view you are editing in.

> **Fix: Settings → Editor → Default editing mode → Source.**

That is a per-vault setting stored in `.obsidian/app.json`, so it syncs to the
phone with everything else. Source mode also fixes the two lesser versions of
the same problem: `_` and `*` inside a repo path rendering as emphasis, and
`#` at the start of a comment line rendering as a heading.

**Considered and rejected: changing the separator.** `===` is baked into
`parse_queue`, `prompts.example.txt`, and every existing queue. Changing a file
format to suit one editor's preview mode is the tail wagging the dog, and it
would break every queue already in the wild.

**Do not let the file begin with `---`.** Obsidian would read it as YAML
frontmatter and render it as a properties panel. We do not use `---`; this is a
note for whoever is tempted to prettify the header comment.

**Obsidian does not reformat on save.** It writes back what you typed. The
format is safe at rest — the hazards above are all about *display*, which is
what makes them insidious rather than destructive.

## 6. Monospace

Obsidian is a prose editor and its default font is proportional. `STATUS:` lines,
`===` separators and pasted paths only scan as structure in a fixed-width font.

Two routes, and the second is the one to ship:

- Appearance → Font → Text font. Works, but the mobile picker offers a short
  list, and it is set per-device.
- **A CSS snippet in the vault**, which syncs, so it applies on desktop and
  mobile alike from one place:

  ```css
  /* .obsidian/snippets/monospace.css */
  .markdown-source-view.mod-cm6 .cm-scroller {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  ```

  Enabled once at Appearance → CSS snippets. Ship it in the repo as
  `backend/templates/obsidian-monospace.css` and have the install recipe copy it
  into the vault, following the "rewrite from a template, never append" rule
  every `install-*` recipe follows.

## 7. What changes in the code

Smaller than any alternative considered, which is the other half of why the file
won.

### The queue path becomes a setting, not just an environment variable

`QUEUE_FILE` (`run-autonomous-work.py:130`) already reads
`AUTONOMOUS_WORK_QUEUE_FILE`, but an environment variable is invisible to the
Settings screen and cannot be set for a launchd job without rewriting the plist
and reloading the agent. It gains a mirrored setting with exactly the precedence
`NEW_PROJECTS_DIRECTORY` already uses:

> environment variable → mirrored setting → `PROJECT_ROOT / "prompts.txt"`

- `autonomous_work_settings.py`: a `queue_file` field defaulting to `""`
  (meaning the repository's own `prompts.txt`), with a `queue_file_path`
  property expanding `~` the way `new_projects_path` does.
- `settingsTypes.ts` and the settings screen: one path field.
  `syncAutonomousWorkSettings` spreads, so it needs no change — the reason it
  spreads.
- `usage-host.py`'s `parse_settings`: one more key, logged in the arriving key
  list like the rest.

**`summaries_directory` gets the identical treatment**, for §4.

### Reading has to tell three failures apart

`read_queue_lines` logs one message for everything. In a synced folder the cases
mean different things and need different words:

| Condition | Means | Run does |
| --- | --- | --- |
| Parent folder missing | Sync not mounted or not running | Say so; exit 0 |
| A dehydrated placeholder stands in for the file | Evicted by iCloud "Optimise Mac Storage", or by Drive's streaming mode | For iCloud (`<name>.icloud`), `brctl download` and re-read once; otherwise open the path to force the provider to hydrate it. Either way, say plainly if it is still absent |
| File missing, folder present | Genuinely no queue | Today's message, unchanged |

The middle row is the most likely way this feature fails in a way nobody
diagnoses: the real filename simply does not exist on disk, and today's log line
would read "No prompt queue at …" while the file sits visibly in Finder.

### The atomic write needs a temp name the sync tools can ignore

`write_queue_status` writes a `NamedTemporaryFile` into `QUEUE_FILE.parent` and
`os.replace`s it — right for durability, and it stays. But in a synced vault
every status rewrite now creates a `tmpXXXXXX` that Syncthing or Autosync
propagates to the phone, where it shows up in Obsidian's file list.

Give it a deterministic dotted name — `.prompts.md.tmp` beside the target — so
one ignore rule covers it forever.

### Log the queue's age on every run

The snapshot's age is already logged on every pace decision, for exactly this
reason: a stale input used anyway must be visible after the fact. A phone edit
that never synced — a sleeping Android, a paused Syncthing — is the same class
of problem, and *"queue last modified two days ago"* is the line that makes it
diagnosable. Same convention and wording as `describe_age`.

### `just setup` must respect the setting

`setup` copies `prompts.example.txt` to `prompts.txt` at the repository root if
absent. With a configured queue path it creates *that* file instead, and leaves
an existing one alone — the `install-*` idempotency contract.

## 8. What to ignore, per sync tool

Obsidian writes `.obsidian/workspace.json` on nearly every pane change, so a
vault is noisier than a plain folder. Two entries cover it:

```
.obsidian/workspace.json     # constant churn, per-device state
.prompts.md.tmp              # the atomic-write temp file
```

Syncthing takes these in `.stignore`; FolderSync and Autosync have exclude
lists; Obsidian Sync excludes `workspace.json` itself by default. Document the
rule per tool in the README rather than assuming one shape.

## 9. The conflict window

The run rewrites one `STATUS:` line at 2 AM. If the file is open and being
edited on a phone at that moment, no folder sync merges — Syncthing keeps a
`prompts.sync-conflict-….md`, iCloud and Dropbox leave a duplicate — and you are
left with two files and no signal which one the scheduler reads next.

Weighed honestly: one line, once a night, while you are asleep. **Accepted, not
mitigated in code**; the alternative is a merge engine, which is the complexity
the file design exists to avoid. Two cheap things make it survivable:

- `just queue-file` reports the path, last-modified time, whether it is an
  iCloud placeholder, and **whether conflict-copy siblings exist** — the names
  are predictable per tool.
- The age log line makes "the run read the wrong copy" visible next morning
  rather than never.

Obsidian Sync is the one option that can recover rather than just report, since
it keeps per-file version history. That is its main argument over Syncthing.

## 10. One file, not one note per prompt

A vault will tempt you to split the queue into a note per prompt, because that
is what vaults are for. **Resist it.** Reordering by cut-and-paste is the
property that won the file its argument against GitHub issues, and it only works
within a single file. A vault of forty prompt-notes is the issues design again
with worse tooling.

## 11. Recipes

```sh
just queue-file              # path, age, placeholder?, conflict copies?
just move-queue <path>       # move the file and update the setting together
just install-obsidian-vault  # create the vault, copy the CSS snippet,
                             # print the two settings only a human can click
just check-folder-access     # unchanged, plus ~/Library/CloudStorage
```

`move-queue` exists because by hand it is three steps with a silent failure in
the middle: move the file, change the setting, and — if the new home is gated —
know that the grant is per-folder and must be redone.

`install-obsidian-vault` ends by printing what it cannot do itself, the way
`just setup` ends on `chrome://extensions`: **set Default editing mode to
Source, and enable the monospace snippet.** Both are clicks in Obsidian.

## 12. Decisions taken

- **A single plain text file**, over gist, Doc and issues. Recorded in
  `plans/work-queue-as-github-issues.md`.
- **Obsidian is the editor, not the sync.** §1.
- **Sync a folder, not an app** — which specifically means avoiding Obsidian
  Sync on iOS. §2.
- **A plain folder outside the TCC-gated ones**, so the common case needs no
  grant. §3.
- **The vault holds the summaries too.** §4.
- **`===` stays; the editor changes mode.** §5.
- **Conflicts are accepted and reported, never merged.** §9.

### The one most worth disagreeing with

**Choosing an editor whose default rendering mode breaks the file format.** A
plain code editor — Markor on Android, Runestone on iOS — displays this file
correctly with zero configuration, in monospace, out of the box. Obsidian needs
Source mode, a CSS snippet, and an ignore rule, and §5 exists entirely because
of it. The case for it anyway: it is the better editor once configured, it is
the same app on both platforms, and §4's summaries-in-the-vault payoff is real
and specific to it. Revisit if the configuration does not survive a sync to a
second device.

## 13. Risks and unknowns

- **The iCloud placeholder** (§7) is handled for iCloud only. If Dropbox's or
  Drive's smart-sync eviction produces a different stub, it will look like an
  empty queue. `just queue-file` is the detector.
- **`.obsidian/app.json` syncing the editing mode** is expected but unverified —
  if Source mode does not carry to the phone, it must be set there too, and §5's
  hazard is live until it is.
- **Android battery management pausing Syncthing**, so an 11 PM edit is absent at
  2 AM. Not fixable from here; the age log makes it visible.
- **TCC on `~/Library/CloudStorage`** is unmeasured today. Adding it to
  `PROTECTED_FOLDERS` is one line and turns an unknown into a report.
- **Obsidian's mobile sync needs the app open** to complete. An edit made and
  immediately backgrounded may not have landed.
- **`os.replace` on a virtual filesystem.** If the vault ends up on a File
  Provider volume (Drive's or Dropbox's mount), the atomic-replace guarantee
  `write_queue_status` relies on is weaker than on APFS. The §3 workaround —
  mirror a plain local folder instead of using the mount — avoids it entirely,
  and is the reason that workaround is recommended rather than merely noted.
- **Obsidian on iOS refusing third-party providers** (§2) is stated from
  behaviour, not documentation. If iOS is in scope, verify it before choosing a
  sync, because it eliminates two of the four options outright.

## 14. Phases

1. **The settings.** `queue_file` and `summaries_directory` through
   `autonomous_work_settings.py`, the host and the settings screen, with the
   three-level precedence. Everything still works with both unset.
2. **Robust reading.** The three-case read, placeholder recovery, the
   deterministic temp name, the queue-age log line.
3. **Tooling.** `just queue-file`, `just move-queue`,
   `just install-obsidian-vault`, `~/Library/CloudStorage` in the folder probe,
   and `just setup` respecting the setting.
4. **Documentation.** A README section: the vault layout, Source mode, the
   snippet, and the ignore rules per sync tool.

Phase 1 alone lets you point the queue at a vault by hand. Phases 2 and 3 are
what stop it failing silently a month later.

## 15. Success criteria

- A prompt typed into Obsidian on a phone at 11 PM runs at 2 AM.
- Last night's summary is readable in the same vault, on the same phone.
- Section separators are visible while editing on both desktop and mobile.
- With the vault unmounted, the run says so in one line and exits 0.
- With the file evicted to a placeholder, the run recovers it or says exactly
  why it could not.
- A status rewrite leaves no stray temp file for the sync to propagate.
- With nothing configured, behaviour is byte-identical to today.
