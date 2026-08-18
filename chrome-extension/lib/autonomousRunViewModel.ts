import {
  isRunBoundaryEvent,
  selectMostRecentRun,
  type AutonomousRunEvent,
  type ClaudeEventEnvelope,
  type RunOutcome,
} from './autonomousRunEvents';

/**
 * Everything the run-log window paints, derived from the event list alone.
 *
 * The timeline deliberately duplicates what `summarise_stream_event` does in
 * `run-autonomous-work.py` rather than sharing it. That function's job is one
 * bounded line in a text log; this one's is a UI with icons, tones and
 * tool-specific formatting. One formatter serving both would be worse at each.
 */

export type AutonomousRunStatus =
  'idle' | 'running' | 'completed' | 'error' | 'timeout' | 'cancelled' | 'sessionLimit' | 'skipped';

export type RunTimelineKind =
  | 'runStarted'
  | 'claudeStarted'
  | 'assistant'
  | 'tool'
  | 'notice'
  | 'output'
  | 'result'
  | 'finished'
  | 'skipped';

export type RunTimelineTone = 'default' | 'muted' | 'success' | 'error';

export interface RunTimelineEntry {
  /** Stable across rebuilds because the event list only ever grows. */
  id: string;
  at: string;
  kind: RunTimelineKind;
  label: string;
  detail: string | null;
  tone: RunTimelineTone;
}

export interface AutonomousRunViewModel {
  status: AutonomousRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Wall-clock time the run has taken so far, or took in total once finished. */
  elapsedMs: number | null;
  projectName: string | null;
  workingDirectory: string | null;
  prompt: string | null;
  isNewProject: boolean;
  /** True when someone pressed Run now rather than the nightly job firing. */
  forced: boolean;
  model: string | null;
  sessionId: string | null;
  costUsd: number | null;
  turns: number | null;
  exitCode: number | null;
  /** Why the run did not happen, when the last thing in the file was a skip. */
  skipDetail: string | null;
  timeline: RunTimelineEntry[];
}

export const EMPTY_RUN_VIEW_MODEL: AutonomousRunViewModel = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  elapsedMs: null,
  projectName: null,
  workingDirectory: null,
  prompt: null,
  isNewProject: false,
  forced: false,
  model: null,
  sessionId: null,
  costUsd: null,
  turns: null,
  exitCode: null,
  skipDetail: null,
  timeline: [],
};

/** Long enough to say what happened, short enough that a row stays a row. */
const MAX_ENTRY_LENGTH = 400;

