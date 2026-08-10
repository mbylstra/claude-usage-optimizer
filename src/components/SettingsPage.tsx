import { ArrowLeft, Play } from 'lucide-react';
import { PopupFrame } from './PopupFrame';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import {
  describeAutonomousWorkStatus,
  isAutonomousWorkStatusError,
  type AutonomousWorkStatus,
} from '@/lib/autonomousWorkStatus';

/**
 * The settings screen, shown inside the popup in place of the usage view.
 *
 * It never touches `chrome.*` — `PopupRoot` supplies the value and the change
 * handler, the same split as `UsagePopup`.
 */

export interface SettingsPageProps {
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (enabled: boolean) => void;
  onTestNotification: () => void;
  autonomousWorkStatus: AutonomousWorkStatus;
  onRunAutonomousWork: () => void;
  onBack: () => void;
}

export function SettingsPage({
  notificationsEnabled,
  onNotificationsEnabledChange,
  onTestNotification,
  autonomousWorkStatus,
  onRunAutonomousWork,
  onBack,
}: SettingsPageProps) {
  const autonomousWorkMessage = describeAutonomousWorkStatus(autonomousWorkStatus);
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
        <CardContent className="flex flex-col gap-3 pt-3.5">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-sm font-medium">Autonomous work</h2>
            <p className="text-muted-foreground text-xs">
              A run starts automatically at 2 AM when the week is far enough behind pace. Running it
              now skips that check and starts the next queued prompt straight away.
            </p>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={onRunAutonomousWork}
            disabled={autonomousWorkStatus.kind === 'starting'}
          >
            <Play className="size-3.5" aria-hidden="true" />
            Run now
          </Button>

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
        </CardContent>
      </Card>
    </PopupFrame>
  );
}
