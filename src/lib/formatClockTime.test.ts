import { describe, expect, it } from 'vitest';
import { formatClockTime, formatClockTimeWithDay } from './formatClockTime';

/**
 * These assertions go through `toLocaleTimeString`, so they compare against the
 * same API rather than hard-coding one locale's output — the behaviour under
 * test is the shape of the string, not Intl itself.
 */
describe('formatClockTime', () => {
  it('renders hours and minutes in the ambient locale', () => {
    const moment = new Date('2026-08-07T18:00:00.000Z');

    expect(formatClockTime(moment)).toBe(
      moment.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    );
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

  it('prefixes the weekday when the moment is on another day', () => {
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
