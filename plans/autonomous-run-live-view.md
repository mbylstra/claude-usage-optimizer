# Plan: Live view of an autonomous work run

## Goal

Pressing **Run now** in the popup currently reports only that the native host
_accepted_ the request. The run itself then proceeds invisibly for up to an
hour, and the only way to watch it is `just autonomous-log` in a terminal.

This adds a **detached extension window** that streams the run as it happens:
status header, a readable timeline of what Claude is doing, and a Cancel button.

## Decisions already taken

| Question           | Decision                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Where the UI lives | A detached popup window (`chrome.windows.create`, `type: 'popup'`) on a new extension page |
| How much it shows  | Structured stream-json events: status header, timeline, cancel, raw-JSON toggle            |
| Auto-open          | Manual only. The window opens on **Run now**, and can be reopened to read the last run     |

The nightly 2 AM run deliberately does **not** raise a window. It writes to the
same event stream, so opening the view later shows what it did.

Target shape:

```
┌─ Autonomous run ─────────── ✕ ┐
│ ● running · 4m 12s · $0.38    │
│ project: 2026-08-11-add-fooo  │
├───────────────────────────────┤
│ 12:44:02 claude started       │
│ 12:44:19 Read src/lib/pace.ts │
│ 12:44:31 Edit usagePace.ts    │
│ 12:45:02 ⏺ Running just check │
│ 12:46:10 ✓ done (8 turns)     │
│                        ▼ live │
├───────────────────────────────┤
│ [ Cancel run ]   [ Raw JSON ] │
└───────────────────────────────┘
```

---

## 1. The constraint that shapes everything

MV3 has no filesystem API, so the extension **cannot read
`autonomous-work.log`**. The only channel from disk to the browser is the
native-messaging host — and today that host is one-shot:
`chrome.runtime.sendNativeMessage` spawns a process, gets one reply, and Chrome
tears it down.

Streaming therefore needs `chrome.runtime.connectNative`: a **persistent port**
that keeps a host process alive for as long as the page holds it open. The host
tails the run's event file and pushes each event up the port.

Chrome spawns a **separate host process per connection**, so the streaming
connection is entirely independent of the one-shot snapshot writes that
`exportUsageSnapshot` makes every five minutes. They cannot interfere.

### Where the port is opened

The run-log **page** opens the port, not the service worker.

This is a deliberate exception to "the popup asks the service worker rather than
doing it itself". That rule exists so network, storage and badge updates happen
in one place; a live stream is none of those. And an MV3 service worker is
killed when idle — keeping one alive for an hour of sporadic events is exactly
the fight `chrome.alarms` exists to avoid. A real document has an ordinary
lifetime that matches the stream's exactly: the window is open, the port is
open; the window closes, the host exits.

**The architecture rule still holds:** `chrome.*` stays out of the React
components. The port lives in `src/extension/autonomousRunStream.ts`, and only
`src/runLog/RunLogRoot.tsx` touches it — the same relationship `PopupRoot.tsx`
has with `extension/`.

---

## 2. A run-scoped event stream

Today's two log files are both wrong for this:

- `autonomous-work.log` is prose meant for humans. Parsing it back into
  structure would mean scraping our own formatting, and every log-wording change
  would silently break the UI.
- `autonomous-work.jsonl` is the raw claude events, appended forever with no run
  boundary and no record of _which_ prompt, repo or working directory the run
  used — the header needs all three.

So `run-autonomous-work.py` gains a third file, **`autonomous-run-events.jsonl`**,
which is the one authoritative stream the viewer consumes. It carries our own
envelope events around the claude events, verbatim:

```jsonc
// run start — everything the header needs, known before claude is invoked
{"type":"runStarted","runId":"2026-08-11T12:44:02.113Z","at":"…","forced":true,
 "workingDirectory":"/Users/…/2026-08-11-add-foo","projectName":"2026-08-11-add-foo",
 "isNewProject":true,"prompt":"Add a …","model":"claude-opus-5"}

// each stream-json event from `claude`, unchanged, wrapped so the run is known
{"type":"claudeEvent","runId":"…","at":"…","event":{ …verbatim stream-json… }}

// a line claude emitted that was not JSON (merged stderr)
{"type":"claudeOutput","runId":"…","at":"…","text":"…"}

// terminal — one per run, always written, including on the skip paths
{"type":"runFinished","runId":"…","at":"…","outcome":"completed|error|timeout|cancelled",
 "exitCode":0,"queueStatus":"completed"}

// the pace gate declined to run, or the queue was empty
{"type":"runSkipped","runId":"…","at":"…","reason":"onPace|emptyQueue|noSnapshot","detail":"…"}
```

