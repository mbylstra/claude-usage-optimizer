import { useCallback, useEffect, useState } from 'react';
import { UsagePopup } from '@/components/UsagePopup';
import { buildUsagePopupData } from '@/lib/usagePopupData';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import { REFRESH_USAGE_MESSAGE, type RefreshUsageResponse } from '@/extension/messages';
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

export function PopupRoot() {
  const [cacheEntry, setCacheEntry] = useState<UsageCacheEntry | null>(null);
  const [hasLoadedCache, setHasLoadedCache] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const now = useTickingClock();

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

  // Pick up refreshes triggered by the alarm while the popup happens to be open.
  useEffect(() => {
    const handleStorageChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return;
      const change = changes[USAGE_CACHE_CHANGE_KEY];
      if (change === undefined) return;
      setCacheEntry(change.newValue as UsageCacheEntry);
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  const openClaude = useCallback(() => {
    void chrome.tabs.create({ url: CLAUDE_URL });
    window.close();
  }, []);

  // Before the cache read resolves we genuinely know nothing — show the loading
  // state rather than flashing "no data yet".
  const data = buildUsagePopupData(hasLoadedCache ? cacheEntry : null, now);

  return (
    <UsagePopup
      data={data}
      now={now}
      isRefreshing={isRefreshing}
      onRefresh={requestRefresh}
      onOpenClaude={openClaude}
    />
  );
}
