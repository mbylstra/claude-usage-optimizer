import { DEFAULT_SCHEDULE_TIME, normaliseScheduleTime, type ScheduleTime } from './scheduleTime';

/**
 * User-configurable extension settings. Pure types plus the default and the
 * normaliser — no browser APIs, no I/O.
 */

/** Mirrored to `backend/autonomous-work-settings.json` by the native host. */
export interface AutonomousWorkSettings {
  /** Local wall-clock time the nightly run fires, if the week is behind pace. */
  scheduleTime: ScheduleTime;
  /**
   * Where a queue prompt with no `REPO:` line starts a new repository. Kept as
   * the text the user typed, `~` and all, because it is expanded on the machine
   * that runs the work rather than here.
   */
  newProjectsDirectory: string;
  /** The Claude model to use for autonomous runs (haiku, sonnet, opus). */
  model: 'haiku' | 'sonnet' | 'opus';
  /**
   * The longest a single queued prompt may run before it is killed, in hours.
   * There is no way to tell a stuck prompt from a slow one, so this is a flat
   * ceiling rather than an inactivity timeout — converted to seconds only where
   * the scheduler consumes it. Distinct from a *session*, which can run many
   * prompts in a row and is bounded separately, by pace and the usage window.
   */
  maxPromptDurationHours: number;
  /**
   * Text appended to every queued prompt before it is sent to `claude -p`.
   * Empty by default. The queue entry's own prompt — unappended — is still
   * what names a new project's directory.
   */
  appendToAllPrompts: string;
  /**
   * How far ahead of (positive) or behind (negative) an even weekly burn is
   * still "on pace" — below this, the scheduler runs. E.g. `12` tolerates
   * being 12h ahead before stopping; `-2` requires being at least 2h behind
   * before starting. Hours, not milliseconds: `run-autonomous-work.py` is the
   * one place that converts.
   */
  paceThresholdHours: number;
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
export const DEFAULT_MODEL = 'opus';
export const DEFAULT_MAX_PROMPT_DURATION_HOURS = 5;
export const DEFAULT_APPEND_TO_ALL_PROMPTS = '';
export const DEFAULT_PACE_THRESHOLD_HOURS = 0;

export const DEFAULT_AUTONOMOUS_WORK_SETTINGS: AutonomousWorkSettings = {
  scheduleTime: DEFAULT_SCHEDULE_TIME,
  newProjectsDirectory: DEFAULT_NEW_PROJECTS_DIRECTORY,
  model: DEFAULT_MODEL,
  maxPromptDurationHours: DEFAULT_MAX_PROMPT_DURATION_HOURS,
  appendToAllPrompts: DEFAULT_APPEND_TO_ALL_PROMPTS,
  paceThresholdHours: DEFAULT_PACE_THRESHOLD_HOURS,
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
  ) as {
    scheduleTime?: unknown;
    newProjectsDirectory?: unknown;
    model?: unknown;
    maxPromptDurationHours?: unknown;
    appendToAllPrompts?: unknown;
    paceThresholdHours?: unknown;
  };

  const newProjectsDirectory =
    typeof autonomousWorkValue.newProjectsDirectory === 'string' &&
    autonomousWorkValue.newProjectsDirectory.trim() !== ''
      ? autonomousWorkValue.newProjectsDirectory
      : DEFAULT_NEW_PROJECTS_DIRECTORY;

  const model = ['haiku', 'sonnet', 'opus'].includes(autonomousWorkValue.model as string)
    ? (autonomousWorkValue.model as 'haiku' | 'sonnet' | 'opus')
    : DEFAULT_MODEL;

  const maxPromptDurationHours =
    typeof autonomousWorkValue.maxPromptDurationHours === 'number' &&
    Number.isFinite(autonomousWorkValue.maxPromptDurationHours) &&
    autonomousWorkValue.maxPromptDurationHours > 0
      ? autonomousWorkValue.maxPromptDurationHours
      : DEFAULT_MAX_PROMPT_DURATION_HOURS;

  const appendToAllPrompts =
    typeof autonomousWorkValue.appendToAllPrompts === 'string'
      ? autonomousWorkValue.appendToAllPrompts
      : DEFAULT_APPEND_TO_ALL_PROMPTS;

  // Signed — 0 and negative values are both meaningful — so only non-finite
  // values (missing, wrong type, NaN) fall back to the default.
  const paceThresholdHours =
    typeof autonomousWorkValue.paceThresholdHours === 'number' &&
    Number.isFinite(autonomousWorkValue.paceThresholdHours)
      ? autonomousWorkValue.paceThresholdHours
      : DEFAULT_PACE_THRESHOLD_HOURS;

  return {
    notificationsEnabled:
      typeof notificationsEnabled === 'boolean'
        ? notificationsEnabled
        : DEFAULT_EXTENSION_SETTINGS.notificationsEnabled,
    autonomousWork: {
      scheduleTime: normaliseScheduleTime(autonomousWorkValue.scheduleTime),
      newProjectsDirectory,
      model,
      maxPromptDurationHours,
      appendToAllPrompts,
      paceThresholdHours,
    },
  };
}