`runId` is the run's start timestamp — unique enough for a job that cannot run
concurrently with itself, and sortable, which the tail logic needs.

The file is **truncated to the last few runs on each start** (keep the most
recent ~5 run boundaries), so it stays bounded without a separate rotation job.
The existing `.log` and `.jsonl` files keep their current behaviour untouched;
`just autonomous-log` must go on working exactly as it does.

**Why a new file rather than extending the jsonl:** the jsonl is documented as
"every raw stream-json event", and things outside this repo may already tail it.
Mixing envelopes in would change that contract for no gain.

---

## 3. Host protocol additions

`usage-host.py` gains two message types alongside `snapshot`,
`runAutonomousWork` and `setAutonomousWorkSettings`:

| Incoming               | Behaviour                                                    |
| ---------------------- | ------------------------------------------------------------ |
| `tailAutonomousRun`    | Reply `{ok:true}`, then stream events until the port closes  |
| `cancelAutonomousWork` | Spawn `cancel-autonomous-work.py`, reply with what it killed |

Pushed messages (host → extension, unsolicited):

```jsonc
{"type":"runEvents","events":[ …envelope events… ]}   // batched, newest last
{"type":"tailError","error":"…"}                       // file unreadable, etc.
```

**Backfill on connect.** The tail begins by replaying the events of the most
recent run in the file — not just new lines. Two reasons: the window is created
at almost the same moment as the run, and losing the first seconds of a run to a
race would be a confusing bug to chase; and it is what makes "open the view to
see what the nightly job did" work at all.

**Tailing implementation.** A daemon thread polls the file for growth (~250 ms)
rather than using any filesystem-watch API — stdlib-only and 3.9-compatible is
non-negotiable for this host, and `kqueue` plumbing would be far more code than
a stat loop for something this small. It must handle the file being **truncated
underneath it** (a new run starting) by detecting a shrink and re-reading from
the top.

**stdout is shared state now.** Until now only the main thread wrote replies. A
tail thread writing concurrently would interleave two length-prefixed frames and
corrupt the stream — indistinguishable, from the extension's side, from the host
crashing. `write_message` gets a module-level `threading.Lock`.

The main loop still blocks on `read_message()`; that is correct — it is how the
host learns the port closed (EOF → exit, which ends the tail thread with it).

---

## 4. Files

### New

| File                                   | Contents                                                                |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `run-log.html`                         | Second Vite entry point, sibling of `popup.html`                        |
| `src/runLog/main.tsx`                  | Mounts `RunLogRoot`                                                     |
| `src/runLog/RunLogRoot.tsx`            | The only run-log component that talks to `extension/`                   |
| `src/runLog/previewMain.tsx`           | `just dev` harness driving the UI from fixture events, no Chrome needed |
| `src/extension/autonomousRunStream.ts` | `connectNative`, port lifecycle, reconnect; cancel request              |
| `src/extension/runLogWindow.ts`        | `chrome.windows.create` / focus-if-already-open                         |
| `src/lib/autonomousRunEvents.ts`       | Envelope types + defensive parsing of one event                         |
| `src/lib/autonomousRunViewModel.ts`    | Events → `{ status, elapsed, cost, turns, project, timeline[] }`        |
| `src/components/RunLogView.tsx`        | Pure presentation: header, timeline, footer buttons                     |
| `src/components/RunTimelineEntry.tsx`  | One line: time, icon, label, detail                                     |

### Changed

| File                                     | Change                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `.claude-scripts/run-autonomous-work.py` | Write `autonomous-run-events.jsonl`; truncate on start; envelope events |
| `.claude-scripts/usage-host.py`          | `tailAutonomousRun`, `cancelAutonomousWork`, stdout lock, tail thread   |
| `.claude-scripts/test-usage-host.py`     | Exercise the tail and cancel paths against a synthetic events file      |
| `src/extension/messages.ts`              | `OPEN_RUN_LOG` message; response type                                   |
| `src/extension/serviceWorker.ts`         | Handle `OPEN_RUN_LOG` (opening the window is a `chrome.windows` call)   |
| `src/popup/PopupRoot.tsx`                | Run now → also open the window; add a "View last run" affordance        |
| `src/components/SettingsPage.tsx`        | The "View last run" button next to "Run now"                            |
| `vite.config.ts`                         | Add the `runLog` input                                                  |
| `Justfile`                               | `just run-log-preview` if the preview needs its own recipe              |
| `CLAUDE.md`                              | Document the third log file, the port, and the window                   |

