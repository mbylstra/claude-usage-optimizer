import { DEFAULT_TOOLBAR_TITLE, deriveToolbarTitle } from '@/lib/usageToolbarTitle';
import { deriveSuggestedModel, type SuggestedModel } from '@/lib/suggestedModel';
import { deriveModelChangeReason } from '@/lib/modelChangeReason';
import { deriveUsageStatuses } from '@/lib/usagePace';
import type { UsageSnapshot } from '@/lib/usageTypes';
import {
  deriveNewUsageLimitWarnings,
  usageLimitWarningBody,
  usageLimitWarningTitle,
  type UsageLimitWarning,
} from '@/lib/usageLimitWarnings';
import { isRepeatOfLastNotification, type ShownNotification } from '@/lib/notificationSuppression';
import { fetchUsageSnapshot, toUsageErrorInfo } from './claudeUsageClient';
import {
  isOpenRunLogMessage,
  isRefreshUsageMessage,
  isPrimeFolderAccessMessage,
  isRunAutonomousWorkMessage,
  isSyncAutonomousWorkSettingsMessage,
  isTestNotificationMessage,
  type OpenRunLogResponse,
  type RefreshUsageResponse,
  type PrimeFolderAccessResponse,
  type RunAutonomousWorkResponse,
  type SyncAutonomousWorkSettingsResponse,
} from './messages';
import { openRunLogWindow, trackRunLogWindowClosure } from './runLogWindow';
import {
  exportUsageSnapshot,
  requestAutonomousWorkRun,
  requestFolderAccessPrompts,
  syncAutonomousWorkSettings,
} from './usageSnapshotExporter';
import {
  appendUsageHistorySample,
  chromeOrganizationIdCache,
  readUsageCache,
  writeUsageCache,
  readPreviousSuggestedModel,
  writeSuggestedModel,
  readUsageLimitWarningState,
  writeUsageLimitWarningState,
  readLastShownNotification,
  writeLastShownNotification,
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

/**
 * The one place a notification is shown, and so the one place a duplicate can
 * be caught.
 *
 * Anything identical to the last notification shown is dropped — see
 * `isRepeatOfLastNotification` for why. The record is written only after the
 * notification actually appears, so a failed show does not silently suppress
 * its own retry.
 *
 * The test notification deliberately does not come through here: proving that
 * notifications work means firing every single time the button is pressed.
 */
async function showNotificationUnlessRepeated(
  notification: ShownNotification,
  tagPrefix: string,
): Promise<void> {
  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return;
  }

  const lastShown = await readLastShownNotification();
  if (isRepeatOfLastNotification(lastShown, notification)) {
    console.log('Skipped a notification identical to the last one:', notification.title);
    return;
  }

  try {
    const timestamp = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (self as any).registration.showNotification(notification.title, {
      icon: chrome.runtime.getURL('icons/icon-128.png'),
      body: notification.body,
      tag: `${tagPrefix}-${timestamp}`,
    });
    await writeLastShownNotification(notification);
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}

async function notifyModelChange(
  previousModel: string | null,
  newModel: SuggestedModel,
  windows: ReturnType<typeof deriveUsageStatuses>,
): Promise<void> {
  const settings = await readExtensionSettings();
  if (!settings.notificationsEnabled) return;

  const modelLabels: Record<string, string> = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
  };

  await showNotificationUnlessRepeated(
    {
      title: `Recommended model: ${modelLabels[newModel] || newModel}`,
      body: deriveModelChangeReason(previousModel, newModel, windows),
    },
    'model-recommendation',
  );
}

/**
 * Fires once per window that newly crossed a threshold — never once per
 * threshold. `deriveNewUsageLimitWarnings` reports only the highest of the
 * thresholds a refresh crossed, so a jump from 89% straight past all three
 * says "nearly at limit" once rather than stacking three banners.
 *
 * Two different windows crossing at the same time is still two notifications:
 * they name different windows, so neither is redundant.
 */
async function notifyUsageLimitWarnings(warnings: UsageLimitWarning[]): Promise<void> {
  if (warnings.length === 0) return;

  const settings = await readExtensionSettings();
  if (!settings.notificationsEnabled) return;

  for (const warning of warnings) {
    await showNotificationUnlessRepeated(
      {
        title: usageLimitWarningTitle(warning.kind, warning.threshold),
        body: usageLimitWarningBody(warning.threshold),
      },
      `usage-limit-${warning.kind}-${warning.threshold}`,
    );
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

    const previousLimitWarningState = await readUsageLimitWarningState();
    const { warnings, state: newLimitWarningState } = deriveNewUsageLimitWarnings(
      snapshot.windows,
      previousLimitWarningState,
    );
    await writeUsageLimitWarningState(newLimitWarningState);
    await notifyUsageLimitWarnings(warnings);

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

  if (isPrimeFolderAccessMessage(message)) {
    void requestFolderAccessPrompts().then((result) =>
      sendResponse(result satisfies PrimeFolderAccessResponse),
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
