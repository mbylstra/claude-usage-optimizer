import { useState } from 'react';
import { ArrowLeft, FolderLock, Pencil, Play, ScrollText, X } from 'lucide-react';
import { PopupFrame } from './PopupFrame';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Switch } from './ui/switch';
import {
  describeAutonomousWorkStatus,
  isAutonomousWorkStatusError,
  type AutonomousWorkStatus,
} from '@/lib/autonomousWorkStatus';
import {
  describeAutonomousWorkSettingsStatus,
  isAutonomousWorkSettingsStatusError,
  type AutonomousWorkSettingsStatus,
} from '@/lib/autonomousWorkSettingsStatus';
import {
  describeFolderAccessStatus,
  isFolderAccessStatusError,
  type FolderAccessStatus,
} from '@/lib/folderAccessStatus';
import {
  describeScheduleTime,
  formatScheduleTimeInputValue,
  parseScheduleTimeInputValue,
  type ScheduleTime,
} from '@/lib/scheduleTime';
import {
  DEFAULT_NEW_PROJECTS_DIRECTORY,
  JIRA_COLUMNS,
  isRepositoryDraftComplete,
  repositoryFromDraft,
  type AutonomousWorkSettings,
  type JiraColumnKey,
  type QueueSourceName,
  type RepositoryDraft,
  type RepositoryOption,
} from '@/lib/settingsTypes';
import {
  warningReaches,
  NO_JIRA_WARNING,
  type JiraCredentialWarning,
} from '@/lib/jiraCredentialWarning';

/**
 * One repository being typed, with the button that commits it.
 *
 * Separate from the settings entirely until `onConfirm` — see `RepositoryDraft`
 * for why a half-typed name must never become a setting. Enter confirms and
 * Escape cancels, so the keyboard path does not force a reach for the mouse.
 */
