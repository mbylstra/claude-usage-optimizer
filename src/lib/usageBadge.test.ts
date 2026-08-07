import { describe, expect, it } from 'vitest';
import { deriveBadgeState } from './usageBadge';
import type { UsageSnapshot } from './usageTypes';

const now = new Date('2026-08-08T09:00:00.000Z');

/** A weekly window that is exactly 4/7 elapsed at `now`, i.e. ~57% of the way. */
function snapshotWith(fiveHourPercent: number, sevenDayPercent: number): UsageSnapshot {
  return {
    windows: [
      {
        kind: 'fiveHour',
        utilizationPercent: fiveHourPercent,
        resetsAt: '2026-08-08T12:00:00.000Z',
        startedAt: null,
      },
      {
        kind: 'sevenDay',
        utilizationPercent: sevenDayPercent,
        resetsAt: '2026-08-11T09:00:00.000Z',
        startedAt: null,
      },
    ],
  };
}

describe('deriveBadgeState', () => {
  it('shows the highest utilisation across windows', () => {
    expect(deriveBadgeState(snapshotWith(80, 57), now).text).toBe('80');
    expect(deriveBadgeState(snapshotWith(20, 57), now).text).toBe('57');
  });

  it('rounds the percentage to a whole number', () => {
    expect(deriveBadgeState(snapshotWith(42.6, 10), now).text).toBe('43');
  });

  it('colours by the weekly pace, not the five-hour one', () => {
    // Five-hour is far ahead of pace, weekly is on track -> neutral badge.
    const onTrackWeekly = deriveBadgeState(snapshotWith(99, 57), now);
    // Weekly well ahead of its ~57% even-burn line -> warning badge.
    const aheadWeekly = deriveBadgeState(snapshotWith(0, 90), now);
    // Weekly well behind -> calm badge.
    const behindWeekly = deriveBadgeState(snapshotWith(0, 10), now);

    expect(onTrackWeekly.backgroundColor).not.toBe(aheadWeekly.backgroundColor);
    expect(aheadWeekly.backgroundColor).not.toBe(behindWeekly.backgroundColor);
    expect(onTrackWeekly.backgroundColor).toBe(
      deriveBadgeState(snapshotWith(0, 57), now).backgroundColor,
    );
  });

  it('falls back to the neutral colour when there is no weekly window', () => {
    const badge = deriveBadgeState(
      {
        windows: [
          {
            kind: 'fiveHour',
            utilizationPercent: 42,
            resetsAt: '2026-08-08T12:00:00.000Z',
            startedAt: null,
          },
        ],
      },
      now,
    );

    expect(badge.text).toBe('42');
    expect(badge.backgroundColor).toBe(deriveBadgeState(snapshotWith(0, 57), now).backgroundColor);
  });

  it('describes the usage in the tooltip', () => {
    expect(deriveBadgeState(snapshotWith(80, 57), now).title).toContain('80%');
  });
});
