import { DEFAULT_TOOLBAR_TITLE, deriveToolbarTitle } from '@/lib/usageToolbarTitle';
import { deriveSuggestedModel, type SuggestedModel } from '@/lib/suggestedModel';
import { deriveModelChangeReason } from '@/lib/modelChangeReason';
import { deriveUsageStatuses } from '@/lib/usagePace';
import type { UsageSnapshot } from '@/lib/usageTypes';
import { fetchUsageSnapshot, toUsageErrorInfo } from './claudeUsageClient';
import {
  isOpenRunLogMessage,
  isRefreshUsageMessage,
  isRunAutonomousWorkMessage,
  isSyncAutonomousWorkSettingsMessage,
  isTestNotificationMessage,
  type OpenRunLogResponse,
  type RefreshUsageResponse,
  type RunAutonomousWorkResponse,
  type SyncAutonomousWorkSettingsResponse,
} from './messages';
import { openRunLogWindow, trackRunLogWindowClosure } from './runLogWindow';
import {
  exportUsageSnapshot,
  requestAutonomousWorkRun,
  syncAutonomousWorkSettings,
} from './usageSnapshotExporter';
import {
  appendUsageHistorySample,
  chromeOrganizationIdCache,
  readUsageCache,
  writeUsageCache,
  readPreviousSuggestedModel,
  writeSuggestedModel,
  type UsageCacheEntry,
} from './usageStorage';
import { readExtensionSettings } from './settingsStorage';

/**
 * MV3 service worker: owns the refresh loop, the storage cache and the toolbar
 * tooltip.
 *
 * Periodic work goes through `chrome.alarms` rather than `setInterval` because
 * the worker is torn down when idle — an interval would simply stop firing,
 * whereas an alarm wakes the worker back up.
 */

const REFRESH_ALARM_NAME = 'refreshUsage';
const REFRESH_PERIOD_MINUTES = 5;

async function applyToolbarTitle(snapshot: UsageSnapshot | null): Promise<void> {
  await chrome.action.setTitle({
    title: snapshot === null ? DEFAULT_TOOLBAR_TITLE : deriveToolbarTitle(snapshot),
  });
}

async function notifyModelChange(
  previousModel: string | null,
  newModel: SuggestedModel,
  windows: ReturnType<typeof deriveUsageStatuses>,
): Promise<void> {
  const settings = await readExtensionSettings();
  if (!settings.notificationsEnabled) return;

  const reason = deriveModelChangeReason(previousModel, newModel, windows);
  const modelLabels: Record<string, string> = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
  };

  try {
    if (Notification.permission !== 'granted') {
      console.warn('Notification permission not granted');
      return;
    }

    const timestamp = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).registration.showNotification(
      `Recommended model: ${modelLabels[newModel] || newModel}`,
      {
        icon: chrome.runtime.getURL('icons/icon-128.png'),
        body: reason,
        tag: `model-recommendation-${timestamp}`,
      },
    );
  } catch (error) {
    console.error('Failed to send model change notification:', error);
  }
}

async function sendTestNotification(): Promise<void> {
  try {
    if (Notification.permission !== 'granted') {
      console.warn('Notification permission not granted');
      return;
    }

    const timestamp = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).registration.showNotification('Recommended model: Opus', {
      icon: chrome.runtime.getURL('icons/icon-128.png'),
      body: 'This is a test notification. Your notifications are working!',
      tag: `model-recommendation-${timestamp}`,
    });
    console.log('Test notification sent successfully');
  } catch (error) {
    console.error('Failed to send test notification:', error);
    throw error;
  }
}

/**
 * Fetches, persists and reflects usage in the toolbar tooltip.
 *
 * On failure the last good snapshot is deliberately kept alongside the error, so
 * the popup can still show stale-but-real numbers rather than going blank.
 */
