import type { AutonomousRunEvent } from '@/lib/autonomousRunEvents';

/**
 * A recorded-looking run, for developing the window without an extension, a
 * native host, or a billable Claude session.
 *
 * Shapes are copied from real `autonomous-run-events.jsonl` output rather than
 * invented, so what the preview exercises is what the viewer will actually meet.
 */

/**
 * The fixture run starts a few minutes ago rather than at a fixed date, so the
 * header's elapsed reading is a plausible one — a run pinned to a past
 * timestamp would sit at "0s" forever and hide the very thing it is there to
 * show.
 */
const RUN_START_MS = Date.now() - 160_000;
const RUN_ID = new Date(RUN_START_MS).toISOString();
const SESSION_ID = '03ec9a15-dc79-4dd9-ae2e-b9002995f615';

function at(secondsIn: number): string {
  return new Date(RUN_START_MS + secondsIn * 1000).toISOString();
}

function claudeEvent(secondsIn: number, event: Record<string, unknown>): AutonomousRunEvent {
  return { type: 'claudeEvent', runId: RUN_ID, at: at(secondsIn), event };
}

function assistantEvent(secondsIn: number, content: Record<string, unknown>[]): AutonomousRunEvent {
  return claudeEvent(secondsIn, {
    type: 'assistant',
    session_id: SESSION_ID,
    message: { role: 'assistant', model: 'claude-opus-5', content },
  });
}

const RUN_START: AutonomousRunEvent = {
  type: 'runStarted',
  runId: RUN_ID,
  at: at(0),
  forced: true,
  workingDirectory: '/Users/someone/code/2026-08-11-add-a-pace-sparkline',
  projectName: '2026-08-11-add-a-pace-sparkline',
  isNewProject: true,
  prompt: 'Add a sparkline of the last 24 hours of usage to the popup, under the weekly window.',
  model: 'claude-opus-5',
};

const RUN_BODY: AutonomousRunEvent[] = [
  claudeEvent(3, {
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    model: 'claude-opus-5',
    permissionMode: 'auto',
  }),
  assistantEvent(17, [
    { type: 'text', text: "I'll start by reading how the existing windows are drawn." },
  ]),
  assistantEvent(19, [
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/lib/usagePace.ts' } },
  ]),
  assistantEvent(24, [
    {
      type: 'tool_use',
      id: 'toolu_2',
      name: 'Grep',
      input: { pattern: 'windowTickMarks', path: 'src' },
    },
  ]),
  assistantEvent(31, [
    {
      type: 'text',
      text: 'The tick marks already compute the geometry I need, so the sparkline can reuse them.',
    },
    {
      type: 'tool_use',
      id: 'toolu_3',
      name: 'Edit',
      input: { file_path: 'src/components/UsageWindowCard.tsx' },
    },
  ]),
  assistantEvent(58, [
    {
      type: 'tool_use',
      id: 'toolu_4',
      name: 'Bash',
      input: { command: 'just check', description: 'Run the gate' },
    },
  ]),
  claudeEvent(74, {
    type: 'user',
    session_id: SESSION_ID,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_4',
          is_error: true,
          content:
            "src/components/UsageWindowCard.tsx:41:7 - 'samples' is declared but never read.",
        },
      ],
    },
  }),
  { type: 'claudeOutput', runId: RUN_ID, at: at(76), text: 'warning: 1 problem in 1 file' },
  assistantEvent(92, [
    { type: 'text', text: 'That is my own unused binding — removing it.' },
    {
      type: 'tool_use',
      id: 'toolu_5',
      name: 'Edit',
      input: { file_path: 'src/components/UsageWindowCard.tsx' },
    },
  ]),
  assistantEvent(120, [
    { type: 'tool_use', id: 'toolu_6', name: 'Bash', input: { command: 'just check' } },
  ]),
];

const RESULT_EVENT = claudeEvent(148, {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 145_000,
  num_turns: 8,
  total_cost_usd: 0.38,
  session_id: SESSION_ID,
});

/** A run still going: no result, no terminal envelope. */
export const RUNNING_RUN_EVENTS: AutonomousRunEvent[] = [RUN_START, ...RUN_BODY];

export const COMPLETED_RUN_EVENTS: AutonomousRunEvent[] = [
  ...RUNNING_RUN_EVENTS,
  RESULT_EVENT,
  {
    type: 'runFinished',
    runId: RUN_ID,
    at: at(150),
    outcome: 'completed',
    exitCode: 0,
    queueStatus: 'completed',
  },
];

export const CANCELLED_RUN_EVENTS: AutonomousRunEvent[] = [
  ...RUNNING_RUN_EVENTS,
  {
    type: 'runFinished',
    runId: RUN_ID,
    at: at(130),
    outcome: 'cancelled',
    exitCode: -15,
    queueStatus: null,
  },
];

/** What the nightly job leaves behind on a night the week is already on pace. */
export const SKIPPED_RUN_EVENTS: AutonomousRunEvent[] = [
  {
    type: 'runSkipped',
    runId: RUN_ID,
    at: at(0),
    reason: 'onPace',
    detail:
      '0.4h behind an even weekly burn (snapshot 12 min old), threshold is 2.0h behind an even weekly burn',
  },
];