function RepositoryDraftEditor({
  draft,
  confirmLabel,
  onChange,
  onConfirm,
  onCancel,
}: {
  draft: RepositoryDraft;
  confirmLabel: string;
  onChange: (draft: RepositoryDraft) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const complete = isRepositoryDraftComplete(draft);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && complete) {
      event.preventDefault();
      onConfirm();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="border-input flex flex-col gap-2 rounded-md border p-2">
      <Input
        aria-label="Repository name"
        type="text"
        autoFocus
        spellCheck={false}
        placeholder="Name, as it appears on the card"
        value={draft.name}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        onKeyDown={handleKeyDown}
      />
      <Input
        aria-label="Repository path"
        type="text"
        spellCheck={false}
        placeholder="~/code/thing"
        value={draft.path}
        onChange={(event) => onChange({ ...draft, path: event.target.value })}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!complete} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Clamped so a stray edit cannot save an interval that would never trigger the watchdog. */
const MIN_MAX_PROMPT_DURATION_HOURS = 0.5;
const MAX_MAX_PROMPT_DURATION_HOURS = 24;

/** Clamped to a week either way — the weekly window itself bounds what a threshold could mean. */
const MIN_PACE_THRESHOLD_HOURS = -168;
const MAX_PACE_THRESHOLD_HOURS = 168;

/**
 * The queue-source and model selectors are native `<select>` elements, so they
 * get a border here rather than inheriting one from a component — enough to read
 * as a field next to the `Input`s around them without the Radix portal trouble.
 */
const SELECT_CLASS_NAME =
  'border-input bg-background h-8 rounded-md border px-2 text-sm outline-none focus-visible:ring-ring/50 focus-visible:ring-[3px]';

/**
 * The settings screen, shown inside the popup in place of the usage view.
 *
 * It never touches `chrome.*` — `PopupRoot` supplies the values and the change
 * handlers, the same split as `UsagePopup`.
 */

export interface SettingsPageProps {
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (enabled: boolean) => void;
  onTestNotification: () => void;
  autonomousWorkSettings: AutonomousWorkSettings;
  onAutonomousWorkSettingsChange: (settings: AutonomousWorkSettings) => void;
  /**
   * Pushes the settings as they stand to the native host, changing nothing.
   *
   * Every other route to the host is a side effect of an edit, which makes
   * "did it save?" and "did I change anything?" the same question. This one
   * separates them: press it and the host either logs a message or does not.
   */
  onSyncSettingsNow: () => void;
  autonomousWorkSettingsStatus: AutonomousWorkSettingsStatus;
  autonomousWorkStatus: AutonomousWorkStatus;
  onRunAutonomousWork: () => void;
  /** Opens the window that streams the current run, or replays the last one. */
  onOpenRunLog: () => void;
  folderAccessStatus: FolderAccessStatus;
  /** Raises the macOS folder dialogs now, rather than at 2 AM where they cannot be answered. */
  onPrimeFolderAccess: () => void;
  /**
   * What the native host's daily probe last found about the Jira credential.
   *
   * The quietest of the four surfaces §5.4 escalates through, and the first: a
   * token 30 days from expiring says so here and nowhere else.
   */
  jiraWarning?: JiraCredentialWarning;
  onBack: () => void;
}

export function SettingsPage({
  notificationsEnabled,
  onNotificationsEnabledChange,
  onTestNotification,
  autonomousWorkSettings,
  onAutonomousWorkSettingsChange,
  onSyncSettingsNow,
  autonomousWorkSettingsStatus,
  autonomousWorkStatus,
  onRunAutonomousWork,
  onOpenRunLog,
  folderAccessStatus,
  onPrimeFolderAccess,
  jiraWarning = NO_JIRA_WARNING,
  onBack,
}: SettingsPageProps) {
  const autonomousWorkMessage = describeAutonomousWorkStatus(autonomousWorkStatus);
  const settingsMessage = describeAutonomousWorkSettingsStatus(autonomousWorkSettingsStatus);
  const folderAccessMessage = describeFolderAccessStatus(folderAccessStatus);

  const handleScheduleTimeChange = (value: string) => {
    // A half-typed field reports "" or an impossible hour; there is nothing to
    // save until it is a real time again.
    const scheduleTime: ScheduleTime | null = parseScheduleTimeInputValue(value);
    if (scheduleTime === null) return;
    onAutonomousWorkSettingsChange({ ...autonomousWorkSettings, scheduleTime });
  };

  const handleMaxPromptDurationHoursChange = (value: string) => {
    // A half-typed field reports ""; there is nothing to save until it parses.
    const parsedHours = Number.parseFloat(value);
    if (
      !Number.isFinite(parsedHours) ||
      parsedHours < MIN_MAX_PROMPT_DURATION_HOURS ||
      parsedHours > MAX_MAX_PROMPT_DURATION_HOURS
    ) {
      return;
    }
    onAutonomousWorkSettingsChange({
      ...autonomousWorkSettings,
      maxPromptDurationHours: parsedHours,
    });
  };

  const handlePaceThresholdHoursChange = (value: string) => {
    // A half-typed field (including a bare "-") reports ""; there is nothing
    // to save until it parses. Unlike the duration field, 0 and negative
    // values are valid and must not be treated as unset.
    const parsedHours = Number.parseFloat(value);
    if (
      !Number.isFinite(parsedHours) ||
      parsedHours < MIN_PACE_THRESHOLD_HOURS ||
      parsedHours > MAX_PACE_THRESHOLD_HOURS
    ) {
      return;
    }
    onAutonomousWorkSettingsChange({
      ...autonomousWorkSettings,
      paceThresholdHours: parsedHours,
    });
  };

  const handleJiraStatusNameChange = (column: JiraColumnKey, value: string) => {
    // A blank field is not a rename — it means "the name the board was created
    // with" — so it is removed rather than stored as an empty string, which
    // would send the run looking for a column called "".
    const jiraStatusNames = { ...autonomousWorkSettings.jiraStatusNames };
    if (value.trim() === '') {
      delete jiraStatusNames[column];
    } else {
      jiraStatusNames[column] = value;
    }
    onAutonomousWorkSettingsChange({ ...autonomousWorkSettings, jiraStatusNames });
  };

  // The one piece of local state on this screen, and it earns its place: a
  // half-typed repository must not reach the settings at all. Every settings
  // change is pushed to the host 600ms after the last keystroke and turned into
  // Jira dropdown options, and those options are soft-disabled rather than
  // deleted — so typing a name through the settings would leave a permanent
  // trail of `Claude Cod` behind every `Claude Code Optimizer`. Nothing here
  // crosses that line until the row is confirmed.
  const [repositoryDraft, setRepositoryDraft] = useState<RepositoryDraft | null>(null);

  const setRepositories = (repositories: RepositoryOption[]) =>
    onAutonomousWorkSettingsChange({ ...autonomousWorkSettings, repositories });

  const handleCommitRepositoryDraft = () => {
    if (repositoryDraft === null || !isRepositoryDraftComplete(repositoryDraft)) return;
    const repository = repositoryFromDraft(repositoryDraft);
    setRepositories(
      repositoryDraft.index === null
        ? [...autonomousWorkSettings.repositories, repository]
        : autonomousWorkSettings.repositories.map((existing, position) =>
            position === repositoryDraft.index ? repository : existing,
          ),
    );
    setRepositoryDraft(null);
  };

  // Removing is a single deliberate click with nothing half-typed about it, so
  // it commits immediately rather than going through a draft.
  const handleRemoveRepository = (index: number) => {
    setRepositoryDraft(null);
    setRepositories(
      autonomousWorkSettings.repositories.filter((_repository, position) => position !== index),
    );
  };

  const usesJira = autonomousWorkSettings.queueSource === 'jira';

  return (
    <PopupFrame>
      <header className="flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" title="Back">
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-3.5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <label htmlFor="notifications-enabled" className="text-sm font-medium">
                Notifications
              </label>
              <p className="text-muted-foreground text-xs">
                Get notified when the recommended model changes based on your usage pace.
              </p>
            </div>
            <Switch
              id="notifications-enabled"
              checked={notificationsEnabled}
              onCheckedChange={onNotificationsEnabledChange}
            />
          </div>
          <Button variant="outline" size="sm" onClick={onTestNotification}>
            Send test notification
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3.5 pt-3.5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium">Autonomous work</h2>
            <p className="text-muted-foreground text-xs">
              A run starts automatically at{' '}
              {describeScheduleTime(autonomousWorkSettings.scheduleTime)} when the week is far
              enough behind pace.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <label htmlFor="schedule-time" className="text-sm">
              Run at
            </label>
            <Input
              id="schedule-time"
              type="time"
              className="w-28"
              value={formatScheduleTimeInputValue(autonomousWorkSettings.scheduleTime)}
              onChange={(event) => handleScheduleTimeChange(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="pace-threshold-hours" className="text-sm">
              Pace threshold (hours)
            </label>
            <Input
              id="pace-threshold-hours"
              type="number"
              className="w-28"
              min={MIN_PACE_THRESHOLD_HOURS}
              max={MAX_PACE_THRESHOLD_HOURS}
              step={0.5}
              value={autonomousWorkSettings.paceThresholdHours}
              onChange={(event) => handlePaceThresholdHoursChange(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              How far ahead of (positive) or behind (negative) an even weekly burn still counts as
              on pace. E.g. <code>12</code> tolerates being 12h ahead before stopping;{' '}
              <code>-2</code> waits until you are at least 2h behind before starting.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="new-projects-directory" className="text-sm">
              New projects folder
            </label>
            <Input
              id="new-projects-directory"
              type="text"
              spellCheck={false}
              placeholder={DEFAULT_NEW_PROJECTS_DIRECTORY}
              value={autonomousWorkSettings.newProjectsDirectory}
              onChange={(event) =>
                onAutonomousWorkSettingsChange({
                  ...autonomousWorkSettings,
                  newProjectsDirectory: event.target.value,
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              A queued prompt with no <code>REPO:</code> line starts a new repository here, named
              after the prompt.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="model-select" className="text-sm">
              Model for autonomous runs
            </label>
            <select
              id="model-select"
              className={SELECT_CLASS_NAME}
              value={autonomousWorkSettings.model}
              onChange={(event) =>
                onAutonomousWorkSettingsChange({
                  ...autonomousWorkSettings,
                  model: event.target.value as 'sonnet' | 'opus',
                })
              }
            >
              <option value="sonnet">Sonnet (balanced)</option>
              <option value="opus">Opus (most capable)</option>
            </select>
            <p className="text-muted-foreground text-xs">
              The Claude model to use when running queued prompts automatically.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="queue-source-select" className="text-sm">
              Queue source
            </label>
            <select
              id="queue-source-select"
              className={SELECT_CLASS_NAME}
              value={autonomousWorkSettings.queueSource}
              onChange={(event) =>
                onAutonomousWorkSettingsChange({
                  ...autonomousWorkSettings,
                  queueSource: event.target.value as QueueSourceName,
                })
              }
            >
              <option value="file">prompts.txt (no account needed)</option>
              <option value="jira">A Jira board</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Where the queue lives. A board can be reordered by dragging a card, from a phone; a
              file needs no account, no network and no third party. The two are alternatives —
              nothing is copied between them.
            </p>
          </div>

          {usesJira && (
            <div className="flex flex-col gap-1">
              <label htmlFor="jira-project-key" className="text-sm">
                Jira project key
              </label>
              <Input
                id="jira-project-key"
                type="text"
                className="w-28"
                spellCheck={false}
                placeholder="FCP"
                value={autonomousWorkSettings.jiraProjectKey}
                onChange={(event) =>
                  onAutonomousWorkSettingsChange({
                    ...autonomousWorkSettings,
                    jiraProjectKey: event.target.value.toUpperCase(),
                  })
                }
              />
              <p className="text-muted-foreground text-xs">
                Set up by <code>just install-jira-queue</code>. The API token lives in a{' '}
                <code>0600</code> file that never comes through here —{' '}
                <code>just set-jira-credentials</code> writes it.
              </p>
            </div>
          )}

          {usesJira && (
            <details className="flex flex-col gap-1">
              <summary className="cursor-pointer text-sm">Renamed columns</summary>
              <div className="mt-2 flex flex-col gap-2">
                {JIRA_COLUMNS.map((column) => (
                  <div key={column.key} className="flex items-center justify-between gap-3">
                    <label htmlFor={`jira-status-${column.key}`} className="text-xs">
                      {column.defaultName}
                    </label>
                    <Input
                      id={`jira-status-${column.key}`}
                      type="text"
                      className="w-40"
                      spellCheck={false}
                      placeholder={column.defaultName}
                      value={autonomousWorkSettings.jiraStatusNames[column.key] ?? ''}
                      onChange={(event) =>
                        handleJiraStatusNameChange(column.key, event.target.value)
                      }
                    />
                  </div>
                ))}
                <p className="text-muted-foreground text-xs">
                  Only fill these in if you renamed a column in Jira. Statuses are matched by name,
                  ignoring case; anything left blank uses the name above.
                </p>
              </div>
            </details>
          )}

          {usesJira && (
            <details className="flex flex-col gap-1">
              <summary className="cursor-pointer text-sm">Repositories</summary>
              <div className="mt-2 flex flex-col gap-2">
                {autonomousWorkSettings.repositories.map((repository, index) =>
                  repositoryDraft?.index === index ? (
                    <RepositoryDraftEditor
                      key={index}
                      draft={repositoryDraft}
                      confirmLabel="Save"
                      onChange={setRepositoryDraft}
                      onConfirm={handleCommitRepositoryDraft}
                      onCancel={() => setRepositoryDraft(null)}
                    />
                  ) : (
                    <div key={index} className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium">{repository.name}</span>
                        <span className="text-muted-foreground truncate text-xs">
                          {repository.path === '' ? 'No path — will not resolve' : repository.path}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setRepositoryDraft({ index, ...repository })}
                          aria-label={`Edit ${repository.name}`}
                          title="Edit"
                        >
                          <Pencil className="size-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveRepository(index)}
                          aria-label={`Remove ${repository.name}`}
                          title="Remove"
                        >
                          <X className="size-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  ),
                )}

                {repositoryDraft?.index === null && (
                  <RepositoryDraftEditor
                    draft={repositoryDraft}
                    confirmLabel="Add"
                    onChange={setRepositoryDraft}
                    onConfirm={handleCommitRepositoryDraft}
                    onCancel={() => setRepositoryDraft(null)}
                  />
                )}

                {repositoryDraft === null && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start"
                    onClick={() => setRepositoryDraft({ index: null, name: '', path: '' })}
                  >
                    Add repository
                  </Button>
                )}

                <p className="text-muted-foreground text-xs">
                  Each of these becomes an option in the card's <strong>Repository</strong>{' '}
                  dropdown, so a queued prompt can be pointed at a repository without a{' '}
                  <code>REPO:</code> line. Only the name is sent to Jira; the path stays on this
                  machine and is expanded where the work runs. Nothing is sent until you press{' '}
                  <strong>Add</strong> — a name only reaches Jira once you say it is finished.
                  Removing one here disables its option rather than deleting it, so cards that
                  already chose it keep showing it.
                </p>
              </div>
            </details>
          )}

          {usesJira && warningReaches(jiraWarning, 'settings') && (
            <p
              role="status"
              className={
                warningReaches(jiraWarning, 'badge')
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {jiraWarning.message}
            </p>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor="append-to-all-prompts" className="text-sm">
              Append to all prompts
            </label>
            <Textarea
              id="append-to-all-prompts"
              rows={6}
              spellCheck={false}
              placeholder="e.g. Keep changes small and run tests before finishing."
              value={autonomousWorkSettings.appendToAllPrompts}
              onChange={(event) =>
                onAutonomousWorkSettingsChange({
                  ...autonomousWorkSettings,
                  appendToAllPrompts: event.target.value,
                })
              }
            />
            <p className="text-muted-foreground text-xs">
              Added to the end of every queued prompt before it runs. Empty by default.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="max-prompt-duration-hours" className="text-sm">
              Max duration per prompt (hours)
            </label>
            <Input
              id="max-prompt-duration-hours"
              type="number"
              className="w-28"
              min={MIN_MAX_PROMPT_DURATION_HOURS}
              max={MAX_MAX_PROMPT_DURATION_HOURS}
              step={0.5}
              value={autonomousWorkSettings.maxPromptDurationHours}
              onChange={(event) => handleMaxPromptDurationHoursChange(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Hours before a single stuck <code>claude</code> call is killed. This does not limit
              the nightly job itself — it keeps going, prompt after prompt, until the queue is
              empty, it is back on pace, or the session window runs out.
            </p>
          </div>

          <Button variant="outline" size="sm" onClick={onSyncSettingsNow}>
            Sync settings now
          </Button>

          {settingsMessage !== null && (
            <p
              role="status"
              className={
                isAutonomousWorkSettingsStatusError(autonomousWorkSettingsStatus)
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {settingsMessage}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={onRunAutonomousWork}
              disabled={autonomousWorkStatus.kind === 'starting'}
            >
              <Play className="size-3.5" aria-hidden="true" />
              Run now
            </Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={onOpenRunLog}>
              <ScrollText className="size-3.5" aria-hidden="true" />
              View run
            </Button>
          </div>

          <p className="text-muted-foreground text-xs">
            Running now skips the pace check and starts the next queued prompt straight away, and
            opens a window that follows it. View run reopens that window, showing the most recent
            run whenever it happened.
          </p>

          {autonomousWorkMessage !== null && (
            <p
              role="status"
              className={
                isAutonomousWorkStatusError(autonomousWorkStatus)
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {autonomousWorkMessage}
            </p>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={onPrimeFolderAccess}
            disabled={folderAccessStatus.kind === 'starting'}
          >
            <FolderLock className="size-3.5" aria-hidden="true" />
            Grant folder access
          </Button>

          <p className="text-muted-foreground text-xs">
            Lets a queued prompt read <code>~/Documents</code>, <code>~/Desktop</code> and{' '}
            <code>~/Downloads</code>. macOS only offers the choice while you are here — the nightly
            run is refused silently instead — so answering now is what makes those folders readable
            at 2 AM.
          </p>

          {folderAccessMessage !== null && (
            <p
              role="status"
              className={
                isFolderAccessStatusError(folderAccessStatus)
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {folderAccessMessage}
            </p>
          )}
        </CardContent>
      </Card>
    </PopupFrame>
  );
}