async function refreshUsage(): Promise<UsageCacheEntry> {
  try {
    const snapshot = await fetchUsageSnapshot({
      fetch: globalThis.fetch.bind(globalThis),
      organizationIdCache: chromeOrganizationIdCache,
    });

    const fetchedAtDate = new Date();
    const fetchedAt = fetchedAtDate.toISOString();
    const entry: UsageCacheEntry = { snapshot, fetchedAt, error: null };

    await writeUsageCache(entry);
    await appendUsageHistorySample(snapshot, fetchedAt);
    await applyToolbarTitle(snapshot);
    await exportUsageSnapshot(snapshot, fetchedAtDate);

    const windows = deriveUsageStatuses(snapshot, fetchedAtDate);
    const newModel = deriveSuggestedModel(windows);
    if (newModel !== null) {
      const previousModel = await readPreviousSuggestedModel();
      if (previousModel !== newModel) {
        await notifyModelChange(previousModel, newModel, windows);
        await writeSuggestedModel(newModel);
      }
    }

    return entry;
  } catch (error) {
    const previous = await readUsageCache();
    const entry: UsageCacheEntry = {
      snapshot: previous?.snapshot ?? null,
      fetchedAt: previous?.fetchedAt ?? null,
      error: toUsageErrorInfo(error),
    };

    await writeUsageCache(entry);
    await applyToolbarTitle(entry.snapshot);

    return entry;
  }
}

/**
 * Re-push the stored autonomous-work settings to the native host.
 *
 * The popup pushes on every change, so this is pure reconciliation — it covers
 * the case where the settings were changed before the host was installed, which
 * would otherwise leave the launchd job on a schedule the settings screen says
 * it is not using. Failure is expected and silent for anyone with no host.
 */
async function reconcileAutonomousWorkSettings(): Promise<void> {
  const settings = await readExtensionSettings();
  await syncAutonomousWorkSettings(settings.autonomousWork);
}

function ensureRefreshAlarm(): void {
  chrome.alarms.create(REFRESH_ALARM_NAME, {
    periodInMinutes: REFRESH_PERIOD_MINUTES,
    // Fire almost immediately on install/startup so the popup has real numbers
    // the first time it is opened, then settle into the periodic cadence.
    delayInMinutes: 0.1,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureRefreshAlarm();
  void refreshUsage();
  void reconcileAutonomousWorkSettings();
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  void refreshUsage();
  void reconcileAutonomousWorkSettings();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM_NAME) return;
  void refreshUsage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (isRefreshUsageMessage(message)) {
    refreshUsage().then(
      (entry) => sendResponse(entry satisfies RefreshUsageResponse),
      (error: unknown) =>
        sendResponse({
          snapshot: null,
          fetchedAt: null,
          error: toUsageErrorInfo(error),
        } satisfies RefreshUsageResponse),
    );
    return true;
  }

  if (isRunAutonomousWorkMessage(message)) {
    void requestAutonomousWorkRun().then((result) =>
      sendResponse(result satisfies RunAutonomousWorkResponse),
    );
    return true;
  }

  if (isOpenRunLogMessage(message)) {
    openRunLogWindow().then(
      () => sendResponse({ opened: true } satisfies OpenRunLogResponse),
      (error: unknown) =>
        sendResponse({ opened: false, error: String(error) } satisfies OpenRunLogResponse),
    );
    return true;
  }

  if (isSyncAutonomousWorkSettingsMessage(message)) {
    void syncAutonomousWorkSettings(message.settings).then((result) =>
      sendResponse(result satisfies SyncAutonomousWorkSettingsResponse),
    );
    return true;
  }

  if (isTestNotificationMessage(message)) {
    void sendTestNotification()
      .then(() => sendResponse({ success: true }))
      .catch((error) => {
        console.error('Test notification error:', error);
        sendResponse({ success: false, error: String(error) });
      });
    return true;
  }

  return false;
});

chrome.windows.onRemoved.addListener(trackRunLogWindowClosure);

// A worker that was woken for any other reason still ought to have its alarm.
ensureRefreshAlarm();

// Earlier versions painted a percentage over the toolbar icon. Chrome keeps a
// badge until something clears it, so an upgrade has to wipe it explicitly.
void chrome.action.setBadgeText({ text: '' });
