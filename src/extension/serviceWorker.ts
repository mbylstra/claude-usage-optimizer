import { DEFAULT_TOOLBAR_TITLE, deriveToolbarTitle } from '@/lib/usageToolbarTitle';
import type { UsageSnapshot } from '@/lib/usageTypes';
import { fetchUsageSnapshot, toUsageErrorInfo } from './claudeUsageClient';
import { isRefreshUsageMessage, type RefreshUsageResponse } from './messages';
import {
  appendUsageHistorySample,
  chromeOrganizationIdCache,
  readUsageCache,
  writeUsageCache,
  type UsageCacheEntry,
} from './usageStorage';

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

    const fetchedAt = new Date().toISOString();
    const entry: UsageCacheEntry = { snapshot, fetchedAt, error: null };

    await writeUsageCache(entry);
    await appendUsageHistorySample(snapshot, fetchedAt);
    await applyToolbarTitle(snapshot);

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
});

chrome.runtime.onStartup.addListener(() => {
  ensureRefreshAlarm();
  void refreshUsage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== REFRESH_ALARM_NAME) return;
  void refreshUsage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isRefreshUsageMessage(message)) return false;

  refreshUsage().then(
    (entry) => sendResponse(entry satisfies RefreshUsageResponse),
    (error: unknown) =>
      sendResponse({
        snapshot: null,
        fetchedAt: null,
        error: toUsageErrorInfo(error),
      } satisfies RefreshUsageResponse),
  );

  // Keeps the message channel open for the async `sendResponse` above.
  return true;
});

// A worker that was woken for any other reason still ought to have its alarm.
ensureRefreshAlarm();

// Earlier versions painted a percentage over the toolbar icon. Chrome keeps a
// badge until something clears it, so an upgrade has to wipe it explicitly.
void chrome.action.setBadgeText({ text: '' });
