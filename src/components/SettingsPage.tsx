import { ArrowLeft } from 'lucide-react';
import { PopupFrame } from './PopupFrame';
import { Card, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

/**
 * The settings screen, shown inside the popup in place of the usage view.
 *
 * It never touches `chrome.*` — `PopupRoot` supplies the value and the change
 * handler, the same split as `UsagePopup`.
 */

export interface SettingsPageProps {
  notificationsEnabled: boolean;
  onNotificationsEnabledChange: (enabled: boolean) => void;
  onBack: () => void;
}

export function SettingsPage({
  notificationsEnabled,
  onNotificationsEnabledChange,
  onBack,
}: SettingsPageProps) {
  return (
    <PopupFrame>
      <header className="flex items-center gap-1">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" title="Back">
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <h1 className="text-sm font-semibold">Settings</h1>
      </header>

      <Card>
        <CardContent className="flex items-start justify-between gap-4 pt-3.5">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="notifications-enabled" className="text-sm font-medium">
              Notifications
            </label>
            <p className="text-muted-foreground text-xs">
              Get notified as a usage window approaches its limit. Not implemented yet — this only
              saves your preference for now.
            </p>
          </div>
          <Switch
            id="notifications-enabled"
            checked={notificationsEnabled}
            onCheckedChange={onNotificationsEnabledChange}
          />
        </CardContent>
      </Card>
    </PopupFrame>
  );
}
