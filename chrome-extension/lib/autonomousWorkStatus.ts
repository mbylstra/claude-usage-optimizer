/**
 * The state of a manually triggered autonomous-work run, and the copy for it.
 *
 * Pure — no browser APIs. `PopupRoot` owns the state, `SettingsPage` renders
 * whatever this describes.
 */

export type AutonomousWorkStatus =
  { kind: 'idle' } | { kind: 'starting' } | { kind: 'started' } | { kind: 'failed'; error: string };

export const IDLE_AUTONOMOUS_WORK_STATUS: AutonomousWorkStatus = { kind: 'idle' };

/**
 * The host is absent for anyone who has not run `just install-usage-host`, which
 * is the overwhelmingly likely reason for a failure here. Chrome's own wording
 * for it ("Specified native messaging host not found") tells a user nothing
 * about what to do, so it is translated rather than shown raw.
 */
function isHostMissing(error: string): boolean {
  return /not found|forbidden|not installed/i.test(error);
}

export function describeAutonomousWorkStatus(status: AutonomousWorkStatus): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'starting':
      return 'Starting…';
    case 'started':
      return 'Started — progress is written to autonomous-work.log';
    case 'failed':
      return isHostMissing(status.error)
        ? 'Helper not installed. Run `just install-usage-host` in the project, then reload the extension.'
        : `Could not start: ${status.error}`;
  }
}

export function isAutonomousWorkStatusError(status: AutonomousWorkStatus): boolean {
  return status.kind === 'failed';
}
