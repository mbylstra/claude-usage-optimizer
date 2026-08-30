import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SettingsPage } from '@/components/SettingsPage';
import { UsagePopup } from '@/components/UsagePopup';
import { buildUsagePopupData } from '@/lib/usagePopupData';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type AutonomousWorkSettings,
  type ExtensionSettings,
} from '@/lib/settingsTypes';
import type { UsageCacheEntry } from '@/lib/usageTypes';
import {
  OPEN_RUN_LOG_MESSAGE,
  REFRESH_USAGE_MESSAGE,
  PRIME_FOLDER_ACCESS_MESSAGE,
  RUN_AUTONOMOUS_WORK_MESSAGE,
  RUN_FULL_AUTONOMOUS_WORK_MESSAGE,
  SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE,
  TEST_NOTIFICATION_MESSAGE,
  type RefreshUsageResponse,
  type PrimeFolderAccessResponse,
  type RunAutonomousWorkResponse,
  type SyncAutonomousWorkSettingsResponse,
  READ_JIRA_STATUS_MESSAGE,
  type ReadJiraStatusResponse,
} from '@/extension/messages';
import { IDLE_AUTONOMOUS_WORK_STATUS, type AutonomousWorkStatus } from '@/lib/autonomousWorkStatus';
import { IDLE_FOLDER_ACCESS_STATUS, type FolderAccessStatus } from '@/lib/folderAccessStatus';
import {
  IDLE_AUTONOMOUS_WORK_SETTINGS_STATUS,
  type AutonomousWorkSettingsStatus,
} from '@/lib/autonomousWorkSettingsStatus';
import {
  readExtensionSettings,
  SETTINGS_CHANGE_KEY,
  writeExtensionSettings,
} from '@/extension/settingsStorage';
import { readUsageCache, USAGE_CACHE_CHANGE_KEY } from '@/extension/usageStorage';
import {
  deriveJiraCredentialWarning,
  type JiraCredentialStatus,
} from '@/lib/jiraCredentialWarning';

/**
 * The only component allowed to talk to the extension layer.
 *
 * On open it paints the cached snapshot immediately and *then* asks the service
 * worker for a fresh one, so opening the popup never shows a spinner when there
 * is anything at all to show.
 */

/** Keeps "2h 14m left" and "updated 3m ago" honest while the popup is open. */
const CLOCK_TICK_MS = 30_000;

/**
 * How long the autonomous-work settings must sit unchanged before they are
 * pushed to the native host.
 *
 * The folder field is typed a character at a time, and each push spawns a host
 * process that rewrites a launchd job — worth waiting out. Storage is still
 * written on every keystroke, so nothing is lost if the popup closes first; the
 * service worker re-pushes on its next startup.
 */
