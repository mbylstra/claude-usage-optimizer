import type { AutonomousWorkSettings } from '@/lib/settingsTypes';
import type { JiraCredentialStatus } from '@/lib/jiraCredentialWarning';
import type { RepositorySyncResult } from '@/lib/autonomousWorkSettingsStatus';
import type { UsageCacheEntry } from './usageStorage';

/**
 * The popup never fetches on its own — it asks the service worker to refresh, so
 * that the network call, the storage write and the badge update all happen in
 * one place regardless of who triggered them.
 */

export const REFRESH_USAGE_MESSAGE = 'REFRESH_USAGE' as const;

export interface RefreshUsageMessage {
  type: typeof REFRESH_USAGE_MESSAGE;
}

export const TEST_NOTIFICATION_MESSAGE = 'TEST_NOTIFICATION' as const;

export interface TestNotificationMessage {
  type: typeof TEST_NOTIFICATION_MESSAGE;
}

export const RUN_AUTONOMOUS_WORK_MESSAGE = 'RUN_AUTONOMOUS_WORK' as const;

export interface RunAutonomousWorkMessage {
  type: typeof RUN_AUTONOMOUS_WORK_MESSAGE;
}

export const OPEN_RUN_LOG_MESSAGE = 'OPEN_RUN_LOG' as const;

/**
 * Show the window that streams the current run.
 *
 * Opening a window is a `chrome.windows` call, which the popup could make
 * itself — but the service worker is what knows whether one is already open, and
 * it outlives the popup that asked.
 */
export interface OpenRunLogMessage {
  type: typeof OPEN_RUN_LOG_MESSAGE;
}

export const PRIME_FOLDER_ACCESS_MESSAGE = 'PRIME_FOLDER_ACCESS' as const;

/**
 * Ask macOS about the protected folders now, while somebody is watching.
 *
 * The permission dialog only appears when Chrome is in the chain; a run started
 * by launchd at 2 AM is refused silently instead. So this exists to move the
 * asking to a moment when the answer can be given.
 */
export interface PrimeFolderAccessMessage {
  type: typeof PRIME_FOLDER_ACCESS_MESSAGE;
}

export const SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE = 'SYNC_AUTONOMOUS_WORK_SETTINGS' as const;

/**
 * Push the autonomous-work settings out to the native host, which mirrors them
 * to disk and reschedules the launchd job.
 *
 * The settings ride along rather than being re-read from storage, so a change
 * cannot be applied out of order with the write that produced it.
 */
export interface SyncAutonomousWorkSettingsMessage {
  type: typeof SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE;
  settings: AutonomousWorkSettings;
}

export const READ_JIRA_STATUS_MESSAGE = 'READ_JIRA_STATUS' as const;

/**
 * Ask for the Jira credential's health, as the host's last daily probe left it.
 *
 * Through the service worker rather than straight from the popup, like every
 * other host call except the run-log stream: this one is a plain
 * request-and-reply, which is exactly what that rule is for.
 */
export interface ReadJiraStatusMessage {
  type: typeof READ_JIRA_STATUS_MESSAGE;
}

export type ExtensionMessage =
  | RefreshUsageMessage
  | TestNotificationMessage
  | RunAutonomousWorkMessage
  | OpenRunLogMessage
  | PrimeFolderAccessMessage
  | SyncAutonomousWorkSettingsMessage
  | ReadJiraStatusMessage;

export type RefreshUsageResponse = UsageCacheEntry;

/** Whether the native host accepted the request, not whether the work succeeded. */
export interface RunAutonomousWorkResponse {
  started: boolean;
  error?: string;
}

/** Whether the prompting started, not whether the user allowed anything. */
export interface PrimeFolderAccessResponse {
  started: boolean;
  error?: string;
}

/** Whether the window is now showing, not whether a run is in flight. */
export interface OpenRunLogResponse {
  opened: boolean;
  error?: string;
}

export interface SyncAutonomousWorkSettingsResponse {
  /** The host stored the settings. */
  saved: boolean;
  /**
   * The nightly launchd job now runs at the new time. False when the job was
   * never installed — the settings are still saved, but nothing is scheduled.
   */
  launchAgentUpdated: boolean;
  /**
   * What the host made of the repository list, or null when this save had no
   * Jira half to do. The one setting that has to land somewhere other than this
   * machine, so a save that quietly did not send it is worth saying out loud.
   */
  repositorySync?: RepositorySyncResult | null;
  error?: string;
}

/** The probe's last answer, or null when there is nothing to say about it. */
export interface ReadJiraStatusResponse {
  status: JiraCredentialStatus | null;
}

export function isReadJiraStatusMessage(message: unknown): message is ReadJiraStatusMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === READ_JIRA_STATUS_MESSAGE
  );
}

export function isRefreshUsageMessage(message: unknown): message is RefreshUsageMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === REFRESH_USAGE_MESSAGE
  );
}

export function isTestNotificationMessage(message: unknown): message is TestNotificationMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === TEST_NOTIFICATION_MESSAGE
  );
}

export function isRunAutonomousWorkMessage(message: unknown): message is RunAutonomousWorkMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === RUN_AUTONOMOUS_WORK_MESSAGE
  );
}

export function isOpenRunLogMessage(message: unknown): message is OpenRunLogMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === OPEN_RUN_LOG_MESSAGE
  );
}

export function isPrimeFolderAccessMessage(message: unknown): message is PrimeFolderAccessMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === PRIME_FOLDER_ACCESS_MESSAGE
  );
}

export function isSyncAutonomousWorkSettingsMessage(
  message: unknown,
): message is SyncAutonomousWorkSettingsMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE
  );
}
