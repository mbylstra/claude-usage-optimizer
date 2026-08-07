import { describe, expect, it } from 'vitest';
import { formatDuration, formatPaceGap, formatTimeAgo } from './formatDuration';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(2 * HOUR + 14 * MINUTE)).toBe('2h 14m');
  });

  it('drops the minutes component when it is zero', () => {
    expect(formatDuration(3 * HOUR)).toBe('3h');
  });

  it('formats minutes alone under an hour', () => {
    expect(formatDuration(45 * MINUTE)).toBe('45m');
  });

  it('formats days and hours, never descending to minutes', () => {
    expect(formatDuration(6 * DAY + 3 * HOUR + 59 * MINUTE)).toBe('6d 3h');
    expect(formatDuration(2 * DAY)).toBe('2d');
  });

  it('reports sub-minute spans as "< 1m"', () => {
    expect(formatDuration(30 * 1000)).toBe('< 1m');
  });

  it('reports zero and negative spans as "0m"', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-5000)).toBe('0m');
  });

  it('is safe with non-finite input', () => {
    expect(formatDuration(Number.NaN)).toBe('0m');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0m');
  });
});

describe('formatPaceGap', () => {
  it('uses days alone once the gap reaches a day', () => {
    expect(formatPaceGap(2 * DAY + 21 * HOUR)).toBe('2.9d');
    expect(formatPaceGap(DAY)).toBe('1d');
  });

  it('drops a trailing ".0" rather than saying "3.0d"', () => {
    expect(formatPaceGap(3 * DAY + 2 * MINUTE)).toBe('3d');
  });

  it('falls back to hours and minutes below a day', () => {
    expect(formatPaceGap(23 * HOUR + 30 * MINUTE)).toBe('23h 30m');
    expect(formatPaceGap(36 * MINUTE)).toBe('36m');
  });

  it('reads the magnitude, so direction is the caller’s business', () => {
    expect(formatPaceGap(-(2 * DAY + 12 * HOUR))).toBe('2.5d');
    expect(formatPaceGap(-(90 * MINUTE))).toBe('1h 30m');
  });

  it('is safe with non-finite input', () => {
    expect(formatPaceGap(Number.NaN)).toBe('0m');
    expect(formatPaceGap(Number.POSITIVE_INFINITY)).toBe('0m');
  });
});

describe('formatTimeAgo', () => {
  const now = new Date('2026-08-07T15:30:00.000Z');

  it('says "just now" within the first minute', () => {
    expect(formatTimeAgo(new Date('2026-08-07T15:29:30.000Z'), now)).toBe('just now');
  });

  it('formats older timestamps as an elapsed span', () => {
    expect(formatTimeAgo(new Date('2026-08-07T15:28:00.000Z'), now)).toBe('2m ago');
    expect(formatTimeAgo(new Date('2026-08-07T13:16:00.000Z'), now)).toBe('2h 14m ago');
  });

  it('treats a future timestamp as "just now" rather than a negative span', () => {
    expect(formatTimeAgo(new Date('2026-08-07T15:31:00.000Z'), now)).toBe('just now');
  });
});
