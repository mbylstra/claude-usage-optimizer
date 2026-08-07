import type { UsageCacheEntry, UsageSnapshot } from '@/lib/usageTypes';
import type { OrganizationIdCache } from './claudeUsageClient';

export type { UsageCacheEntry };

/**
 * The only module that reads or writes `chrome.storage.local`.
 *
 * Everything persisted here is a plain JSON value; `Date`s are stored as ISO
 * strings and revived by the caller.
 */

const ORGANIZATION_ID_STORAGE_KEY = 'organizationId';
const USAGE_CACHE_STORAGE_KEY = 'usageCache';
const USAGE_HISTORY_STORAGE_KEY = 'usageHistory';

const ORGANIZATION_ID_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Roughly two weeks of five-minute samples. */
export const USAGE_HISTORY_MAX_SAMPLES = 2000;

interface StoredOrganizationId {
  organizationId: string;
  cachedAt: string;
}

/**
 * One sample of the raw utilisation figures, appended on every successful
 * refresh. Nothing reads this yet — it exists so that the activity-weighted
 * pace model has a real dataset to be built against later.
 */
export interface UsageHistorySample {
  fetchedAt: string;
  fiveHourPercent: number | null;
  sevenDayPercent: number | null;
  sevenDayOpusPercent: number | null;
}

async function readStorageValue<T>(key: string): Promise<T | null> {
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  return value === undefined ? null : (value as T);
}

export async function readOrganizationId(): Promise<string | null> {
  const stored = await readStorageValue<StoredOrganizationId>(ORGANIZATION_ID_STORAGE_KEY);
  if (stored === null || typeof stored.organizationId !== 'string') return null;

  const cachedAtMs = new Date(stored.cachedAt).getTime();
  const isExpired =
    Number.isNaN(cachedAtMs) || Date.now() - cachedAtMs > ORGANIZATION_ID_MAX_AGE_MS;

  return isExpired ? null : stored.organizationId;
}

export async function writeOrganizationId(organizationId: string): Promise<void> {
  const stored: StoredOrganizationId = {
    organizationId,
    cachedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [ORGANIZATION_ID_STORAGE_KEY]: stored });
}

export async function clearOrganizationId(): Promise<void> {
  await chrome.storage.local.remove(ORGANIZATION_ID_STORAGE_KEY);
}

/** The cache implementation handed to `fetchUsageSnapshot`. */
export const chromeOrganizationIdCache: OrganizationIdCache = {
  read: readOrganizationId,
  write: writeOrganizationId,
  clear: clearOrganizationId,
};

export async function readUsageCache(): Promise<UsageCacheEntry | null> {
  return readStorageValue<UsageCacheEntry>(USAGE_CACHE_STORAGE_KEY);
}

export async function writeUsageCache(entry: UsageCacheEntry): Promise<void> {
  await chrome.storage.local.set({ [USAGE_CACHE_STORAGE_KEY]: entry });
}

export const USAGE_CACHE_CHANGE_KEY = USAGE_CACHE_STORAGE_KEY;

function percentFor(snapshot: UsageSnapshot, kind: string): number | null {
  const window = snapshot.windows.find((candidate) => candidate.kind === kind);
  return window === undefined ? null : window.utilizationPercent;
}

/**
 * Appends one sample to a capped ring buffer. Oldest entries fall off the front
 * once the cap is reached, so storage use stays bounded without any cleanup job.
 */
export async function appendUsageHistorySample(
  snapshot: UsageSnapshot,
  fetchedAt: string,
): Promise<void> {
  const existing = (await readStorageValue<UsageHistorySample[]>(USAGE_HISTORY_STORAGE_KEY)) ?? [];
  const history = Array.isArray(existing) ? existing : [];

  const sample: UsageHistorySample = {
    fetchedAt,
    fiveHourPercent: percentFor(snapshot, 'fiveHour'),
    sevenDayPercent: percentFor(snapshot, 'sevenDay'),
    sevenDayOpusPercent: percentFor(snapshot, 'sevenDayOpus'),
  };

  const appended = [...history, sample];
  const capped = appended.slice(Math.max(0, appended.length - USAGE_HISTORY_MAX_SAMPLES));

  await chrome.storage.local.set({ [USAGE_HISTORY_STORAGE_KEY]: capped });
}

export async function readUsageHistory(): Promise<UsageHistorySample[]> {
  const stored = await readStorageValue<UsageHistorySample[]>(USAGE_HISTORY_STORAGE_KEY);
  return Array.isArray(stored) ? stored : [];
}
