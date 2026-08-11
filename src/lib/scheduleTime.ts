/**
 * The local wall-clock time the nightly autonomous-work run is scheduled for.
 *
 * Stored as hour and minute rather than as a `Date` or an ISO string because
 * that is what launchd's `StartCalendarInterval` wants, and because "2 AM every
 * day" is not a moment in time — it survives daylight saving, which an offset
 * from a fixed instant would not.
 */

export interface ScheduleTime {
  /** 0–23, local time. */
  hour: number;
  /** 0–59. */
  minute: number;
}

export const DEFAULT_SCHEDULE_TIME: ScheduleTime = { hour: 2, minute: 0 };

function isWholeNumberWithin(value: unknown, upperBound: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= upperBound;
}

/** Anything stored or sent that is not a real clock time falls back to the default. */
export function normaliseScheduleTime(value: unknown): ScheduleTime {
  if (typeof value !== 'object' || value === null) return DEFAULT_SCHEDULE_TIME;

  const { hour, minute } = value as { hour?: unknown; minute?: unknown };
  if (!isWholeNumberWithin(hour, 23) || !isWholeNumberWithin(minute, 59)) {
    return DEFAULT_SCHEDULE_TIME;
  }

  return { hour, minute };
}

/** `"02:00"` — the `value` an `<input type="time">` expects and produces. */
export function formatScheduleTimeInputValue(scheduleTime: ScheduleTime): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(scheduleTime.hour)}:${pad(scheduleTime.minute)}`;
}

/**
 * Read an `<input type="time">` value back, or null if it is not a complete
 * time — a half-typed field reports `""`, which is not a change to save.
 */
export function parseScheduleTimeInputValue(value: string): ScheduleTime | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!isWholeNumberWithin(hour, 23) || !isWholeNumberWithin(minute, 59)) return null;

  return { hour, minute };
}

/** "2 AM" or "2:30 AM" — for prose, where a bare `02:00` reads like a build artefact. */
export function describeScheduleTime(scheduleTime: ScheduleTime): string {
  const meridiem = scheduleTime.hour < 12 ? 'AM' : 'PM';
  const twelveHour = scheduleTime.hour % 12 === 0 ? 12 : scheduleTime.hour % 12;
  const minutes =
    scheduleTime.minute === 0 ? '' : `:${String(scheduleTime.minute).padStart(2, '0')}`;
  return `${twelveHour}${minutes} ${meridiem}`;
}
