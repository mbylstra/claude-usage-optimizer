import { describe, expect, it } from 'vitest';
import { buildUsagePopupData, USAGE_STALE_AFTER_MS } from './usagePopupData';
import type { UsageCacheEntry, UsageSnapshot } from './usageTypes';

const now = new Date('2026-08-07T15:30:00.000Z');

const SNAPSHOT: UsageSnapshot = {
  windows: [
    {
      kind: 'fiveHour',
      utilizationPercent: 42,
      resetsAt: '2026-08-07T18:00:00.000Z',
      startedAt: null,
    },
    {
      kind: 'sevenDay',
      utilizationPercent: 61,
      resetsAt: '2026-08-11T09:00:00.000Z',
      startedAt: null,
    },
  ],
};

function cacheEntry(overrides: Partial<UsageCacheEntry> = {}): UsageCacheEntry {
  return {
    snapshot: SNAPSHOT,
    fetchedAt: '2026-08-07T15:28:00.000Z',
    error: null,
    ...overrides,
  };
}

describe('buildUsagePopupData', () => {
  it('is loading when there is no cache at all', () => {
    expect(buildUsagePopupData(null, now)).toEqual({ state: 'loading' });
  });

  it('is loading when the cache exists but holds neither data nor an error', () => {
    expect(buildUsagePopupData({ snapshot: null, fetchedAt: null, error: null }, now)).toEqual({
      state: 'loading',
    });
  });

  it('is an error only when there is no snapshot to fall back on', () => {
    const data = buildUsagePopupData(
      {
        snapshot: null,
        fetchedAt: null,
        error: { code: 'NOT_LOGGED_IN', message: 'Not logged in to Claude.ai.' },
      },
      now,
    );

    expect(data).toMatchObject({ state: 'error', error: { code: 'NOT_LOGGED_IN' } });
  });

  it('derives every window when a snapshot is present', () => {
    const data = buildUsagePopupData(cacheEntry(), now);

    expect(data.state).toBe('ready');
    if (data.state !== 'ready') return;
    expect(data.windows.map((window) => window.kind)).toEqual(['fiveHour', 'sevenDay']);
    expect(data.fetchedAt.toISOString()).toBe('2026-08-07T15:28:00.000Z');
  });

  it('keeps showing data and reports the refresh error when a refresh fails', () => {
    const data = buildUsagePopupData(
      cacheEntry({ error: { code: 'NETWORK_ERROR', message: 'Could not reach claude.ai.' } }),
      now,
    );

    expect(data.state).toBe('ready');
    if (data.state !== 'ready') return;
    expect(data.refreshError?.code).toBe('NETWORK_ERROR');
    expect(data.windows).toHaveLength(2);
  });

  describe('staleness', () => {
    it('is fresh just inside the stale threshold', () => {
      const fetchedAt = new Date(now.getTime() - USAGE_STALE_AFTER_MS).toISOString();
      const data = buildUsagePopupData(cacheEntry({ fetchedAt }), now);

      expect(data.state === 'ready' && data.isStale).toBe(false);
    });

    it('is stale just past the threshold', () => {
      const fetchedAt = new Date(now.getTime() - USAGE_STALE_AFTER_MS - 1000).toISOString();
      const data = buildUsagePopupData(cacheEntry({ fetchedAt }), now);

      expect(data.state === 'ready' && data.isStale).toBe(true);
    });
  });

  it('falls back to now for an unusable fetchedAt rather than showing a bogus age', () => {
    const data = buildUsagePopupData(cacheEntry({ fetchedAt: 'not a date' }), now);

    expect(data.state === 'ready' && data.fetchedAt.getTime()).toBe(now.getTime());
    expect(data.state === 'ready' && data.isStale).toBe(false);
  });
});
