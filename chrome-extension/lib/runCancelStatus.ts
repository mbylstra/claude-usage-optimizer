/**
 * The state of a Cancel request, and the copy for it.
 *
 * Cancelling reports only what the cancel script *killed*. The run's own ending
 * arrives separately, as a `runFinished` event with outcome `cancelled`, so the
 * view never has to optimistically pretend a run stopped.
 */

export type RunCancelStatus =
  | { kind: 'idle' }
  /** Armed by the first click; a second one goes through with it. */
  | { kind: 'confirming' }
  | { kind: 'cancelling' }
  | { kind: 'stopped'; detail: string }
  | { kind: 'nothingRunning' }
  | { kind: 'failed'; error: string };

export const IDLE_RUN_CANCEL_STATUS: RunCancelStatus = { kind: 'idle' };

export function describeRunCancelStatus(status: RunCancelStatus): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'confirming':
      return 'Cancelling stops the run and leaves the queue entry as todo. Click again to confirm.';
    case 'cancelling':
      return 'Stopping the run…';
    case 'stopped':
      return status.detail === '' ? 'Stopped.' : status.detail;
    case 'nothingRunning':
      return 'Nothing was running.';
    case 'failed':
      return `Could not cancel: ${status.error}`;
  }
}

export function isRunCancelStatusError(status: RunCancelStatus): boolean {
  return status.kind === 'failed';
}
