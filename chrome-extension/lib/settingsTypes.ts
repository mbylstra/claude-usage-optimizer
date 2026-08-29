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
  /**
   * The Claude model to use for autonomous runs. Haiku is not offered: the
   * scheduler runs `claude -p` under auto permission mode, which needs
   * Opus 4.6+ / Sonnet 4.6+ / Fable 5 — on Haiku it falls back to Manual and a
   * headless run then denies every edit and shell command.
   */
  model: 'sonnet' | 'opus';
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
  /**
   * Where the queue lives. `file` is `prompts.txt` at the repository root, which
   * needs no account, no network and no third party, and is what a fresh clone
   * works with; `jira` is a board — see plans/work-queue-as-a-jira-board.md.
   *
   * The two are alternatives and never both live. Nothing is mirrored between
   * them, because a stale copy is indistinguishable from a real queue and the
   * run would happily execute a prompt deleted from the board yesterday.
   */
  queueSource: QueueSourceName;
  /** The Jira project the board lives in, e.g. `FCP`. Ignored for the file source. */
  jiraProjectKey: string;
  /**
   * The status names, where a column has been renamed in Jira. Only the renamed
   * ones appear; anything absent uses the name the board was created with.
   *
   * The **credential** deliberately does not travel this path — it is a `0600`
   * file set from the terminal, because this object is mirrored to a plaintext
   * file the native host rewrites and logs around.
   */
  jiraStatusNames: JiraStatusNames;
  /**
   * The repositories a Jira card's `Repository` dropdown can point a prompt at.
   * Pushed to Jira on every settings save; ignored for the file source, which
   * has no UI to pick anything from and keeps `REPO:` as its only mechanism.
   */
  repositories: RepositoryOption[];
}

/**
 * One row of the repository list: what Jira shows, and where it actually is.
 *
 * The split is the point. A single-select option in Jira is one string, and an
 * absolute path can carry a username or a company name — so only `name` is ever
 * sent, and `path` stays in the local settings mirror.
 */
export interface RepositoryOption {
  /** Shown on the Jira card's dropdown. Never a path. */
  name: string;
  /**
   * Expanded on the machine that runs the work, `~` and all — the same
   * convention `newProjectsDirectory` follows. Never sent to Jira. May be empty:
   * a name-only row is a draft, not yet somewhere work can run.
   */
  path: string;
}

/**
 * A repository row being typed, before it is committed to the settings.
 *
 * A draft is deliberately **not** an `AutonomousWorkSettings` field. Every
 * settings change is pushed to the native host 600ms after the last keystroke,
 * and the host turns the repository list into Jira dropdown options — so a
 * half-typed name reaching the settings at all would mint an option for
 * `Claude Cod` on the way to `Claude Code Optimizer`. Options are soft-disabled
 * and never deleted (a deleted one blanks the field on every card that chose
 * it), which would make that litter permanent. Confirming a row is what turns a
 * draft into a setting.
 */
export interface RepositoryDraft {
  /** The row being edited, or null while adding a new one. */
  index: number | null;
  name: string;
  path: string;
}

/** Is there enough here to commit? The name is what Jira's dropdown shows. */
export function isRepositoryDraftComplete(draft: RepositoryDraft): boolean {
  return draft.name.trim() !== '';
}

/** A draft as it will be stored — trimmed, and without the editing position. */
export function repositoryFromDraft(draft: RepositoryDraft): RepositoryOption {
  return { name: draft.name.trim(), path: draft.path.trim() };
}

export type QueueSourceName = 'file' | 'jira';

/** Column key to status name. Keys are the five `JIRA_COLUMN_KEYS` below. */
export type JiraStatusNames = Partial<Record<JiraColumnKey, string>>;

export type JiraColumnKey = 'draft' | 'todo' | 'inProgress' | 'inReview' | 'done';

/** The five columns, in board order, with the names the project is created with. */
export const JIRA_COLUMNS: readonly { key: JiraColumnKey; defaultName: string }[] = [
  { key: 'draft', defaultName: 'Draft' },
  { key: 'todo', defaultName: 'To Do' },
  { key: 'inProgress', defaultName: 'In Progress' },
  { key: 'inReview', defaultName: 'In Review' },
  { key: 'done', defaultName: 'Done' },
];

