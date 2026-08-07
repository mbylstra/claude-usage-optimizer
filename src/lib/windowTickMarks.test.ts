import { describe, expect, it } from 'vitest';
import { deriveWindowStatus } from './usagePace';
import type { ActiveWindowStatus, UsageWindowKind } from './usageTypes';
import { buildWindowTickMarks } from './windowTickMarks';

const now = new Date('2026-08-07T15:30:00.000Z');

/**
 * Ticks are read off a derived status, so the fixtures go through the real pace
 * engine rather than hand-writing an `ActiveWindowStatus`.
 */
function activeStatus(
  kind: UsageWindowKind,
  resetsAt: string,
  startedAt: string | null = null,
): ActiveWindowStatus {
  const status = deriveWindowStatus({ kind, utilizationPercent: 50, resetsAt, startedAt }, now);
  if (!status.isActive) throw new Error('expected an active window');
  return status;
}

describe('buildWindowTickMarks', () => {
  it('marks each interior hour of a five-hour window', () => {
    const tickMarks = buildWindowTickMarks(activeStatus('fiveHour', '2026-08-07T18:00:00.000Z'));

    expect(tickMarks.map((tickMark) => tickMark.label)).toEqual(['1h', '2h', '3h', '4h']);
    expect(tickMarks.map((tickMark) => tickMark.positionPercent)).toEqual([20, 40, 60, 80]);
  });

  it('marks each interior day of a weekly window', () => {
    const tickMarks = buildWindowTickMarks(activeStatus('sevenDay', '2026-08-11T09:00:00.000Z'));

    expect(tickMarks.map((tickMark) => tickMark.label)).toEqual(['1d', '2d', '3d', '4d', '5d', '6d']);
    expect(tickMarks[0].positionPercent).toBeCloseTo(100 / 7);
  });

  it('marks the Opus weekly window in days too', () => {
    const tickMarks = buildWindowTickMarks(activeStatus('sevenDayOpus', '2026-08-11T09:00:00.000Z'));

    expect(tickMarks).toHaveLength(6);
    expect(tickMarks.at(-1)?.label).toBe('6d');
  });

  it('never places a tick on either end of the bar', () => {
    const tickMarks = buildWindowTickMarks(activeStatus('fiveHour', '2026-08-07T18:00:00.000Z'));

    for (const tickMark of tickMarks) {
      expect(tickMark.positionPercent).toBeGreaterThan(0);
      expect(tickMark.positionPercent).toBeLessThan(100);
    }
  });

  it('spaces ticks by the reported span when the API gives both ends', () => {
    // A six-hour window rather than the nominal five: five interior hour ticks,
    // evenly spaced across the real span.
    const tickMarks = buildWindowTickMarks(
      activeStatus('fiveHour', '2026-08-07T18:00:00.000Z', '2026-08-07T12:00:00.000Z'),
    );

    expect(tickMarks.map((tickMark) => tickMark.label)).toEqual(['1h', '2h', '3h', '4h', '5h']);
    expect(tickMarks[0].positionPercent).toBeCloseTo(100 / 6);
  });

  it('leaves a partial final segment when the span is not a whole number of units', () => {
    // 2h30m long: one tick at the hour, and no tick for the half hour after it.
    const tickMarks = buildWindowTickMarks(
      activeStatus('fiveHour', '2026-08-07T18:00:00.000Z', '2026-08-07T15:30:00.000Z'),
    );

    expect(tickMarks.map((tickMark) => tickMark.label)).toEqual(['1h', '2h']);
  });

  it('returns no ticks for a window shorter than one unit', () => {
    expect(buildWindowTickMarks(
      activeStatus('sevenDay', '2026-08-07T18:00:00.000Z', '2026-08-07T15:00:00.000Z'),
    )).toEqual([]);
  });

  it('returns no ticks rather than a smear for an implausibly long window', () => {
    // A malformed span is the only way to get here — two months of daily ticks
    // is not a scale anyone can read.
    expect(
      buildWindowTickMarks(
        activeStatus('sevenDay', '2026-09-30T09:00:00.000Z', '2026-08-07T09:00:00.000Z'),
      ),
    ).toEqual([]);
  });
});
