import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { UsagePopup } from '@/components/UsagePopup';
import { SettingsPage } from '@/components/SettingsPage';
import { buildUsagePopupData } from '@/lib/usagePopupData';
import type { AutonomousWorkStatus } from '@/lib/autonomousWorkStatus';
import { IDLE_FOLDER_ACCESS_STATUS } from '@/lib/folderAccessStatus';
import type { AutonomousWorkSettingsStatus } from '@/lib/autonomousWorkSettingsStatus';
import { DEFAULT_AUTONOMOUS_WORK_SETTINGS } from '@/lib/settingsTypes';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import '@/index.css';

/** Throwaway visual harness — not part of the build. */

const now = new Date('2026-08-07T15:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 3600_000).toISOString();
const days = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString();

// Session windows: 5h long, so `resetsAt = start + 5h`.
// Weekly windows: 7d long.
function sessionEntry(percent: number, hoursUntilReset: number): UsageCacheEntry {
  return {
    snapshot: {
      windows: [
        {
          kind: 'fiveHour',
          utilizationPercent: percent,
          resetsAt: hours(hoursUntilReset),
          startedAt: null,
        },
        { kind: 'sevenDay', utilizationPercent: percent, resetsAt: days(3.5), startedAt: null },
      ],
    },
    fetchedAt: now.toISOString(),
    error: null,
  };
}

// 2.5h into a 5h window => even burn is 50%.
const CASES: { label: string; entry: UsageCacheEntry }[] = [
  { label: 'on pace (50%)', entry: sessionEntry(50, 2.5) },
  { label: 'slightly ahead (56%)', entry: sessionEntry(56, 2.5) },
  { label: 'moderately ahead (62%)', entry: sessionEntry(62, 2.5) },
  { label: 'severely ahead (80%)', entry: sessionEntry(80, 2.5) },
  { label: 'small headroom (44%)', entry: sessionEntry(44, 2.5) },
  { label: 'comfortable headroom (25%)', entry: sessionEntry(25, 2.5) },
  { label: 'barely started (2%)', entry: sessionEntry(2, 4.9) },
];

const AUTONOMOUS_WORK_CASES: {
  label: string;
  status: AutonomousWorkStatus;
  settingsStatus: AutonomousWorkSettingsStatus;
}[] = [
  { label: 'settings — idle', status: { kind: 'idle' }, settingsStatus: { kind: 'idle' } },
  {
    label: 'settings — started',
    status: { kind: 'started' },
    settingsStatus: { kind: 'scheduled', scheduleTime: { hour: 3, minute: 30 } },
  },
  {
    label: 'settings — host missing',
    status: { kind: 'failed', error: 'Specified native messaging host not found.' },
    settingsStatus: { kind: 'savedWithoutSchedule' },
  },
];

function Column({ dark }: { dark: boolean }) {
  return (
    <div className={dark ? 'dark' : ''} style={{ background: dark ? '#111' : '#fff', padding: 8 }}>
      {AUTONOMOUS_WORK_CASES.map(({ label, status, settingsStatus }) => (
        <div key={label}>
          <div
            style={{
              font: '11px system-ui',
              color: dark ? '#888' : '#666',
              padding: '10px 14px 0',
            }}
          >
            {label}
          </div>
          <SettingsPage
            notificationsEnabled={true}
            onNotificationsEnabledChange={() => {}}
            onTestNotification={() => {}}
            autonomousWorkSettings={DEFAULT_AUTONOMOUS_WORK_SETTINGS}
            onAutonomousWorkSettingsChange={() => {}}
            onSyncSettingsNow={() => {}}
            autonomousWorkSettingsStatus={settingsStatus}
            autonomousWorkStatus={status}
            onRunAutonomousWork={() => {}}
            fullAutonomousWorkStatus={status}
            onRunFullAutonomousWork={() => {}}
            onOpenRunLog={() => {}}
            folderAccessStatus={IDLE_FOLDER_ACCESS_STATUS}
            onPrimeFolderAccess={() => {}}
            onBack={() => {}}
          />
        </div>
      ))}
      {CASES.map(({ label, entry }) => (
        <div key={label}>
          <div
            style={{
              font: '11px system-ui',
              color: dark ? '#888' : '#666',
              padding: '10px 14px 0',
            }}
          >
            {label}
          </div>
          <UsagePopup
            data={buildUsagePopupData(entry, now)}
            now={now}
            isRefreshing={false}
            onRefresh={() => {}}
            onOpenClaude={() => {}}
            onOpenSettings={() => {}}
          />
        </div>
      ))}
    </div>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('missing root');

createRoot(container).render(
  <StrictMode>
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <Column dark={false} />
      <Column dark={true} />
    </div>
  </StrictMode>,
);

export { Column };
