import type { AutonomousWorkSettings } from '@/lib/settingsTypes';
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

export type ExtensionMessage =
  | RefreshUsageMessage
  | TestNotificationMessage
  | RunAutonomousWorkMessage
  | SyncAutonomousWorkSettingsMessage;

export type RefreshUsageResponse = UsageCacheEntry;

/** Whether the native host accepted the request, not whether the work succeeded. */
export interface RunAutonomousWorkResponse {
  started: boolean;
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
  error?: string;
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

export function isSyncAutonomousWorkSettingsMessage(
  message: unknown,
): message is SyncAutonomousWorkSettingsMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === SYNC_AUTONOMOUS_WORK_SETTINGS_MESSAGE
  );
}
