import type {
  UsageCacheEntry,
  UsageSnapshot,
  UsageWindowKind,
  UsageWindowSnapshot,
} from '@/lib/usageTypes';
import { buildUsageSnapshotExport } from '@/lib/usageSnapshotExport';
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
const SUGGESTED_MODEL_STORAGE_KEY = 'suggestedModel';

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
  /**
   * The reset times as reported at `fetchedAt`. Recorded because how they *move*
   * settles whether a window is fixed or rolling, which the pace model depends
   * on and a single response cannot tell you:
   *
   * - fixed  — holds steady, then jumps forward by the window duration while
   *            utilisation drops to ~0
   * - rolling — creeps forward continuously, utilisation decaying gradually
   *
   * See `plans/mvp-chrome-extension.md` §2.
   */
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  sevenDayOpusResetsAt: string | null;
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

function windowFor(
  snapshot: UsageSnapshot,
  kind: UsageWindowKind,
): UsageWindowSnapshot | undefined {
  return snapshot.windows.find((candidate) => candidate.kind === kind);
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

  const fiveHour = windowFor(snapshot, 'fiveHour');
  const sevenDay = windowFor(snapshot, 'sevenDay');
  const sevenDayOpus = windowFor(snapshot, 'sevenDayOpus');

  const sample: UsageHistorySample = {
    fetchedAt,
    fiveHourPercent: fiveHour?.utilizationPercent ?? null,
    sevenDayPercent: sevenDay?.utilizationPercent ?? null,
    sevenDayOpusPercent: sevenDayOpus?.utilizationPercent ?? null,
    fiveHourResetsAt: fiveHour?.resetsAt ?? null,
    sevenDayResetsAt: sevenDay?.resetsAt ?? null,
    sevenDayOpusResetsAt: sevenDayOpus?.resetsAt ?? null,
  };

  const appended = [...history, sample];
  const capped = appended.slice(Math.max(0, appended.length - USAGE_HISTORY_MAX_SAMPLES));

  await chrome.storage.local.set({ [USAGE_HISTORY_STORAGE_KEY]: capped });
}

export async function readUsageHistory(): Promise<UsageHistorySample[]> {
  const stored = await readStorageValue<UsageHistorySample[]>(USAGE_HISTORY_STORAGE_KEY);
  return Array.isArray(stored) ? stored : [];
}

/**
 * Where the autonomous-work scheduler expects to find the snapshot. Relative to
 * the browser's download directory, which is `~/Downloads` unless the user has
 * moved it — see `plans/autonomous-credit-utilization.md` §1.
 */
const USAGE_SNAPSHOT_DOWNLOAD_FILENAME = 'claude-usage.json';

/** Long enough for a few-hundred-byte local write; short enough not to leak listeners. */
const DOWNLOAD_COMPLETION_TIMEOUT_MS = 10_000;

/**
 * Resolves once Chrome reports the download as finished, either way.
 *
 * `chrome.downloads.download` resolves as soon as the download is *created*, and
 * erasing an item that is still in flight is not something the API promises
 * anything sensible about, so the history tidy-up below has to wait for the
 * terminal state first.
 */
function waitForDownloadToSettle(downloadId: number): Promise<void> {
  return new Promise((resolve) => {
    function handleChange(delta: chrome.downloads.DownloadDelta): void {
      if (delta.id !== downloadId || delta.state === undefined) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') finish();
    }

    // `timeoutId` is only read from `finish`, which cannot run before the timer
    // below has been created.
    const finish = (): void => {
      clearTimeout(timeoutId);
      chrome.downloads.onChanged.removeListener(handleChange);
      resolve();
    };

    chrome.downloads.onChanged.addListener(handleChange);
    const timeoutId = setTimeout(finish, DOWNLOAD_COMPLETION_TIMEOUT_MS);
  });
}

/**
 * Writes the snapshot to the download directory so a scheduled shell job can
 * read it. This is the extension's only route to the filesystem — MV3 has no
 * file-write API, and `chrome.downloads` avoids standing up native messaging.
 *
 * The payload is a `data:` URL rather than a blob URL because
 * `URL.createObjectURL` does not exist in a service-worker global scope.
 *
 * The download's *history entry* is erased once the write lands. The file stays
 * on disk; without this a five-minute refresh cadence would bury the user's real
 * downloads under three hundred identical rows a day.
 *
 * Failures are swallowed: a snapshot that cannot be exported must not take the
 * refresh loop — or the popup — down with it.
 */
export async function downloadUsageSnapshotFile(
  snapshot: UsageSnapshot,
  fetchedAt: Date,
): Promise<void> {
  try {
    const exported = buildUsageSnapshotExport(snapshot, fetchedAt);
    const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(
      JSON.stringify(exported, null, 2),
    )}`;

    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: USAGE_SNAPSHOT_DOWNLOAD_FILENAME,
      saveAs: false,
      conflictAction: 'overwrite',
    });

    await waitForDownloadToSettle(downloadId);
    await chrome.downloads.erase({ id: downloadId });
  } catch (error) {
    console.warn('Failed to export usage snapshot to the download directory:', error);
  }
}

export async function readPreviousSuggestedModel(): Promise<string | null> {
  return readStorageValue<string>(SUGGESTED_MODEL_STORAGE_KEY);
}

export async function writeSuggestedModel(model: string): Promise<void> {
  await chrome.storage.local.set({ [SUGGESTED_MODEL_STORAGE_KEY]: model });
}
