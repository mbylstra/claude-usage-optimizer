import { describe, expect, it } from 'vitest';
import { formatClockTime, formatClockTimeWithDay } from './formatClockTime';

/**
 * These assertions go through `toLocaleTimeString`, so they compare against the
 * same API rather than hard-coding one locale's output — the behaviour under
 * test is the shape of the string, not Intl itself. The one thing pinned
 * outright is the 12-hour cycle, which is a product decision rather than a
 * locale one.
 */
describe('formatClockTime', () => {
  it('renders hours and minutes in the ambient locale', () => {
    const moment = new Date('2026-08-07T18:00:00.000Z');

    expect(formatClockTime(moment)).toBe(
      moment.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true }),
    );
  });

  it('uses a 12-hour clock even where the locale would default to 24', () => {
    // 13:00 and 01:00 local, which a 24-hour clock would render differently.
    const afternoon = new Date(2026, 7, 7, 13, 0, 0);
    const smallHours = new Date(2026, 7, 7, 1, 0, 0);

    expect(formatClockTime(afternoon)).toContain('1:00');
    expect(formatClockTime(smallHours)).toContain('1:00');
    // Only the meridiem tells them apart.
    expect(formatClockTime(afternoon)).not.toBe(formatClockTime(smallHours));
  });

  it('renders an em dash for an invalid date', () => {
    expect(formatClockTime(new Date('nonsense'))).toBe('—');
  });
});

describe('formatClockTimeWithDay', () => {
  it('omits the weekday when the moment falls on the same calendar day as now', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const moment = new Date(2026, 7, 7, 18, 0, 0);

    expect(formatClockTimeWithDay(moment, now)).toBe(formatClockTime(moment));
  });

  it('names yesterday rather than dating it', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const moment = new Date(2026, 7, 6, 9, 0, 0);

    expect(formatClockTimeWithDay(moment, now)).toBe(`Yesterday, ${formatClockTime(moment)}`);
  });

  it('names tomorrow rather than dating it', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const moment = new Date(2026, 7, 8, 9, 0, 0);

    expect(formatClockTimeWithDay(moment, now)).toBe(`Tomorrow, ${formatClockTime(moment)}`);
  });

  it('counts calendar days, not elapsed hours', () => {
    // Under two hours apart, but on either side of midnight.
    const now = new Date(2026, 7, 7, 0, 30, 0);
    const lateLastNight = new Date(2026, 7, 6, 23, 0, 0);

    expect(formatClockTimeWithDay(lateLastNight, now)).toContain('Yesterday');
  });

  it('prefixes the weekday when the moment is further off than a day', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const moment = new Date(2026, 7, 11, 9, 0, 0);

    const formatted = formatClockTimeWithDay(moment, now);
    expect(formatted).toContain(moment.toLocaleDateString(undefined, { weekday: 'short' }));
    expect(formatted).toContain(formatClockTime(moment));
  });

  it('distinguishes the two ends of a seven-day window, which share a weekday', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const windowStart = new Date(2026, 7, 4, 9, 0, 0);
    const windowReset = new Date(2026, 7, 11, 9, 0, 0);

    // Both are a Tuesday at 9am; only the day number tells them apart.
    expect(formatClockTimeWithDay(windowStart, now)).not.toBe(
      formatClockTimeWithDay(windowReset, now),
    );
  });

  it('distinguishes the same clock time a year apart', () => {
    const now = new Date(2026, 7, 7, 13, 0, 0);
    const sameDayNextYear = new Date(2027, 7, 7, 18, 0, 0);

    expect(formatClockTimeWithDay(sameDayNextYear, now)).not.toBe(formatClockTime(sameDayNextYear));
  });

  it('renders an em dash for an invalid date', () => {
    expect(formatClockTimeWithDay(new Date('nonsense'), new Date())).toBe('—');
  });
});
