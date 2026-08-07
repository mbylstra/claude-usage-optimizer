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

export type ExtensionMessage = RefreshUsageMessage;

export type RefreshUsageResponse = UsageCacheEntry;

export function isRefreshUsageMessage(message: unknown): message is RefreshUsageMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === REFRESH_USAGE_MESSAGE
  );
}
