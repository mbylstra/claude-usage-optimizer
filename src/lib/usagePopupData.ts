import { deriveUsageStatuses } from './usagePace';
import { deriveSuggestedModel, type SuggestedModel } from './suggestedModel';
import type { DerivedWindowStatus, UsageCacheEntry, UsageErrorInfo } from './usageTypes';

/**
 * Maps the persisted cache entry onto the view model the popup renders.
 *
 * Pure and `now`-injected, so every visual state the popup can reach is
 * reproducible from a fixture in Storybook and assertable in a unit test.
 */

/** Past this, cached numbers are old enough to be worth flagging. */
export const USAGE_STALE_AFTER_MS = 15 * 60 * 1000;

export interface UsagePopupLoading {
  state: 'loading';
}

export interface UsagePopupError {
  state: 'error';
  error: UsageErrorInfo;
}

export interface UsagePopupReady {
  state: 'ready';
  windows: DerivedWindowStatus[];
  fetchedAt: Date;
  isStale: boolean;
  /** Set when the latest refresh failed but older numbers are still on screen. */
  refreshError: UsageErrorInfo | null;
  /** Null only if the snapshot is missing a window the suggestion depends on. */
  suggestedModel: SuggestedModel | null;
}

export type UsagePopupData = UsagePopupLoading | UsagePopupError | UsagePopupReady;

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildUsagePopupData(entry: UsageCacheEntry | null, now: Date): UsagePopupData {
  if (entry === null || entry.snapshot === null) {
    // An error with no snapshot behind it is the only thing worth blocking on.
    if (entry?.error != null) return { state: 'error', error: entry.error };
    return { state: 'loading' };
  }

  const fetchedAt = parseTimestamp(entry.fetchedAt) ?? now;
  const windows = deriveUsageStatuses(entry.snapshot, now);

  return {
    state: 'ready',
    windows,
    fetchedAt,
    isStale: now.getTime() - fetchedAt.getTime() > USAGE_STALE_AFTER_MS,
    refreshError: entry.error,
    suggestedModel: deriveSuggestedModel(windows),
  };
}
