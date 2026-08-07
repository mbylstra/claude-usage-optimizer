/**
 * Wall-clock formatting in the viewer's own locale and timezone. `now` is passed
 * in so "is this today?" is decidable without reading the clock.
 */

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** "6:00 PM" */
export function formatClockTime(moment: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';
  return moment.toLocaleTimeString(undefined, TIME_FORMAT);
}

/**
 * "6:00 PM" for today, "Tue 4, 9:00 AM" otherwise.
 *
 * The day number is not decoration: a seven-day window starts and ends on the
 * same weekday, so "Tue" alone would render a window's start and its reset
 * identically.
 */
export function formatClockTimeWithDay(moment: Date, now: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';

  const isSameCalendarDay =
    moment.getFullYear() === now.getFullYear() &&
    moment.getMonth() === now.getMonth() &&
    moment.getDate() === now.getDate();

  if (isSameCalendarDay) return formatClockTime(moment);

  const day = moment.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `${day}, ${formatClockTime(moment)}`;
}