const JIRA_COLUMN_KEYS: readonly string[] = JIRA_COLUMNS.map((column) => column.key);

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
export const DEFAULT_QUEUE_SOURCE: QueueSourceName = 'file';
export const DEFAULT_JIRA_PROJECT_KEY = '';
export const DEFAULT_REPOSITORIES: RepositoryOption[] = [];

export const DEFAULT_AUTONOMOUS_WORK_SETTINGS: AutonomousWorkSettings = {
  scheduleTime: DEFAULT_SCHEDULE_TIME,
  newProjectsDirectory: DEFAULT_NEW_PROJECTS_DIRECTORY,
  model: DEFAULT_MODEL,
  maxPromptDurationHours: DEFAULT_MAX_PROMPT_DURATION_HOURS,
  appendToAllPrompts: DEFAULT_APPEND_TO_ALL_PROMPTS,
  paceThresholdHours: DEFAULT_PACE_THRESHOLD_HOURS,
  queueSource: DEFAULT_QUEUE_SOURCE,
  jiraProjectKey: DEFAULT_JIRA_PROJECT_KEY,
  jiraStatusNames: {},
  repositories: DEFAULT_REPOSITORIES,
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
    queueSource?: unknown;
    jiraProjectKey?: unknown;
    jiraStatusNames?: unknown;
    repositories?: unknown;
  };

  const newProjectsDirectory =
    typeof autonomousWorkValue.newProjectsDirectory === 'string' &&
    autonomousWorkValue.newProjectsDirectory.trim() !== ''
      ? autonomousWorkValue.newProjectsDirectory
      : DEFAULT_NEW_PROJECTS_DIRECTORY;

  // A stored 'haiku' (no longer offered) lands on 'sonnet', the nearest still-
  // valid model, rather than jumping to DEFAULT_MODEL — which is the priciest.
  const rawModel = autonomousWorkValue.model;
  const model: 'sonnet' | 'opus' =
    rawModel === 'haiku'
      ? 'sonnet'
      : rawModel === 'sonnet' || rawModel === 'opus'
        ? rawModel
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

  // Anything but a known source falls back to the file. That direction matters:
  // no upgrade path, and no half-written storage, may leave an install with no
  // queue at all.
  const queueSource: QueueSourceName =
    autonomousWorkValue.queueSource === 'jira' ? 'jira' : DEFAULT_QUEUE_SOURCE;

  const jiraProjectKey =
    typeof autonomousWorkValue.jiraProjectKey === 'string'
      ? autonomousWorkValue.jiraProjectKey.trim().toUpperCase()
      : DEFAULT_JIRA_PROJECT_KEY;

  const jiraStatusNames = normaliseJiraStatusNames(autonomousWorkValue.jiraStatusNames);

  const repositories = normaliseRepositories(autonomousWorkValue.repositories);

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
      queueSource,
      jiraProjectKey,
      jiraStatusNames,
      repositories,
    },
  };
}

/**
 * Keep only rows that could name something: a non-empty `name`.
 *
 * `path` is coerced rather than required, because a name-only row is a draft
 * somebody is still filling in — the same tolerance `newProjectsDirectory` gives
 * an empty string. A row with no name is not a draft, it is nothing: it is the
 * string Jira's dropdown would show, and the one a card's selection is matched
 * against.
 */
function normaliseRepositories(stored: unknown): RepositoryOption[] {
  if (!Array.isArray(stored)) return [];
  const repositories: RepositoryOption[] = [];
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, path } = entry as { name?: unknown; path?: unknown };
    if (typeof name !== 'string' || name.trim() === '') continue;
    repositories.push({
      name: name.trim(),
      path: typeof path === 'string' ? path.trim() : '',
    });
  }
  return repositories;
}

/**
 * Keep only real renames: a known column key mapped to a non-empty name.
 *
 * A blank entry is not a rename, and storing one would send the Jira source
 * looking for a column called "" rather than for the name the board actually
 * has.
 */
function normaliseJiraStatusNames(stored: unknown): JiraStatusNames {
  if (typeof stored !== 'object' || stored === null) return {};
  const names: JiraStatusNames = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!JIRA_COLUMN_KEYS.includes(key)) continue;
    if (typeof value !== 'string' || value.trim() === '') continue;
    names[key as JiraColumnKey] = value.trim();
  }
  return names;
}