No new manifest permissions. `nativeMessaging` is already granted, and
`chrome.windows.create` needs none (only reading tab URLs would).

---

## 5. The view model

Derived in `lib/`, per the architecture rule, from the event list alone:

- **status** — `idle` (no run in file) / `running` (a `runStarted` with no
  terminal event) / `completed` / `error` / `timeout` / `cancelled` / `skipped`
- **elapsed** — from `runStarted.at` to now while running; to the terminal event
  once finished. The component ticks a clock; the maths stays in `lib/`.
- **cost / turns / model** — from the claude `result` event, and `model` from
  `system`/`init`, falling back to the `runStarted` envelope.
- **project** — `projectName` from the envelope; the working directory as the
  title attribute.
- **timeline** — one entry per meaningful event. Reuse the shape of
  `summarise_stream_event` in `run-autonomous-work.py`, but **implemented
  independently in TypeScript** rather than shared: the Python version's job is
  a bounded single-line log, this one's is a UI with icons, per-entry expansion
  and tool-specific formatting. Trying to serve both from one formatter would
  make each worse.

Assistant text blocks, tool calls (name + the one field that says what it is
doing), the init line and the result line all become entries. Everything else is
kept in the raw stream but not shown.

---

## 6. Interaction details

- **Single window.** Pressing Run now twice must focus the existing window
  rather than opening a second one. Track the created window ID; if
  `chrome.windows.update` fails because it was closed, create a new one.
- **Auto-scroll that yields.** Stick to the bottom by default; stop as soon as
  the user scrolls up; a "▼ live" affordance returns to following. Nothing is
  more irritating in a log view than being yanked away mid-read.
- **Cancel** goes through the same port to `cancel-autonomous-work.py` and
  reports what it actually killed. It asks for confirmation first — it is
  destructive and losing an hour of work to a misclick is a poor trade. The run
  ends as `runFinished` with `outcome: "cancelled"`, so the view reflects it via
  the ordinary stream rather than optimistically.
- **Host not installed.** The port fails to connect. Say so plainly, naming
  `just install-usage-host`, exactly as the snapshot exporter's message does —
  this is an ordinary state, not an error.
- **Disconnection.** If the host dies mid-run, show a "reconnecting" state and
  retry with a short backoff. A run outliving its viewer is normal and fine.

---

## 7. Phases

1. **Event stream in Python.** `run-autonomous-work.py` writes
   `autonomous-run-events.jsonl` with truncation and all envelope types. Verify
   with `just autonomous-dry-run` and a real forced run; confirm `.log` and
   `.jsonl` are byte-for-byte unchanged in behaviour.
2. **Host protocol.** `tailAutonomousRun` with backfill, the stdout lock, the
   tail thread, `cancelAutonomousWork`. Extend `test-usage-host.py` to drive
   both against a synthetic file — no Chrome, no billable run.
3. **`lib/` types and view model**, built against fixture events captured from
   a real run. Pure TypeScript, independently checkable.
4. **The page.** `run-log.html`, the Vite input, `RunLogView`, and
   `previewMain.tsx` so the whole UI can be developed in `just dev` against
   fixtures with no extension loaded.
5. **Wiring.** `autonomousRunStream.ts`, `RunLogRoot`, `runLogWindow.ts`, the
   `OPEN_RUN_LOG` message, the popup buttons.
6. **End to end** — `just build`, reload the unpacked extension, press Run now,
   watch a real run; press Cancel; close and reopen to confirm the last run
   replays.
7. **Docs.** `CLAUDE.md` gains the third log file, the persistent port and its
   rationale, and the window. `just check` passes.

---

## 8. Risks and things to watch

- **Extension ID.** Nothing here changes the load path, so the host manifest's
  `allowed_origins` stays valid. Worth remembering if `dist/` ever moves.
- **A second host process per open window** is by design, but it does mean an
  idle window holds a Python process open. It exits with the window; a stat loop
  at 250 ms is negligible. Still, do not auto-open the window.
- **Truncating the events file while the viewer tails it** is the one genuine
  race in the design. Handled by shrink detection, and worth an explicit test.
- **Backfill size.** Replaying a long run's events on connect could be a large
  first message. Batch the backfill across several messages and cap the replay
  at the most recent run.
- **`claude` stream-json schema is not ours.** Parse defensively and drop
  unrecognised events rather than throwing — the same posture
  `normaliseUsageResponse` takes toward the usage API.

## 9. Out of scope

- Auto-opening for nightly runs (decided against; revisit if it proves useful).
- Editing `prompts.txt` from the UI.
- History across many past runs — the view shows the current or most recent run
  only.
