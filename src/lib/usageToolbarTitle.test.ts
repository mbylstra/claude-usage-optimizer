import { describe, expect, it } from 'vitest';
import { deriveToolbarTitle } from './usageToolbarTitle';
import type { UsageSnapshot } from './usageTypes';

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

describe('deriveToolbarTitle', () => {
  it('names the highest utilisation across windows', () => {
    expect(deriveToolbarTitle(snapshotWith(80, 57))).toContain('80%');
    expect(deriveToolbarTitle(snapshotWith(20, 57))).toContain('57%');
  });

  it('rounds the percentage to a whole number', () => {
    expect(deriveToolbarTitle(snapshotWith(42.6, 10))).toContain('43%');
  });

  it('reports zero for a snapshot with no windows', () => {
    expect(deriveToolbarTitle({ windows: [] })).toContain('0%');
  });
});
