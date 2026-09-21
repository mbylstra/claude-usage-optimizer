# Plan: Choose Claude or Codex for autonomous work

## Goal

Let the user choose whether scheduled and manually-triggered autonomous work is
performed by Claude Code or Codex. Keep the existing queue, pace gate, launchd
scheduling, cancellation, timeout, summaries, and live-run window, but make the
CLI invocation and event interpretation provider-specific.

Codex runs non-interactively with the Sol model, may edit and run commands in
the selected repository without waiting for approval, and remains confined to
the repository/workspace sandbox. The generated daily summary states which
provider performed the work.

## Decisions

| Question | Decision |
| --- | --- |
| Setting shape | Add `autonomousWork.agent: 'claude' | 'codex'`, defaulting to `claude` so existing installs do not change behaviour. |
| Settings UI | Add a two-state switch labelled **Use Codex for autonomous work** near the top of the Autonomous work card. Off = Claude, on = Codex. |
| Scope of the switch | It affects both nightly/resume runs and the popup's manual autonomous-work actions; they all enter the same scheduler. The setting is read once when the scheduler process starts, so a settings change affects the next run, not one already in flight. |
| Codex invocation | Use `codex exec --json --model gpt-5.6-sol --sandbox workspace-write --ask-for-approval never <prompt>`. `codex exec` is the supported non-interactive/scheduled mode, and `--json` supplies a JSONL progress stream. |
| Safety posture | Use `workspace-write`, never `danger-full-access`/`--yolo`. `--ask-for-approval never` prevents a headless run from blocking; actions outside the workspace or otherwise denied by the sandbox fail instead of escalating. Keep the existing mandatory prompt suffix about branching, ambiguity, and reviewing work. |
| Model settings | When Codex is selected, ignore both the global **Model for autonomous runs** / **Effort** settings and Jira per-card model/effort overrides. Always pass `gpt-5.6-sol`. Keep those controls visible but group and label them as Claude-only, so switching back preserves the user's choices. |
| Authentication | Reuse the Codex CLI's existing local login. Do not copy tokens or add API-key settings. A missing CLI or unusable login is an ordinary failed attempt with a useful message. |
| Prompt transport | Pass the prompt as a subprocess argument, matching the current Claude path and avoiding an inherited interactive stdin. |
| Session persistence | Do not pass `--ephemeral`; preserve Codex's normal local session record for diagnosis. Capture `thread_id` from `thread.started` for logs/viewer metadata, but do not add resume support in this change. |
| Scheduling/pace | The agent switch changes the executor only. The existing schedule, queue and pace gate remain intact; changing the source/meaning of the pace signal is separate work. Claude-specific 5-hour-limit detection and automatic reset resumes apply only to Claude; Codex failures do not try to parse Claude reset wording. **Superseded** — a night scheduled for Codex was found checking Claude's weekly pace regardless, which could burn an exhausted Codex week while Claude still had headroom, or sit idle on Claude's account while Codex had plenty left. The pace gate now reads whichever agent's own figure is configured; see `backend/CLAUDE.md`'s "The pace gate reads whichever agent's own figure…" note for the mechanism. |
| Platform | Implement and test the launchd/macOS runner only. No Windows scheduler, process, PATH, or sandbox support. |

