import { deriveWindowStatus } from '@/lib/usagePace';
import type { DerivedWindowStatus, UsageCacheEntry, UsageWindowKind } from '@/lib/usageTypes';

/**
 * Fixtures for Storybook. Built by running real snapshots through the real pace
 * engine rather than by hand-writing `DerivedWindowStatus` objects, so a story
 * cannot drift into a state the engine would never actually produce.
 */

/** A fixed clock so stories are deterministic. Mid-afternoon on a Friday. */
export const FIXTURE_NOW = new Date('2026-08-07T15:30:00.000Z');

/** Resets at 18:00, so at FIXTURE_NOW the window is exactly half elapsed. */
const FIVE_HOUR_RESETS_AT = '2026-08-07T18:00:00.000Z';

/**
 * Runs from the 4th to the 11th, so at FIXTURE_NOW just under 47% of the week
 * has elapsed. The "on pace" figures below are chosen against that number.
 */
const SEVEN_DAY_RESETS_AT = '2026-08-11T09:00:00.000Z';

const RESETS_AT_BY_KIND: Record<UsageWindowKind, string> = {
  fiveHour: FIVE_HOUR_RESETS_AT,
  sevenDay: SEVEN_DAY_RESETS_AT,
  sevenDayOpus: SEVEN_DAY_RESETS_AT,
};

export function windowStatusFixture(
  kind: UsageWindowKind,
  utilizationPercent: number,
  overrides: { resetsAt?: string | null } = {},
): DerivedWindowStatus {
  return deriveWindowStatus(
    {
      kind,
      utilizationPercent,
      resetsAt: overrides.resetsAt === undefined ? RESETS_AT_BY_KIND[kind] : overrides.resetsAt,
      startedAt: null,
    },
    FIXTURE_NOW,
  );
}

/** Five-hour window at its even-burn point. */
export const FIVE_HOUR_ON_PACE = windowStatusFixture('fiveHour', 50);
export const FIVE_HOUR_AHEAD = windowStatusFixture('fiveHour', 78);
export const FIVE_HOUR_BEHIND = windowStatusFixture('fiveHour', 22);
export const FIVE_HOUR_INACTIVE = windowStatusFixture('fiveHour', 0, { resetsAt: null });
/** Reset time already passed — the snapshot predates a reset. */
export const FIVE_HOUR_RESETTING = windowStatusFixture('fiveHour', 92, {
  resetsAt: '2026-08-07T15:29:00.000Z',
});

export const SEVEN_DAY_ON_PACE = windowStatusFixture('sevenDay', 47);
export const SEVEN_DAY_AHEAD = windowStatusFixture('sevenDay', 88);
export const SEVEN_DAY_BEHIND = windowStatusFixture('sevenDay', 24);

export const SEVEN_DAY_OPUS_BEHIND = windowStatusFixture('sevenDayOpus', 12);

function cacheEntry(
  windows: { kind: UsageWindowKind; utilizationPercent: number }[],
  overrides: Partial<UsageCacheEntry> = {},
): UsageCacheEntry {
  return {
    snapshot: {
      windows: windows.map(({ kind, utilizationPercent }) => ({
        kind,
        utilizationPercent,
        resetsAt: RESETS_AT_BY_KIND[kind],
        startedAt: null,
      })),
    },
    fetchedAt: '2026-08-07T15:28:00.000Z',
    error: null,
    ...overrides,
  };
}

export const ON_PACE_CACHE_ENTRY = cacheEntry([
  { kind: 'fiveHour', utilizationPercent: 50 },
  { kind: 'sevenDay', utilizationPercent: 47 },
  { kind: 'sevenDayOpus', utilizationPercent: 44 },
]);

export const AHEAD_OF_PACE_CACHE_ENTRY = cacheEntry([
  { kind: 'fiveHour', utilizationPercent: 84 },
  { kind: 'sevenDay', utilizationPercent: 91 },
  { kind: 'sevenDayOpus', utilizationPercent: 77 },
]);

export const BEHIND_PACE_CACHE_ENTRY = cacheEntry([
  { kind: 'fiveHour', utilizationPercent: 18 },
  { kind: 'sevenDay', utilizationPercent: 25 },
  { kind: 'sevenDayOpus', utilizationPercent: 4 },
]);

/** Fetched over an hour ago — old enough for the popup to say so. */
export const STALE_CACHE_ENTRY = cacheEntry(
  [
    { kind: 'fiveHour', utilizationPercent: 50 },
    { kind: 'sevenDay', utilizationPercent: 47 },
  ],
  { fetchedAt: '2026-08-07T14:05:00.000Z' },
);

/** The last refresh failed, but yesterday's numbers are still worth showing. */
export const REFRESH_FAILED_CACHE_ENTRY = cacheEntry(
  [
    { kind: 'fiveHour', utilizationPercent: 50 },
    { kind: 'sevenDay', utilizationPercent: 47 },
  ],
  {
    fetchedAt: '2026-08-07T14:05:00.000Z',
    error: { code: 'NETWORK_ERROR', message: 'Could not reach claude.ai.' },
  },
);

/** A weekly window that has not started yet, alongside an active five-hour one. */
export const INACTIVE_WINDOW_CACHE_ENTRY: UsageCacheEntry = {
  snapshot: {
    windows: [
      {
        kind: 'fiveHour',
        utilizationPercent: 8,
        resetsAt: FIVE_HOUR_RESETS_AT,
        startedAt: null,
      },
      { kind: 'sevenDay', utilizationPercent: 0, resetsAt: null, startedAt: null },
    ],
  },
  fetchedAt: '2026-08-07T15:28:00.000Z',
  error: null,
};

export const LOGGED_OUT_CACHE_ENTRY: UsageCacheEntry = {
  snapshot: null,
  fetchedAt: null,
  error: { code: 'NOT_LOGGED_IN', message: 'Not logged in to Claude.ai.', httpStatus: 401 },
};

export const NETWORK_ERROR_CACHE_ENTRY: UsageCacheEntry = {
  snapshot: null,
  fetchedAt: null,
  error: { code: 'NETWORK_ERROR', message: 'Could not reach claude.ai.' },
};
