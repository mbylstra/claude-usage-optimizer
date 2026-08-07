import { describe, expect, it } from 'vitest';
import {
  deriveUsageStatuses,
  deriveWindowStatus,
  highestUtilizationPercent,
  PACE_TOLERANCE_PERCENTAGE_POINTS,
} from './usagePace';
import type { ActiveWindowStatus, UsageWindowSnapshot } from './usageTypes';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** A five-hour window resetting at 18:00, i.e. one that started at 13:00. */
function fiveHourSnapshot(overrides: Partial<UsageWindowSnapshot> = {}): UsageWindowSnapshot {
  return {
    kind: 'fiveHour',
    utilizationPercent: 0,
    resetsAt: '2026-08-07T18:00:00.000Z',
    startedAt: null,
    ...overrides,
  };
}

function expectActive(status: ReturnType<typeof deriveWindowStatus>): ActiveWindowStatus {
  if (!status.isActive) throw new Error('expected an active window status');
  return status;
}

describe('deriveWindowStatus', () => {
  it('derives the window start as resetsAt minus the window duration', () => {
    const status = expectActive(
      deriveWindowStatus(fiveHourSnapshot(), new Date('2026-08-07T15:30:00.000Z')),
    );

    expect(status.windowStartedAt.toISOString()).toBe('2026-08-07T13:00:00.000Z');
    expect(status.windowResetsAt.toISOString()).toBe('2026-08-07T18:00:00.000Z');
  });

  it('prefers a window start reported by the API over the derived one', () => {
    const status = expectActive(
      deriveWindowStatus(
        fiveHourSnapshot({ startedAt: '2026-08-07T14:00:00.000Z', utilizationPercent: 50 }),
        new Date('2026-08-07T16:00:00.000Z'),
      ),
    );

    expect(status.windowStartedAt.toISOString()).toBe('2026-08-07T14:00:00.000Z');
    // Half of a 14:00 -> 18:00 window has elapsed, so an even burn is 50%.
    expect(status.pacePercent).toBe(50);
    expect(status.paceStatus).toBe('onTrack');
  });

  it('computes pace as the fraction of the window elapsed', () => {
    // 13:00 start, 18:00 reset, now 15:30 -> half way.
    const status = expectActive(
      deriveWindowStatus(
        fiveHourSnapshot({ utilizationPercent: 50 }),
        new Date('2026-08-07T15:30:00.000Z'),
      ),
    );

    expect(status.pacePercent).toBe(50);
    expect(status.paceDeltaPercentagePoints).toBe(0);
    expect(status.paceDeltaMs).toBe(0);
    expect(status.paceStatus).toBe('onTrack');
  });

  it('scales the pace gap in time to the length of the window', () => {
    // The same 20-point gap, on a seven-day window, is a day and a half — which
    // is exactly why the indicator quotes time rather than points.
    const status = expectActive(
      deriveWindowStatus(
        {
          kind: 'sevenDay',
          utilizationPercent: 70,
          resetsAt: '2026-08-11T09:00:00.000Z',
          startedAt: '2026-08-04T09:00:00.000Z',
        },
        new Date('2026-08-07T21:00:00.000Z'),
      ),
    );

    expect(status.pacePercent).toBe(50);
    expect(status.paceDeltaMs).toBe(0.2 * SEVEN_DAYS_MS);
  });

  it('reports time remaining until the reset', () => {
    const status = expectActive(
      deriveWindowStatus(fiveHourSnapshot(), new Date('2026-08-07T15:45:00.000Z')),
    );

    expect(status.timeRemainingMs).toBe(2 * 60 * 60 * 1000 + 15 * 60 * 1000);
    expect(status.hasResetElapsed).toBe(false);
  });

  describe('pace classification', () => {
    it('is "ahead" when usage outruns elapsed time by more than the tolerance', () => {
      const status = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ utilizationPercent: 70 }),
          new Date('2026-08-07T15:30:00.000Z'),
        ),
      );

      expect(status.paceDeltaPercentagePoints).toBe(20);
      // 20 points of a five-hour window is an hour of burn brought forward.
      expect(status.paceDeltaMs).toBe(60 * 60 * 1000);
      expect(status.paceStatus).toBe('ahead');
    });

    it('is "behind" when usage trails elapsed time by more than the tolerance', () => {
      const status = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ utilizationPercent: 30 }),
          new Date('2026-08-07T15:30:00.000Z'),
        ),
      );

      expect(status.paceDeltaPercentagePoints).toBe(-20);
      expect(status.paceDeltaMs).toBe(-60 * 60 * 1000);
      expect(status.paceStatus).toBe('behind');
    });

    it('stays "onTrack" exactly at the tolerance boundary in both directions', () => {
      const halfWay = new Date('2026-08-07T15:30:00.000Z');

      const atUpperBound = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ utilizationPercent: 50 + PACE_TOLERANCE_PERCENTAGE_POINTS }),
          halfWay,
        ),
      );
      const atLowerBound = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ utilizationPercent: 50 - PACE_TOLERANCE_PERCENTAGE_POINTS }),
          halfWay,
        ),
      );

      expect(atUpperBound.paceStatus).toBe('onTrack');
      expect(atLowerBound.paceStatus).toBe('onTrack');
    });

    it('tips over to ahead/behind just past the tolerance boundary', () => {
      const halfWay = new Date('2026-08-07T15:30:00.000Z');

      expect(
        expectActive(deriveWindowStatus(fiveHourSnapshot({ utilizationPercent: 55.1 }), halfWay))
          .paceStatus,
      ).toBe('ahead');
      expect(
        expectActive(deriveWindowStatus(fiveHourSnapshot({ utilizationPercent: 44.9 }), halfWay))
          .paceStatus,
      ).toBe('behind');
    });
  });

  describe('window boundaries', () => {
    it('reports 0% pace at the very start of the window', () => {
      const status = expectActive(
        deriveWindowStatus(fiveHourSnapshot(), new Date('2026-08-07T13:00:00.000Z')),
      );

      expect(status.pacePercent).toBe(0);
      expect(status.timeRemainingMs).toBe(FIVE_HOURS_MS);
    });

    it('reports 100% pace and no time left at the reset moment', () => {
      const status = expectActive(
        deriveWindowStatus(fiveHourSnapshot(), new Date('2026-08-07T18:00:00.000Z')),
      );

      expect(status.pacePercent).toBe(100);
      expect(status.timeRemainingMs).toBe(0);
      expect(status.hasResetElapsed).toBe(true);
    });

    it('clamps a window whose reset is already in the past', () => {
      const status = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ utilizationPercent: 80 }),
          new Date('2026-08-07T21:00:00.000Z'),
        ),
      );

      expect(status.pacePercent).toBe(100);
      expect(status.timeRemainingMs).toBe(0);
      expect(status.hasResetElapsed).toBe(true);
      expect(status.paceDeltaPercentagePoints).toBe(-20);
    });

    it('clamps a clock that predates the derived window start', () => {
      const status = expectActive(
        deriveWindowStatus(fiveHourSnapshot(), new Date('2026-08-07T10:00:00.000Z')),
      );

      expect(status.pacePercent).toBe(0);
    });
  });

  describe('defensive handling', () => {
    it('treats a missing resetsAt as an inactive window', () => {
      const status = deriveWindowStatus(
        fiveHourSnapshot({ resetsAt: null, utilizationPercent: 12 }),
        new Date('2026-08-07T15:30:00.000Z'),
      );

      expect(status.isActive).toBe(false);
      expect(status.percentUsed).toBe(12);
    });

    it('treats an unparseable resetsAt as an inactive window', () => {
      const status = deriveWindowStatus(
        fiveHourSnapshot({ resetsAt: 'not a date' }),
        new Date('2026-08-07T15:30:00.000Z'),
      );

      expect(status.isActive).toBe(false);
    });

    it('ignores an unparseable startedAt and falls back to the derived start', () => {
      const status = expectActive(
        deriveWindowStatus(
          fiveHourSnapshot({ startedAt: 'nonsense' }),
          new Date('2026-08-07T15:30:00.000Z'),
        ),
      );

      expect(status.windowStartedAt.toISOString()).toBe('2026-08-07T13:00:00.000Z');
    });

    it('clamps utilisation into 0..100', () => {
      const now = new Date('2026-08-07T15:30:00.000Z');

      expect(
        expectActive(deriveWindowStatus(fiveHourSnapshot({ utilizationPercent: 140 }), now))
          .percentUsed,
      ).toBe(100);
      expect(
        expectActive(deriveWindowStatus(fiveHourSnapshot({ utilizationPercent: -8 }), now))
          .percentUsed,
      ).toBe(0);
      expect(
        expectActive(deriveWindowStatus(fiveHourSnapshot({ utilizationPercent: Number.NaN }), now))
          .percentUsed,
      ).toBe(0);
    });
  });

  it('uses the seven-day duration for weekly windows', () => {
    const status = expectActive(
      deriveWindowStatus(
        {
          kind: 'sevenDay',
          utilizationPercent: 61,
          resetsAt: '2026-08-11T09:00:00.000Z',
          startedAt: null,
        },
        new Date('2026-08-08T09:00:00.000Z'),
      ),
    );

    expect(status.windowStartedAt.toISOString()).toBe('2026-08-04T09:00:00.000Z');
    expect(status.windowResetsAt.getTime() - status.windowStartedAt.getTime()).toBe(SEVEN_DAYS_MS);
    // 4 of 7 days elapsed.
    expect(status.pacePercent).toBeCloseTo((4 / 7) * 100, 6);
  });
});

describe('deriveUsageStatuses', () => {
  it('derives every window in a snapshot, preserving order', () => {
    const statuses = deriveUsageStatuses(
      {
        windows: [
          fiveHourSnapshot({ utilizationPercent: 42 }),
          {
            kind: 'sevenDay',
            utilizationPercent: 61,
            resetsAt: '2026-08-11T09:00:00.000Z',
            startedAt: null,
          },
        ],
      },
      new Date('2026-08-07T15:30:00.000Z'),
    );

    expect(statuses.map((status) => status.kind)).toEqual(['fiveHour', 'sevenDay']);
  });
});

describe('highestUtilizationPercent', () => {
  it('returns the largest utilisation across all windows', () => {
    expect(
      highestUtilizationPercent({
        windows: [
          fiveHourSnapshot({ utilizationPercent: 42 }),
          fiveHourSnapshot({ kind: 'sevenDay', utilizationPercent: 61 }),
          fiveHourSnapshot({ kind: 'sevenDayOpus', utilizationPercent: 12 }),
        ],
      }),
    ).toBe(61);
  });

  it('is 0 for an empty snapshot', () => {
    expect(highestUtilizationPercent({ windows: [] })).toBe(0);
  });
});
