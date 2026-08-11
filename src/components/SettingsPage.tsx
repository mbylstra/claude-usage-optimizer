import { ArrowLeft, FolderLock, Play, ScrollText } from 'lucide-react';
import { PopupFrame } from './PopupFrame';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
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
import { DEFAULT_NEW_PROJECTS_DIRECTORY, type AutonomousWorkSettings } from '@/lib/settingsTypes';

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
  autonomousWorkSettingsStatus: AutonomousWorkSettingsStatus;
  autonomousWorkStatus: AutonomousWorkStatus;
  onRunAutonomousWork: () => void;
  /** Opens the window that streams the current run, or replays the last one. */
  onOpenRunLog: () => void;
  folderAccessStatus: FolderAccessStatus;
  /** Raises the macOS folder dialogs now, rather than at 2 AM where they cannot be answered. */
  onPrimeFolderAccess: () => void;
  onBack: () => void;
}

export function SettingsPage({
  notificationsEnabled,
  onNotificationsEnabledChange,
  onTestNotification,
  autonomousWorkSettings,
  onAutonomousWorkSettingsChange,
  autonomousWorkSettingsStatus,
  autonomousWorkStatus,
  onRunAutonomousWork,
  onOpenRunLog,
  folderAccessStatus,
  onPrimeFolderAccess,
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
