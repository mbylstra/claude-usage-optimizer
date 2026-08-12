/**
 * The state of the live connection to the native host, and the copy for it.
 *
 * Separate from the run's own status: a run can be perfectly healthy while the
 * viewer's port is down, and vice versa. Pure — `RunLogRoot` owns the state.
 */

export type RunStreamStatus =
  | { kind: 'connecting' }
  | { kind: 'streaming' }
  | { kind: 'reconnecting' }
  /** The native host is not installed, which is an ordinary state, not an error. */
  | { kind: 'unavailable'; error: string }
  | { kind: 'failed'; error: string };

export const INITIAL_RUN_STREAM_STATUS: RunStreamStatus = { kind: 'connecting' };

/**
 * Chrome's own wording for a missing host ("Specified native messaging host not
 * found") tells a user nothing about what to do, so it is translated rather than
 * shown raw — the same treatment `autonomousWorkStatus` gives it.
 */
export function isMissingHostError(error: string): boolean {
  return /not found|forbidden|not installed/i.test(error);
}

export function describeRunStreamStatus(status: RunStreamStatus): string | null {
  switch (status.kind) {
    case 'connecting':
      return 'Connecting…';
    case 'streaming':
      return null; // Working as intended needs no words.
    case 'reconnecting':
      return 'Lost the connection to the helper — reconnecting…';
    case 'unavailable':
      return 'Helper not installed. Run `just install-usage-host` in the project, then reload the extension.';
    case 'failed':
      return `Could not follow the run: ${status.error}`;
  }
}

export function isRunStreamStatusError(status: RunStreamStatus): boolean {
  return status.kind === 'unavailable' || status.kind === 'failed';
}
