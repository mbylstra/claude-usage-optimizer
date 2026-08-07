/**
 * Wall-clock formatting in the viewer's own locale and timezone, always on a
 * 12-hour clock. `now` is passed in so "is this today?" is decidable without
 * reading the clock.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

/** "6:00 PM" */
export function formatClockTime(moment: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';
  return moment.toLocaleTimeString(undefined, TIME_FORMAT);
}

function startOfCalendarDay(moment: Date): Date {
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate());
}

/**
 * Whole calendar days from `now` to `moment` — negative for the past.
 *
 * Rounded rather than truncated because a day spanning a daylight-saving change
 * is 23 or 25 hours long, and yesterday must still come out as exactly -1.
 */
function calendarDaysApart(moment: Date, now: Date): number {
  const millisecondsApart =
    startOfCalendarDay(moment).getTime() - startOfCalendarDay(now).getTime();
  return Math.round(millisecondsApart / MILLISECONDS_PER_DAY);
}

/**
 * "6:00 PM" for today, "Yesterday, 9:00 AM" / "Tomorrow, 9:00 AM" for the days
 * either side, and "Tue 4, 9:00 AM" beyond that.
 *
 * The day number is not decoration: a seven-day window starts and ends on the
 * same weekday, so "Tue" alone would render a window's start and its reset
 * identically. Yesterday and tomorrow need no such disambiguation, and reading
 * them as words is faster than counting back from a date.
 */
export function formatClockTimeWithDay(moment: Date, now: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';

  const daysApart = calendarDaysApart(moment, now);
  if (daysApart === 0) return formatClockTime(moment);
  if (daysApart === -1) return `Yesterday, ${formatClockTime(moment)}`;
  if (daysApart === 1) return `Tomorrow, ${formatClockTime(moment)}`;

  const day = moment.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `${day}, ${formatClockTime(moment)}`;
}