function collapseWhitespace(text: string, limit = MAX_ENTRY_LENGTH): string {
  const collapsed = text
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ');
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumberField(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The one field of a tool call that says what it is actually doing.
 *
 * Ordered per tool rather than generically, because the generic answer is often
 * the wrong field: a `Bash` call's `description` is a summary, its `command` is
 * the thing you want to read in a log.
 */
export function describeToolInput(toolName: string, toolInput: unknown): string {
  const input = readRecord(toolInput);
  if (input === null) return '';

  const preferredFieldsByTool: Record<string, string[]> = {
    Bash: ['command', 'description'],
    Read: ['file_path'],
    Write: ['file_path'],
    Edit: ['file_path'],
    NotebookEdit: ['notebook_path', 'file_path'],
    Glob: ['pattern'],
    Grep: ['pattern'],
    WebFetch: ['url', 'prompt'],
    WebSearch: ['query'],
    Task: ['description', 'prompt'],
    Agent: ['description', 'prompt'],
    Skill: ['skill', 'args'],
  };

  const candidateFields = preferredFieldsByTool[toolName] ?? [
    'command',
    'file_path',
    'pattern',
    'path',
    'url',
    'query',
    'description',
  ];

  for (const field of candidateFields) {
    const value = readStringField(input, field);
    if (value !== null) return collapseWhitespace(value);
  }

  // Nothing recognisable — the field names at least say what kind of call it was.
  return Object.keys(input).slice(0, 3).sort().join(', ');
}

function describeResultEvent(event: Record<string, unknown>): string {
  const turns = readNumberField(event, 'num_turns');
  const cost = readNumberField(event, 'total_cost_usd');
  const durationMs = readNumberField(event, 'duration_ms');

  const parts: string[] = [];
  if (turns !== null) parts.push(`${turns} turns`);
  if (durationMs !== null) parts.push(`${Math.round(durationMs / 1000)}s`);
  if (cost !== null) parts.push(`$${cost.toFixed(2)}`);
  return parts.join(', ');
}

interface TimelineBuilderState {
  entries: RunTimelineEntry[];
  /** tool_use id → tool name, so a failed tool_result can name what failed. */
  toolNamesById: Map<string, string>;
}

function addEntry(
  state: TimelineBuilderState,
  id: string,
  at: string,
  kind: RunTimelineKind,
  label: string,
  detail: string | null,
  tone: RunTimelineTone,
): void {
  if (label === '') return;
  state.entries.push({ id, at, kind, label, detail, tone });
}

function addAssistantEntries(
  state: TimelineBuilderState,
  envelope: ClaudeEventEnvelope,
  eventId: string,
): void {
  const message = readRecord(envelope.event.message);
  const content = message === null ? null : message.content;
  if (!Array.isArray(content)) return;

  content.forEach((rawBlock, blockIndex) => {
    const block = readRecord(rawBlock);
    if (block === null) return;
    const id = `${eventId}:${blockIndex}`;

    if (block.type === 'text') {
      const text = readStringField(block, 'text');
      if (text === null) return;
      addEntry(state, id, envelope.at, 'assistant', collapseWhitespace(text), null, 'default');
      return;
    }

    if (block.type === 'tool_use') {
      const toolName = readStringField(block, 'name') ?? 'tool';
      const toolUseId = readStringField(block, 'id');
      if (toolUseId !== null) state.toolNamesById.set(toolUseId, toolName);
      addEntry(
        state,
        id,
        envelope.at,
        'tool',
        toolName,
        describeToolInput(toolName, block.input) || null,
        'default',
      );
    }
    // Thinking blocks and everything else are kept in the raw stream but not
    // shown — a timeline of them says nothing about what the run is doing.
  });
}

/** Only failures. A successful tool result is already implied by its call. */
function addToolFailureEntries(
  state: TimelineBuilderState,
  envelope: ClaudeEventEnvelope,
  eventId: string,
): void {
  const message = readRecord(envelope.event.message);
  const content = message === null ? null : message.content;
  if (!Array.isArray(content)) return;

  content.forEach((rawBlock, blockIndex) => {
    const block = readRecord(rawBlock);
    if (block === null || block.type !== 'tool_result' || block.is_error !== true) return;

    const toolUseId = readStringField(block, 'tool_use_id');
    const toolName = toolUseId === null ? null : (state.toolNamesById.get(toolUseId) ?? null);
    const rawDetail = block.content;
    const detail = typeof rawDetail === 'string' ? collapseWhitespace(rawDetail) : null;

    addEntry(
      state,
      `${eventId}:${blockIndex}`,
      envelope.at,
      'notice',
      `${toolName ?? 'Tool'} failed`,
      detail,
      'error',
    );
  });
}

function addClaudeEventEntries(
  state: TimelineBuilderState,
  envelope: ClaudeEventEnvelope,
  eventId: string,
): void {
  const event = envelope.event;
  const eventType = typeof event.type === 'string' ? event.type : '';
  const subtype = typeof event.subtype === 'string' ? event.subtype : '';

  if (eventType === 'system' && subtype === 'init') {
    const model = readStringField(event, 'model');
    const sessionId = readStringField(event, 'session_id');
    const details = [model, sessionId === null ? null : `session ${sessionId.slice(0, 8)}`]
      .filter((part): part is string => part !== null)
      .join(' · ');
    addEntry(
      state,
      eventId,
      envelope.at,
      'claudeStarted',
      'claude started',
      details || null,
      'muted',
    );
    return;
  }

  if (eventType === 'system' && subtype === 'permission_denied') {
    addEntry(
      state,
      eventId,
      envelope.at,
      'notice',
      `Permission denied: ${readStringField(event, 'tool_name') ?? 'tool'}`,
      readStringField(event, 'message'),
      'error',
    );
    return;
  }

  if (eventType === 'system' && subtype === 'api_retry') {
    // Worth a line: it is the difference between a stalled run and a slow one.
    const attempt = readNumberField(event, 'attempt');
    addEntry(
      state,
      eventId,
      envelope.at,
      'notice',
      attempt === null ? 'Retrying the API call' : `Retrying the API call (attempt ${attempt})`,
      readStringField(event, 'error'),
      'muted',
    );
    return;
  }

  if (eventType === 'assistant') {
    addAssistantEntries(state, envelope, eventId);
    return;
  }

  if (eventType === 'user') {
    addToolFailureEntries(state, envelope, eventId);
    return;
  }

  if (eventType === 'result') {
    const isError = event.is_error === true;
    addEntry(
      state,
      eventId,
      envelope.at,
      'result',
      isError ? 'claude finished with an error' : 'claude finished',
      describeResultEvent(event) || null,
      isError ? 'error' : 'success',
    );
  }
}

const FINISHED_LABELS: Record<RunOutcome, string> = {
  completed: 'Run finished',
  error: 'Run failed',
  timeout: 'Run timed out and was killed',
  cancelled: 'Run cancelled',
  sessionLimit: 'Subscription limit reached — the prompt is still queued',
};

/**
 * Only a run that failed should read as one. A cancel and a subscription limit
 * both end a run without anything having gone wrong, and neither leaves the
 * queue entry marked as an error.
 */
const FINISHED_TONES: Record<RunOutcome, RunTimelineTone> = {
  completed: 'success',
  error: 'error',
  timeout: 'error',
  cancelled: 'muted',
  sessionLimit: 'muted',
};

const SKIP_LABELS = {
  onPace: 'Skipped — on pace',
  emptyQueue: 'Skipped — nothing queued',
  noSnapshot: 'Skipped — no usage snapshot',
} as const;

function buildTimeline(events: readonly AutonomousRunEvent[]): RunTimelineEntry[] {
  const state: TimelineBuilderState = { entries: [], toolNamesById: new Map() };

  events.forEach((event, eventIndex) => {
    const eventId = `${eventIndex}`;

    switch (event.type) {
      case 'runStarted':
        addEntry(
          state,
          eventId,
          event.at,
          'runStarted',
          event.forced ? 'Run started (triggered manually)' : 'Run started',
          event.workingDirectory || null,
          'muted',
        );
        break;

      case 'claudeEvent':
        addClaudeEventEntries(state, event, eventId);
        break;

      case 'claudeOutput':
        addEntry(state, eventId, event.at, 'output', collapseWhitespace(event.text), null, 'muted');
        break;

      case 'runFinished':
        addEntry(
          state,
          eventId,
          event.at,
          'finished',
          FINISHED_LABELS[event.outcome],
          event.queueStatus === null ? null : `queue entry marked ${event.queueStatus}`,
          FINISHED_TONES[event.outcome],
        );
        break;

      case 'runSkipped':
        addEntry(
          state,
          eventId,
          event.at,
          'skipped',
          SKIP_LABELS[event.reason],
          event.detail || null,
          'muted',
        );
        break;
    }
  });

  return state.entries;
}

function toTimestamp(isoMoment: string | null): number | null {
  if (isoMoment === null) return null;
  const parsed = Date.parse(isoMoment);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build the whole view from the events held so far.
 *
 * `now` is passed in rather than read, so the elapsed reading is a pure function
 * of its inputs and the component can decide how often to tick.
 */
export function buildAutonomousRunViewModel(
  events: readonly AutonomousRunEvent[],
  now: Date,
): AutonomousRunViewModel {
  const runEvents = selectMostRecentRun(events);
  const boundary = runEvents.find(isRunBoundaryEvent) ?? null;
  if (boundary === null) return EMPTY_RUN_VIEW_MODEL;

  const finished = runEvents.find((event) => event.type === 'runFinished') ?? null;
  const skipped = boundary.type === 'runSkipped' ? boundary : null;
  const started = boundary.type === 'runStarted' ? boundary : null;

  let status: AutonomousRunStatus = 'running';
  if (skipped !== null) status = 'skipped';
  else if (finished !== null) status = finished.outcome;

  const startedAt = boundary.at;
  const finishedAt = finished?.at ?? null;
  const startedTimestamp = toTimestamp(startedAt);
  const endTimestamp = toTimestamp(finishedAt) ?? now.getTime();
  const elapsedMs =
    startedTimestamp === null || status === 'skipped'
      ? null
      : Math.max(0, endTimestamp - startedTimestamp);

  // The `result` event is the authority on cost and turns; `system/init` is the
  // authority on which model actually ran, since the envelope only records what
  // the scheduler asked for.
  let costUsd: number | null = null;
  let turns: number | null = null;
  let sessionId: string | null = null;
  let model: string | null = started?.model ?? null;

  for (const event of runEvents) {
    if (event.type !== 'claudeEvent') continue;
    const claudeEvent = event.event;

    if (claudeEvent.type === 'system' && claudeEvent.subtype === 'init') {
      model = readStringField(claudeEvent, 'model') ?? model;
      sessionId = readStringField(claudeEvent, 'session_id') ?? sessionId;
    }

    if (claudeEvent.type === 'result') {
      costUsd = readNumberField(claudeEvent, 'total_cost_usd') ?? costUsd;
      turns = readNumberField(claudeEvent, 'num_turns') ?? turns;
      sessionId = readStringField(claudeEvent, 'session_id') ?? sessionId;
    }
  }

  return {
    status,
    startedAt,
    finishedAt,
    elapsedMs,
    projectName: started?.projectName ?? null,
    workingDirectory: started?.workingDirectory ?? null,
    prompt: started?.prompt ?? null,
    isNewProject: started?.isNewProject ?? false,
    forced: started?.forced ?? false,
    model,
    sessionId,
    costUsd,
    turns,
    exitCode: finished?.exitCode ?? null,
    skipDetail: skipped?.detail ?? null,
    timeline: buildTimeline(runEvents),
  };
}

export function describeRunStatus(status: AutonomousRunStatus): string {
  switch (status) {
    case 'idle':
      return 'no runs yet';
    case 'running':
      return 'running';
    case 'completed':
      return 'finished';
    case 'error':
      return 'failed';
    case 'timeout':
      return 'timed out';
    case 'cancelled':
      return 'cancelled';
    case 'sessionLimit':
      return 'stopped by the subscription limit';
    case 'skipped':
      return 'skipped';
  }
}

/** Whether a Cancel button has anything to act on. */
export function isRunInFlight(status: AutonomousRunStatus): boolean {
  return status === 'running';
}

export function formatRunCost(costUsd: number | null): string | null {
  return costUsd === null ? null : `$${costUsd.toFixed(2)}`;
}