const SETTINGS_SYNC_DEBOUNCE_MS = 600;

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
  // A second status, because the two run buttons are independent — a shared one
  // would show "Starting…" under whichever button was not pressed.
  const [fullAutonomousWorkStatus, setFullAutonomousWorkStatus] = useState<AutonomousWorkStatus>(
    IDLE_AUTONOMOUS_WORK_STATUS,
  );
  const [folderAccessStatus, setFolderAccessStatus] =
    useState<FolderAccessStatus>(IDLE_FOLDER_ACCESS_STATUS);
  const [autonomousWorkSettingsStatus, setAutonomousWorkSettingsStatus] =
    useState<AutonomousWorkSettingsStatus>(IDLE_AUTONOMOUS_WORK_SETTINGS_STATUS);
  const now = useTickingClock();

  // Chrome sizes the popup to whatever is currently rendered, so switching to
  // the shorter settings view and back would otherwise make it visibly shrink
  // and regrow. Tracking the tallest height any view has needed and enforcing
  // it as a floor keeps the popup a constant size without hard-coding one.
  const contentRef = useRef<HTMLDivElement>(null);
  const [jiraStatus, setJiraStatus] = useState<JiraCredentialStatus | null>(null);
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

  /**
   * Show the run log. Focuses the window if one is already open — the service
   * worker is what remembers that, so this goes through it rather than calling
   * `chrome.windows` here.
   */
  const openRunLog = useCallback(() => {
    chrome.runtime.sendMessage({ type: OPEN_RUN_LOG_MESSAGE }, () => {
      // Nothing to report: the window either appeared in front of the user or
      // the popup has already closed, and `lastError` must be read regardless.
      void chrome.runtime.lastError;
    });
  }, []);

  const startAutonomousRun = useCallback(
    (
      messageType: typeof RUN_AUTONOMOUS_WORK_MESSAGE | typeof RUN_FULL_AUTONOMOUS_WORK_MESSAGE,
      setStatus: (status: AutonomousWorkStatus) => void,
    ) => {
      setStatus({ kind: 'starting' });
      chrome.runtime.sendMessage({ type: messageType }, (response?: RunAutonomousWorkResponse) => {
        if (chrome.runtime.lastError !== undefined) {
          setStatus({ kind: 'failed', error: chrome.runtime.lastError.message ?? '' });
          return;
        }
        if (response === undefined) {
          setStatus({ kind: 'failed', error: 'No response from the extension' });
          return;
        }
        if (!response.started) {
          setStatus({ kind: 'failed', error: response.error ?? '' });
          return;
        }
        setStatus({ kind: 'started' });
        // Only once the host has accepted: a window that opens on a failed
        // start would show an empty log and say nothing about why.
        openRunLog();
      });
    },
    [openRunLog],
  );

  const runAutonomousWork = useCallback(
    () => startAutonomousRun(RUN_AUTONOMOUS_WORK_MESSAGE, setAutonomousWorkStatus),
    [startAutonomousRun],
  );

  const runFullAutonomousWork = useCallback(
    () => startAutonomousRun(RUN_FULL_AUTONOMOUS_WORK_MESSAGE, setFullAutonomousWorkStatus),
    [startAutonomousRun],
  );

  const primeFolderAccess = useCallback(() => {
    setFolderAccessStatus({ kind: 'starting' });
    chrome.runtime.sendMessage(
      { type: PRIME_FOLDER_ACCESS_MESSAGE },
      (response?: PrimeFolderAccessResponse) => {
        if (chrome.runtime.lastError !== undefined) {
          setFolderAccessStatus({ kind: 'failed', error: chrome.runtime.lastError.message ?? '' });
          return;
        }
        if (response === undefined) {
          setFolderAccessStatus({ kind: 'failed', error: 'No response from the extension' });
          return;
        }
        if (!response.started) {
          setFolderAccessStatus({ kind: 'failed', error: response.error ?? '' });
          return;
        }
        setFolderAccessStatus({ kind: 'started' });
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

  // What the host's last daily probe found. A read of a local file, so it costs
  // nothing to ask on every open — and the popup is where the two quieter halves
  // of the warning (the settings line and the banner) are shown.
  useEffect(() => {
    let isMounted = true;

    chrome.runtime.sendMessage({ type: READ_JIRA_STATUS_MESSAGE }, (response) => {
      if (chrome.runtime.lastError !== undefined || !isMounted) return;
      setJiraStatus((response as ReadJiraStatusResponse | undefined)?.status ?? null);
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

  // Only the latest edit is worth pushing, so a pending timer is replaced rather
  // than queued behind.
  const settingsSyncTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const syncAutonomousWorkSettings = useCallback((autonomousWork: AutonomousWorkSettings) => {
    setAutonomousWorkSettingsStatus({ kind: 'saving' });
    chrome.runtime.sendMessage(
      { type: SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE, settings: autonomousWork },
      (response?: SyncAutonomousWorkSettingsResponse) => {
        if (chrome.runtime.lastError !== undefined) {
          setAutonomousWorkSettingsStatus({
            kind: 'failed',
            error: chrome.runtime.lastError.message ?? '',
          });
          return;
        }
        if (response === undefined) {
          setAutonomousWorkSettingsStatus({
            kind: 'failed',
            error: 'No response from the extension',
          });
          return;
        }
        if (!response.saved) {
          setAutonomousWorkSettingsStatus({ kind: 'failed', error: response.error ?? '' });
          return;
        }
        // `?? null` rather than passing it through: a reply from a host older
        // than the repository picker carries no such key, and "nothing to say"
        // is the same outcome as a save with no Jira half to do.
        const repositorySync = response.repositorySync ?? null;
        setAutonomousWorkSettingsStatus(
          response.launchAgentUpdated
            ? { kind: 'scheduled', scheduleTime: autonomousWork.scheduleTime, repositorySync }
            : { kind: 'savedWithoutSchedule', repositorySync },
        );
      },
    );
  }, []);

  /**
   * Store the change now, tell the host about it shortly.
   *
   * The write is immediate so the field never fights what the user typed and so
   * a popup that closes mid-edit keeps the value; only the host round trip —
   * which rewrites a launchd job — waits for the typing to stop.
   */
  const handleAutonomousWorkSettingsChange = useCallback(
    (autonomousWork: AutonomousWorkSettings) => {
      setSettings((current) => {
        const next: ExtensionSettings = { ...current, autonomousWork };
        void writeExtensionSettings(next);
        return next;
      });

      clearTimeout(settingsSyncTimer.current);
      settingsSyncTimer.current = setTimeout(
        () => syncAutonomousWorkSettings(autonomousWork),
        SETTINGS_SYNC_DEBOUNCE_MS,
      );
    },
    [syncAutonomousWorkSettings],
  );

  useEffect(() => () => clearTimeout(settingsSyncTimer.current), []);

  /**
   * Push the settings to the host now, without editing anything.
   *
   * The debounced sync means an edit and its arrival at the host are separated
   * by time and by a timer that can be cancelled, so a value that never lands is
   * ambiguous between "not sent" and "sent and lost". This is the unambiguous
   * half: one press, one message, whatever is on screen.
   */
  const handleSyncSettingsNow = useCallback(() => {
    clearTimeout(settingsSyncTimer.current);
    syncAutonomousWorkSettings(settings.autonomousWork);
  }, [settings.autonomousWork, syncAutonomousWorkSettings]);

  // Before the cache read resolves we genuinely know nothing — show the loading
  // state rather than flashing "no data yet".
  const data = buildUsagePopupData(hasLoadedCache ? cacheEntry : null, now);
  const jiraWarning = deriveJiraCredentialWarning(jiraStatus, settings.autonomousWork.queueSource);

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
          autonomousWorkSettings={settings.autonomousWork}
          onAutonomousWorkSettingsChange={handleAutonomousWorkSettingsChange}
          onSyncSettingsNow={handleSyncSettingsNow}
          autonomousWorkSettingsStatus={autonomousWorkSettingsStatus}
          autonomousWorkStatus={autonomousWorkStatus}
          onRunAutonomousWork={runAutonomousWork}
          fullAutonomousWorkStatus={fullAutonomousWorkStatus}
          onRunFullAutonomousWork={runFullAutonomousWork}
          folderAccessStatus={folderAccessStatus}
          onPrimeFolderAccess={primeFolderAccess}
          onOpenRunLog={openRunLog}
          jiraWarning={jiraWarning}
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
          jiraWarning={jiraWarning}
        />
      )}
    </div>
  );
}
