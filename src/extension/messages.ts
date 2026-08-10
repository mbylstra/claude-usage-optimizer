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

export type ExtensionMessage =
  RefreshUsageMessage | TestNotificationMessage | RunAutonomousWorkMessage;

export type RefreshUsageResponse = UsageCacheEntry;

/** Whether the native host accepted the request, not whether the work succeeded. */
export interface RunAutonomousWorkResponse {
  started: boolean;
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
