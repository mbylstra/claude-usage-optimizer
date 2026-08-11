import { DEFAULT_SCHEDULE_TIME, normaliseScheduleTime, type ScheduleTime } from './scheduleTime';

/**
 * User-configurable extension settings. Pure types plus the default and the
 * normaliser — no browser APIs, no I/O.
 */

/** Mirrored to `.claude-scripts/autonomous-work-settings.json` by the native host. */
export interface AutonomousWorkSettings {
  /** Local wall-clock time the nightly run fires, if the week is behind pace. */
  scheduleTime: ScheduleTime;
  /**
   * Where a queue prompt with no `REPO:` line starts a new repository. Kept as
   * the text the user typed, `~` and all, because it is expanded on the machine
   * that runs the work rather than here.
   */
  newProjectsDirectory: string;
}

export interface ExtensionSettings {
  /**
   * Whether the user wants to be notified as a usage window approaches its
   * limit. The toggle is wired up end to end; the notifications themselves are
   * not implemented yet.
   */
  notificationsEnabled: boolean;
  autonomousWork: AutonomousWorkSettings;
}

export const DEFAULT_NEW_PROJECTS_DIRECTORY = '~/code';

export const DEFAULT_AUTONOMOUS_WORK_SETTINGS: AutonomousWorkSettings = {
  scheduleTime: DEFAULT_SCHEDULE_TIME,
  newProjectsDirectory: DEFAULT_NEW_PROJECTS_DIRECTORY,
};

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  notificationsEnabled: false,
  autonomousWork: DEFAULT_AUTONOMOUS_WORK_SETTINGS,
};

/**
 * Fill in whatever storage is missing, field by field.
 *
 * A spread over the default is not enough once settings nest: storage written by
 * an older build has no `autonomousWork` key at all, and one written by a newer
 * build may have only some of its fields.
 */
export function normaliseExtensionSettings(stored: unknown): ExtensionSettings {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_EXTENSION_SETTINGS;

  const { notificationsEnabled, autonomousWork } = stored as {
    notificationsEnabled?: unknown;
    autonomousWork?: unknown;
  };

  const autonomousWorkValue = (
    typeof autonomousWork === 'object' && autonomousWork !== null ? autonomousWork : {}
  ) as { scheduleTime?: unknown; newProjectsDirectory?: unknown };

  const newProjectsDirectory =
    typeof autonomousWorkValue.newProjectsDirectory === 'string' &&
    autonomousWorkValue.newProjectsDirectory.trim() !== ''
      ? autonomousWorkValue.newProjectsDirectory
      : DEFAULT_NEW_PROJECTS_DIRECTORY;

  return {
    notificationsEnabled:
      typeof notificationsEnabled === 'boolean'
        ? notificationsEnabled
        : DEFAULT_EXTENSION_SETTINGS.notificationsEnabled,
    autonomousWork: {
      scheduleTime: normaliseScheduleTime(autonomousWorkValue.scheduleTime),
      newProjectsDirectory,
    },
  };
}
