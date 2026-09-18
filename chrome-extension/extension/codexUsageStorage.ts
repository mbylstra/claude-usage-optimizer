import type { UsageCacheEntry } from '@/lib/usageTypes';

/**
 * Sibling of `usageStorage.ts`, scoped to just the Codex usage cache. It does
 * not touch `organizationId`, `usageHistory`, `suggestedModel`, or any of the
 * Claude-specific keys in that file — the two caches are independent, per
 * `plans/codex-subscription-usage.md`'s "explicitly out of scope" section.
 */

const CODEX_USAGE_CACHE_STORAGE_KEY = 'codexUsageCache';

export const CODEX_USAGE_CACHE_CHANGE_KEY = CODEX_USAGE_CACHE_STORAGE_KEY;

export async function readCodexUsageCache(): Promise<UsageCacheEntry | null> {
  const stored = await chrome.storage.local.get(CODEX_USAGE_CACHE_STORAGE_KEY);
  const value = stored[CODEX_USAGE_CACHE_STORAGE_KEY];
  return value === undefined ? null : (value as UsageCacheEntry);
}

export async function writeCodexUsageCache(entry: UsageCacheEntry): Promise<void> {
  await chrome.storage.local.set({ [CODEX_USAGE_CACHE_STORAGE_KEY]: entry });
}
