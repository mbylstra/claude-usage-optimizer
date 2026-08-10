import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SettingsPage } from '@/components/SettingsPage';
import { UsagePopup } from '@/components/UsagePopup';
import { buildUsagePopupData } from '@/lib/usagePopupData';
import { DEFAULT_EXTENSION_SETTINGS, type ExtensionSettings } from '@/lib/settingsTypes';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import {
  REFRESH_USAGE_MESSAGE,
  RUN_AUTONOMOUS_WORK_MESSAGE,
  TEST_NOTIFICATION_MESSAGE,
  type RefreshUsageResponse,
  type RunAutonomousWorkResponse,
} from '@/extension/messages';
import { IDLE_AUTONOMOUS_WORK_STATUS, type AutonomousWorkStatus } from '@/lib/autonomousWorkStatus';
import {
  readExtensionSettings,
  SETTINGS_CHANGE_KEY,
  writeExtensionSettings,
} from '@/extension/settingsStorage';
import { readUsageCache, USAGE_CACHE_CHANGE_KEY } from '@/extension/usageStorage';

/**
 * The only component allowed to talk to the extension layer.
 *
 * On open it paints the cached snapshot immediately and *then* asks the service
 * worker for a fresh one, so opening the popup never shows a spinner when there
 * is anything at all to show.
 */

/** Keeps "2h 14m left" and "updated 3m ago" honest while the popup is open. */
const CLOCK_TICK_MS = 30_000;

const CLAUDE_URL = 'https://claude.ai';

function useTickingClock(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  return now;
}

type PopupView = 'usage' | 'settings';

export function PopupRoot() {
  const [view, setView] = useState<PopupView>('usage');
  const [cacheEntry, setCacheEntry] = useState<UsageCacheEntry | null>(null);
  const [hasLoadedCache, setHasLoadedCache] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_EXTENSION_SETTINGS);
  const [autonomousWorkStatus, setAutonomousWorkStatus] = useState<AutonomousWorkStatus>(
    IDLE_AUTONOMOUS_WORK_STATUS,
  );
  const now = useTickingClock();

  // Chrome sizes the popup to whatever is currently rendered, so switching to
  // the shorter settings view and back would otherwise make it visibly shrink
  // and regrow. Tracking the tallest height any view has needed and enforcing
  // it as a floor keeps the popup a constant size without hard-coding one.
  const contentRef = useRef<HTMLDivElement>(null);
  const [minContentHeightPx, setMinContentHeightPx] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const node = contentRef.current;
    if (node === null) return;

    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height === undefined) return;
      setMinContentHeightPx((current) =>
        current === undefined ? height : Math.max(current, height),
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const requestRefresh = useCallback(() => {
    setIsRefreshing(true);
    chrome.runtime.sendMessage(
      { type: REFRESH_USAGE_MESSAGE },
      (response?: RefreshUsageResponse) => {
        setIsRefreshing(false);
        // A dead message channel leaves `lastError` set and `response` undefined;
        // the storage listener below will still deliver the result if it lands.
        if (chrome.runtime.lastError !== undefined || response === undefined) return;
        setCacheEntry(response);
      },
    );
  }, []);

  const runAutonomousWork = useCallback(() => {
    setAutonomousWorkStatus({ kind: 'starting' });
    chrome.runtime.sendMessage(
      { type: RUN_AUTONOMOUS_WORK_MESSAGE },
      (response?: RunAutonomousWorkResponse) => {
        if (chrome.runtime.lastError !== undefined) {
          setAutonomousWorkStatus({
            kind: 'failed',
            error: chrome.runtime.lastError.message ?? '',
          });
          return;
        }
        if (response === undefined) {
          setAutonomousWorkStatus({ kind: 'failed', error: 'No response from the extension' });
          return;
        }
        setAutonomousWorkStatus(
          response.started ? { kind: 'started' } : { kind: 'failed', error: response.error ?? '' },
        );
      },
    );
  }, []);

  const requestTestNotification = useCallback(() => {
    chrome.runtime.sendMessage({ type: TEST_NOTIFICATION_MESSAGE }, (response) => {
      if (chrome.runtime.lastError !== undefined) {
        console.error('Test notification error:', chrome.runtime.lastError);
      } else {
        console.log('Test notification sent:', response);
      }
    });
  }, []);

  // Paint from cache, then refresh.
  useEffect(() => {
    let isMounted = true;

    void readUsageCache().then((entry) => {
      if (!isMounted) return;
      setCacheEntry(entry);
      setHasLoadedCache(true);
      requestRefresh();
    });

    return () => {
      isMounted = false;
    };
  }, [requestRefresh]);

  useEffect(() => {
    let isMounted = true;

    void readExtensionSettings().then((loaded) => {
      if (isMounted) setSettings(loaded);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  // Pick up refreshes triggered by the alarm, and settings changes from another
  // copy of the popup, while this one happens to be open.
  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;

      const usageChange = changes[USAGE_CACHE_CHANGE_KEY];
      if (usageChange !== undefined) setCacheEntry(usageChange.newValue as UsageCacheEntry);

      const settingsChange = changes[SETTINGS_CHANGE_KEY];
      if (settingsChange !== undefined) setSettings(settingsChange.newValue as ExtensionSettings);
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  const openClaude = useCallback(() => {
    void chrome.tabs.create({ url: CLAUDE_URL });
    window.close();
  }, []);

  const openSettings = useCallback(() => setView('settings'), []);
  const closeSettings = useCallback(() => setView('usage'), []);

  const handleNotificationsEnabledChange = useCallback((notificationsEnabled: boolean) => {
    setSettings((current) => {
      const next: ExtensionSettings = { ...current, notificationsEnabled };
      void writeExtensionSettings(next);
      return next;
    });
  }, []);

  // Before the cache read resolves we genuinely know nothing — show the loading
  // state rather than flashing "no data yet".
  const data = buildUsagePopupData(hasLoadedCache ? cacheEntry : null, now);

  return (
    <div
      ref={contentRef}
      style={minContentHeightPx === undefined ? undefined : { minHeight: minContentHeightPx }}
    >
      {view === 'settings' ? (
        <SettingsPage
          notificationsEnabled={settings.notificationsEnabled}
          onNotificationsEnabledChange={handleNotificationsEnabledChange}
          onTestNotification={requestTestNotification}
          autonomousWorkStatus={autonomousWorkStatus}
          onRunAutonomousWork={runAutonomousWork}
          onBack={closeSettings}
        />
      ) : (
        <UsagePopup
          data={data}
          now={now}
          isRefreshing={isRefreshing}
          onRefresh={requestRefresh}
          onOpenClaude={openClaude}
          onOpenSettings={openSettings}
        />
      )}
    </div>
  );
}
