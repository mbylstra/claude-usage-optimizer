import { deriveUsageStatuses } from './usagePace';
import { USAGE_STALE_AFTER_MS } from './usagePopupData';
import type { DerivedWindowStatus, UsageCacheEntry, UsageErrorInfo } from './usageTypes';

/**
 * Maps the persisted Codex cache entry onto the view model
 * `CodexUsageSection` renders — the same shape `buildUsagePopupData` builds
 * for Claude, minus `suggestedModel`.
 *
 * `deriveSuggestedModel` reads `fiveHour`/`sevenDay` utilisation to recommend
 * an Anthropic model; calling `buildUsagePopupData` unmodified against a
 * Codex snapshot would silently produce an Anthropic model recommendation
 * from OpenAI usage numbers. Kept as its own function rather than an optional
 * field on the existing one, so nothing about the Claude path has to change
 * shape to accommodate a feature it doesn't have.
 */

export interface CodexUsagePopupLoading {
  state: 'loading';
}

export interface CodexUsagePopupError {
  state: 'error';
  error: UsageErrorInfo;
}

export interface CodexUsagePopupReady {
  state: 'ready';
  windows: DerivedWindowStatus[];
  fetchedAt: Date;
  isStale: boolean;
  /** Set when the latest refresh failed but older numbers are still on screen. */
  refreshError: UsageErrorInfo | null;
}

export type CodexUsagePopupData =
  CodexUsagePopupLoading | CodexUsagePopupError | CodexUsagePopupReady;

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildCodexUsagePopupData(
  entry: UsageCacheEntry | null,
  now: Date,
): CodexUsagePopupData {
  if (entry === null || entry.snapshot === null) {
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
  };
}
