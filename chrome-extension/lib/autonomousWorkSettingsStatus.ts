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

/**
 * What the host's Jira repository sync did, if it ran at all.
 *
 * The shape `queue_source_jira.RepositoryFieldSync.to_json()` writes. `null` on
 * a save that had no Jira half to do — a file queue, or a Jira queue with no
 * credential or project key yet.
 */
export interface RepositorySyncResult {
  ok: boolean;
  added?: string[];
  disabled?: string[];
  reenabled?: string[];
  error?: string | null;
}

export type AutonomousWorkSettingsStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | {
      kind: 'scheduled';
      scheduleTime: ScheduleTime;
      repositorySync?: RepositorySyncResult | null;
    }
  | { kind: 'savedWithoutSchedule'; repositorySync?: RepositorySyncResult | null }
  | { kind: 'failed'; error: string };

export const IDLE_AUTONOMOUS_WORK_SETTINGS_STATUS: AutonomousWorkSettingsStatus = { kind: 'idle' };

/** Same reasoning as in `autonomousWorkStatus` — Chrome's raw wording helps nobody. */
function isHostMissing(error: string): boolean {
  return /not found|forbidden|not installed/i.test(error);
}

/**
 * The Jira half of a save, in one clause appended to the save confirmation.
 *
 * A save that silently did not do its Jira half is the failure worth naming: the
 * repository list is the one setting that has to land somewhere other than this
 * machine, and "Saved" alone would imply it had. Nothing is said when there was
 * no Jira half to do, or when the sync changed nothing — a clause on every save
 * is noise that trains somebody to stop reading it.
 */
function describeRepositorySync(sync: RepositorySyncResult | null | undefined): string | null {
  if (sync === null || sync === undefined) return null;
  if (!sync.ok) return 'Could not reach Jira — repositories not synced.';

  const added = [...(sync.added ?? []), ...(sync.reenabled ?? [])];
  const removed = sync.disabled ?? [];
  const clauses: string[] = [];
  if (added.length > 0) clauses.push(`Synced ${quoteNames(added)} to Jira.`);
  if (removed.length > 0) clauses.push(`Removed ${quoteNames(removed)} from the Jira dropdown.`);
  return clauses.length > 0 ? clauses.join(' ') : null;
}

function quoteNames(names: string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

function withRepositorySync(
  message: string,
  sync: RepositorySyncResult | null | undefined,
): string {
  const clause = describeRepositorySync(sync);
  return clause === null ? message : `${message} ${clause}`;
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
      return withRepositorySync(
        `Nightly run rescheduled for ${describeScheduleTime(status.scheduleTime)}.`,
        status.repositorySync,
      );
    case 'savedWithoutSchedule':
      return withRepositorySync(
        'Saved. No nightly run is scheduled yet — run `just install-autonomous-work` in the project.',
        status.repositorySync,
      );
    case 'failed':
      return isHostMissing(status.error)
        ? 'Helper not installed. Run `just install-usage-host` in the project, then reload the extension.'
        : `Could not save: ${status.error}`;
  }
}

export function isAutonomousWorkSettingsStatusError(status: AutonomousWorkSettingsStatus): boolean {
  return status.kind === 'failed';
}
