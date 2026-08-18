/**
 * The envelope events `run-autonomous-work.py` writes to
 * `autonomous-run-events.jsonl`, and defensive parsing of one of them.
 *
 * Two schemas meet here and neither is ours to change: our own envelope, which
 * is at least written by a file in this repository, and the `claude`
 * stream-json event it carries verbatim, which is not. So parsing takes the
 * posture `normaliseUsageResponse` takes toward the usage API — read what is
 * recognised, drop what is not, never throw. A viewer that goes blank because
 * one event grew a field would be worse than useless.
 */

/**
 * `sessionLimit` is not a failure: the subscription limit refused the prompt
 * before it did anything, and the scheduler leaves the queue entry `todo`.
 */
export type RunOutcome = 'completed' | 'error' | 'timeout' | 'cancelled' | 'sessionLimit';

export type RunSkipReason = 'onPace' | 'emptyQueue' | 'noSnapshot';

/** Everything the header needs, known before `claude` is invoked. */
export interface RunStartedEvent {
  type: 'runStarted';
  runId: string;
  at: string;
  /** True when a person pressed Run now, false for the nightly pace-gated job. */
  forced: boolean;
  workingDirectory: string;
  projectName: string;
  isNewProject: boolean;
  prompt: string;
  model: string;
}

/** One stream-json event, exactly as `claude` emitted it. */
export interface ClaudeEventEnvelope {
  type: 'claudeEvent';
  runId: string;
  at: string;
  event: Record<string, unknown>;
}

/** A line `claude` wrote that was not JSON — merged stderr, usually. */
export interface ClaudeOutputEvent {
  type: 'claudeOutput';
  runId: string;
  at: string;
  text: string;
}

export interface RunFinishedEvent {
  type: 'runFinished';
  runId: string;
  at: string;
  outcome: RunOutcome;
  exitCode: number | null;
  queueStatus: string | null;
}

/** The pace gate declined to run, or there was nothing queued. */
export interface RunSkippedEvent {
  type: 'runSkipped';
  runId: string;
  at: string;
  reason: RunSkipReason;
  detail: string;
}

export type AutonomousRunEvent =
  RunStartedEvent | ClaudeEventEnvelope | ClaudeOutputEvent | RunFinishedEvent | RunSkippedEvent;

/** The events that begin a run. The viewer shows the events after the last one. */
export type RunBoundaryEvent = RunStartedEvent | RunSkippedEvent;

const RUN_OUTCOMES: readonly string[] = [
  'completed',
  'error',
  'timeout',
  'cancelled',
  'sessionLimit',
];
const RUN_SKIP_REASONS: readonly string[] = ['onPace', 'emptyQueue', 'noSnapshot'];

function readString(source: Record<string, unknown>, field: string, fallback = ''): string {
  const value = source[field];
  return typeof value === 'string' ? value : fallback;
}

function readBoolean(source: Record<string, unknown>, field: string): boolean {
  return source[field] === true;
}

function readNumberOrNull(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One event from the stream, or null if it is not one we can use.
 *
 * `runId` and `at` are required of every envelope: without them an event cannot
 * be attributed to a run or placed on a timeline, which is all the viewer does
 * with it.
 */
export function parseAutonomousRunEvent(value: unknown): AutonomousRunEvent | null {
  if (typeof value !== 'object' || value === null) return null;

  const source = value as Record<string, unknown>;
  const eventType = source.type;
  const runId = readString(source, 'runId');
  const at = readString(source, 'at');
  if (typeof eventType !== 'string' || runId === '' || at === '') return null;

  switch (eventType) {
    case 'runStarted':
      return {
        type: 'runStarted',
        runId,
        at,
        forced: readBoolean(source, 'forced'),
        workingDirectory: readString(source, 'workingDirectory'),
        projectName: readString(source, 'projectName'),
        isNewProject: readBoolean(source, 'isNewProject'),
        prompt: readString(source, 'prompt'),
        model: readString(source, 'model'),
      };

    case 'claudeEvent': {
      const claudeEvent = source.event;
      if (typeof claudeEvent !== 'object' || claudeEvent === null) return null;
      return { type: 'claudeEvent', runId, at, event: claudeEvent as Record<string, unknown> };
    }

    case 'claudeOutput':
      return { type: 'claudeOutput', runId, at, text: readString(source, 'text') };

    case 'runFinished': {
      const outcome = readString(source, 'outcome');
      return {
        type: 'runFinished',
        runId,
        at,
        // An outcome we do not recognise still ended the run, and "error" is the
        // safer of the two things it could mean.
        outcome: (RUN_OUTCOMES.includes(outcome) ? outcome : 'error') as RunOutcome,
        exitCode: readNumberOrNull(source, 'exitCode'),
        queueStatus: typeof source.queueStatus === 'string' ? source.queueStatus : null,
      };
    }

    case 'runSkipped': {
      const reason = readString(source, 'reason');
      return {
        type: 'runSkipped',
        runId,
        at,
        reason: (RUN_SKIP_REASONS.includes(reason) ? reason : 'emptyQueue') as RunSkipReason,
        detail: readString(source, 'detail'),
      };
    }

    default:
      return null;
  }
}

export function parseAutonomousRunEvents(values: readonly unknown[]): AutonomousRunEvent[] {
  const events: AutonomousRunEvent[] = [];
  for (const value of values) {
    const event = parseAutonomousRunEvent(value);
    if (event !== null) events.push(event);
  }
  return events;
}

export function isRunBoundaryEvent(event: AutonomousRunEvent): event is RunBoundaryEvent {
  return event.type === 'runStarted' || event.type === 'runSkipped';
}

/**
 * The events belonging to the newest run in the list.
 *
 * The host already backfills only one run, but it keeps streaming afterwards —
 * so a window opened just before a run starts will hold the previous run's
 * events and then be handed the new one. Slicing here is what makes that switch
 * happen by itself.
 */
export function selectMostRecentRun(events: readonly AutonomousRunEvent[]): AutonomousRunEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && isRunBoundaryEvent(event)) return events.slice(index);
  }
  return [...events];
}
