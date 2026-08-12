import { describeScheduleTime, type ScheduleTime } from './scheduleTime';

/**
 * What became of an autonomous-work settings change, and the copy for it.
 *
 * Pure — no browser APIs. `PopupRoot` owns the state, `SettingsPage` renders
 * whatever this describes, the same split as `autonomousWorkStatus`.
 *
 * The distinction that matters is `saved` versus `scheduled`. A schedule the
 * extension has stored but no launchd job honours is the one outcome a user
 * could easily misread as success, so it gets its own state rather than being
 * folded into either.
 */

export type AutonomousWorkSettingsStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'scheduled'; scheduleTime: ScheduleTime }
  | { kind: 'savedWithoutSchedule' }
  | { kind: 'failed'; error: string };

export const IDLE_AUTONOMOUS_WORK_SETTINGS_STATUS: AutonomousWorkSettingsStatus = { kind: 'idle' };

/** Same reasoning as in `autonomousWorkStatus` — Chrome's raw wording helps nobody. */
function isHostMissing(error: string): boolean {
  return /not found|forbidden|not installed/i.test(error);
}

export function describeAutonomousWorkSettingsStatus(
  status: AutonomousWorkSettingsStatus,
): string | null {
  switch (status.kind) {
    case 'idle':
      return null;
    case 'saving':
      return 'Saving…';
    case 'scheduled':
      return `Nightly run rescheduled for ${describeScheduleTime(status.scheduleTime)}.`;
    case 'savedWithoutSchedule':
      return 'Saved. No nightly run is scheduled yet — run `just install-autonomous-work` in the project.';
    case 'failed':
      return isHostMissing(status.error)
        ? 'Helper not installed. Run `just install-usage-host` in the project, then reload the extension.'
        : `Could not save: ${status.error}`;
  }
}

export function isAutonomousWorkSettingsStatusError(status: AutonomousWorkSettingsStatus): boolean {
  return status.kind === 'failed';
}
