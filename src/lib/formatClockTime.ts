/**
 * Wall-clock formatting in the viewer's own locale and timezone, always on a
 * 12-hour clock. `now` is passed in so "is this today?" is decidable without
 * reading the clock.
 */

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "6pm" or "6:30pm" — omit :00 minutes, and set the meridiem tight against the
 * hour in lower case so it reads as one token rather than two words.
 */
export function formatClockTime(moment: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';

  const parts = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(moment);

  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  const meridiem = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();

  if (minute === '00') return `${hour}${meridiem}`;
  return `${hour}:${minute}${meridiem}`;
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
 * "6pm" for today, "Yesterday, 9am" / "Tomorrow, 9am" for the days either side,
 * and "Tue, 9am" beyond that.
 *
 * Deliberately no calendar date. A weekday and a time is what you need to plan
 * around a reset; the number is one more thing to read past. The cost is that a
 * seven-day window — which begins and ends on the same weekday — can render its
 * start and its reset identically, so the two are told apart by their labels.
 */
export function formatClockTimeWithDay(moment: Date, now: Date): string {
  if (Number.isNaN(moment.getTime())) return '—';

  const daysApart = calendarDaysApart(moment, now);
  if (daysApart === 0) return formatClockTime(moment);
  if (daysApart === -1) return `Yesterday, ${formatClockTime(moment)}`;
  if (daysApart === 1) return `Tomorrow, ${formatClockTime(moment)}`;

  const weekday = moment.toLocaleDateString(undefined, { weekday: 'short' });
  return `${weekday}, ${formatClockTime(moment)}`;
}