The Codex command and event shapes above follow the official OpenAI documentation
for [non-interactive Codex runs](https://developers.openai.com/es-419/docs/non-interactive-mode)
and the [`gpt-5.6-sol` model](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
The non-interactive guide explicitly recommends `codex exec`, JSONL via `--json`,
and `workspace-write` for automation; it also marks the older `--full-auto` flag
as deprecated.

---

## 1. Add and mirror the agent setting

### Extension settings

Update `chrome-extension/lib/settingsTypes.ts`:

- Add `export type AutonomousWorkAgent = 'claude' | 'codex'`.
- Add `agent` to `AutonomousWorkSettings` and
  `DEFAULT_AUTONOMOUS_WORK_AGENT = 'claude'`.
- Extend `normaliseExtensionSettings` to accept only the two known values and
  fall back to Claude for missing or malformed storage. This is the migration
  path for every existing install.
- Keep `model` and `effort` unchanged; they remain Claude settings rather than
  trying to make one field describe incompatible providers.

`syncAutonomousWorkSettings` already spreads every field except `scheduleTime`,
so the new field should reach native messaging without another hand-maintained
mapping. Add a contract test so a future refactor cannot silently omit it.

### Backend settings

Update `backend/autonomous_work_settings.py`:

- Add constants for `claude`, `codex`, and the default.
- Add `agent` to `AutonomousWorkSettings`.
- Parse unknown/missing values as `claude` and include `agent` in
  `write_settings`.
- Show the chosen agent in the settings/install diagnostic output.
- Leave launchd plist rendering unchanged: both choices invoke the same Python
  scheduler, which chooses the CLI at runtime.

Update `backend/tests/test_autonomous_work_settings.py` for valid values,
default/migration behaviour, malformed values, round-trip persistence, and the
unchanged plist command.

---

## 2. Add the switch to Settings

Update `chrome-extension/components/SettingsPage.tsx`:

- Add **Use Codex for autonomous work** above scheduling/model controls.
- Explain that Codex uses Sol for now and that switching does not affect the
  separate Codex-usage display preference.
- Change the existing model and effort labels to **Claude model for autonomous
  runs** and **Claude effort for autonomous runs**.
- Keep both controls visible but disabled while Codex is selected, with helper
  text saying Codex is currently pinned to Sol. This makes the ignored setting
  explicit and preserves the Claude selection for a later switch back.
- Update the Autonomous work introduction to name the selected agent.

Update popup/Settings component tests or preview fixtures to cover both switch
states, the emitted settings object, and disabled Claude-only controls.

---

## 3. Introduce a provider boundary in the runner

Refactor `backend/run-autonomous-work.py` around the parts that actually differ
between CLIs. Do not duplicate the outer session loop: pace checks, queue
selection, working-directory preparation, git checkpoints, watchdog,
cancellation, queue updates, summary writing, and launchd resume handling stay
shared.

Add a small executor abstraction (classes or a provider-tagged set of helper
functions) with these responsibilities:

1. Build the command for a queue entry.
2. Identify the display provider/model written to events and summaries.
3. Consume one JSONL event and update a common output accumulator.
4. Convert provider events to the normalized run-event envelope used by the
   live view.
5. Decide whether a provider-specific subscription limit occurred.

Rename Claude-specific shared names where they become inaccurate, for example
`run_claude` to `run_prompt`, `ClaudeOutputCollector` to a provider-neutral
collector interface, and `CLAUDE_MAX_PROMPT_DURATION_SECONDS` to an autonomous
prompt timeout. Keep genuinely Claude-only helpers named Claude.

### Claude executor

Move the current command construction, stream collector, background-task
timeout marker, session-limit parsing, model/effort resolution, and resume
semantics behind the Claude executor without changing behaviour.

### Codex executor

Build this argument vector without a shell:

```text
codex exec
  --json
  --model gpt-5.6-sol
  --sandbox workspace-write
  --ask-for-approval never
  <prompt>
```

Run it with the queued repository as `cwd`, `stdin=DEVNULL`, and the same
line-buffered `stdout` pipe, max-duration watchdog, SIGTERM cancellation path,
and macOS `caffeinate` companion used for Claude. Merge stderr into stdout as
today, tolerating non-JSON diagnostic lines while retaining them in raw logs.

Do not use `shell=True`, `danger-full-access`, `--yolo`, or deprecated
`--full-auto`. Extend the launchd/native-host PATH comments and installation
checks to cover both `claude` and `codex` in the existing Homebrew/local-bin
locations.

Treat `FileNotFoundError` as a provider-specific actionable failure:
`` `codex` not found on PATH — install/login to Codex CLI and check the launchd
PATH setting ``.

---

## 4. Normalize Codex's JSONL stream

Official Codex JSONL includes `thread.started`, `turn.started`,
`item.started`, `item.completed`, `turn.completed`, `turn.failed`, and `error`.
Items may describe agent messages, command executions, file changes, MCP calls,
web searches, reasoning, or plan updates.

Add a `CodexOutputCollector` that defensively reads only fields it recognizes:

- `thread.started.thread_id` -> session/thread identifier.
- completed `agent_message` item text -> latest/final result text.
- `turn.completed.usage` -> token metadata if useful for diagnostics; do not
  force it into Claude's turn/cost fields.
- `turn.failed` or `error` -> failure detail for the summary.
- unknown event/item types -> retain in raw JSONL and ignore for derivation.

Exit code remains authoritative for Codex success unless a structured
`turn.failed`/`error` event makes a nominal zero exit demonstrably unsuccessful.
Do not reuse Claude string matching for Codex rate limits or fabricate Claude's
`sessionLimit` outcome/reset schedule.

Keep `backend/autonomous-work.jsonl` as the raw mixed-provider diagnostic log.
Every JSON line is stored verbatim; plain stderr remains readable prose. The
run-scoped stream should use neutral envelopes:

```jsonc
{"type":"runStarted", "agent":"codex", "model":"gpt-5.6-sol", ...}
{"type":"agentEvent", "agent":"codex", "event":{...}, ...}
{"type":"agentOutput", "agent":"codex", "text":"...", ...}
```

For a compatibility-friendly rollout, make the TypeScript parser accept both
the old `claudeEvent`/`claudeOutput` envelopes and the new neutral forms. New
runs from either provider should emit neutral forms; old retained run history
must continue to render.

---

## 5. Make the live run view provider-aware

Update:

- `chrome-extension/lib/autonomousRunEvents.ts`
- `chrome-extension/lib/autonomousRunViewModel.ts`
- `chrome-extension/components/RunLogView.tsx`
- run-log fixtures/tests

Add `agent` to `runStarted` and expose it on the view model. The header should
say **Claude** or **Codex** alongside the model rather than implying every run
is Claude.

Retain the existing Claude timeline adapter. Add a Codex adapter that maps, at
minimum:

- `thread.started` -> Codex started / thread id.
- command execution items -> command timeline entries and failure state.
- file-change items -> edited-file entries.
- MCP/web-search/plan items -> readable tool/activity entries.
- agent-message items -> assistant text.
- `turn.completed`, `turn.failed`, and `error` -> terminal/result detail.

Keep unknown events available in Raw JSON without letting them blank the view.
Cancellation continues to signal the outer Python runner, so it works for both
child CLIs without a new native-message type.

---

## 6. Identify the provider in daily summaries

Update `backend/autonomous_work_summary.py` so the provider cannot be lost
between execution and rendering:

- Add `agent` and `model` to `PromptAttempt` (preferred over only storing them
  on `SessionSummary`, because each attempt then remains self-describing).
- Render a metadata line under every attempt heading, for example
  `**Agent:** Codex (gpt-5.6-sol)` or
  `**Agent:** Claude (claude-opus-5)`.
- Optionally add the session's agent to the session heading when every attempt
  shares it, but keep the per-attempt line as the durable requirement.
- Continue rendering cost/turn counts only when the provider supplies them;
  Codex token usage must not be mislabeled as Claude turns or dollar cost.

Also include `agent` in `runStarted`, readable logs, dry-run output, missing-CLI
errors, and Jira pickup/result comments where those comments currently name
Claude or provide a Claude-only resume command. For Codex, record the
`thread_id` as diagnostic information without promising an interactive resume
workflow in this scope.

Update `backend/tests/test_autonomous_work_summary.py` to assert both provider
labels, the Sol model label, and sensible omission of unavailable metrics.

---

## 7. Preserve queue and failure semantics

The provider choice must not alter these contracts:

- A zero/successful run completes the queue item unless git inspection finds
  work deliberately left on an unmerged branch.
- A non-zero/failed run marks it `error` and retains the last useful provider
  message.
- A timeout kills the child and marks the prompt timed out.
- A user cancellation leaves the prompt `todo` and writes a cancelled summary.
- A missing CLI produces a normal failed attempt rather than crashing the
  scheduler before it can write events/summary.
- `--force` still runs one item; scheduled work still loops while the shared
  pace gate permits it.
- Claude's detected 5-hour limit still leaves the item `todo` and may schedule
  one resume. Codex never enters this Claude-specific path.

Ensure the process-kill helper/cancellation script continues to terminate the
outer runner and its active child regardless of whether that child is named
`claude` or `codex`; remove any executable-name assumption found during
implementation.

---

## 8. Tests and verification

### Backend unit tests

Extend `backend/tests/test_run_autonomous_work.py` with mocked `Popen` streams:

- Claude remains the default and retains its exact arguments/behaviour.
- Codex command uses `exec`, `--json`, `gpt-5.6-sol`, `workspace-write`, and
  approval policy `never`; it never includes `danger-full-access`, `--yolo`, or
  Claude model/effort values.
- Global and Jira per-card Claude model/effort settings are ignored for Codex.
- Codex agent messages become result text; thread id and activity events are
  captured; unknown/malformed JSONL is harmless.
- Codex success, non-zero exit, structured failure, timeout, cancellation, and
  missing executable produce the established queue outcomes.
- Claude rate-limit resume behaviour is unchanged and is not applied to Codex.
- dry-run output names the selected provider and resolved model.

Add/extend summary, settings, event-parser, view-model, and component tests for
the cases described above. Keep legacy event fixtures to prove retained Claude
history still opens.

### macOS integration checks

1. Run the complete backend and extension checks (`just check`).
2. With a disposable git repository and test queue, run `--dry-run` for both
   agents and inspect the resolved command/provider/model.
3. After `codex login`, run one harmless forced Codex prompt that creates a
   small file. Confirm it edits within the repository without an approval
   prompt and cannot escape the workspace sandbox.
4. Watch the live-run window and confirm Codex commands, file changes, final
   message, cancellation, and raw JSON are usable.
5. Confirm the queue transition, raw/run-scoped logs, and daily summary all
   name Codex and `gpt-5.6-sol`.
6. Switch back to Claude and run the existing smoke path to ensure model,
   effort, session-limit resume, and legacy live events still work.
7. Trigger through the installed launchd job, not only a shell, to verify PATH
   and reuse of the CLI's stored authentication in the actual scheduled
   environment.

---

## Files expected to change

| File | Change |
| --- | --- |
| `chrome-extension/lib/settingsTypes.ts` | Agent type/default/normalisation. |
| `chrome-extension/components/SettingsPage.tsx` | Codex switch and Claude-only model/effort state. |
| `chrome-extension/extension/usageSnapshotExporter.ts` | Contract coverage/documentation for mirroring the new field. |
| `backend/autonomous_work_settings.py` | Parse, persist, and report the selected agent. |
| `backend/run-autonomous-work.py` | Shared runner plus Claude/Codex executors and event collectors. |
| `backend/autonomous_work_summary.py` | Provider/model fields and rendering. |
| `backend/cancel-autonomous-work.py` | Only if current child discovery assumes the executable is Claude. |
| `backend/usage-host.py` | PATH/install diagnostics or provider-neutral run-event wording. |
| `chrome-extension/lib/autonomousRunEvents.ts` | Neutral envelopes plus legacy parsing. |
| `chrome-extension/lib/autonomousRunViewModel.ts` | Provider-aware Claude/Codex timeline adapters. |
| `chrome-extension/components/RunLogView.tsx` | Provider/model display. |
| backend and extension tests/fixtures | Settings, commands, streams, summaries, and compatibility coverage. |
| `README.md`, `CLAUDE.md`, `backend/CLAUDE.md`, `chrome-extension/CLAUDE.md` | Setup, login, safety mode, Sol pin, logs, and architecture documentation where applicable. |

No launchd plist split is needed, no new Chrome permission is needed, and no
Windows runner work is included.
