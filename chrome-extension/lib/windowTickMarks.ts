import type { ActiveWindowStatus, UsageWindowKind } from './usageTypes';

/**
 * The scale printed along a usage bar: one tick per hour of a five-hour session,
 * one per day of a weekly window.
 *
 * Without them the bar is a blank strip and the even-burn line has nothing to be
 * read against; with them you can see at a glance that the line sits "three
 * hours in" rather than merely "somewhere past the middle".
 *
 * Positions are derived from the window's *actual* span rather than the nominal
 * 5h / 7d, for the same reason `deriveWindowStatus` prefers it: if the API ever
 * reports a window that ran long or short, the ticks still land on real hour and
 * day boundaries and the last segment is simply a partial one.
 */

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

interface TickInterval {
  intervalMs: number;
  /** Appended to the elapsed count, e.g. `3` + `h` -> "3h". */
  unitSuffix: string;
}

const TICK_INTERVALS: Record<UsageWindowKind, TickInterval> = {
  fiveHour: { intervalMs: MILLISECONDS_PER_HOUR, unitSuffix: 'h' },
  sevenDay: { intervalMs: MILLISECONDS_PER_DAY, unitSuffix: 'd' },
  sevenDayOpus: { intervalMs: MILLISECONDS_PER_DAY, unitSuffix: 'd' },
};

/**
 * Past this many ticks the bar is a smear rather than a scale, so a window long
 * enough to need them gets none at all. Only a malformed reset time can get
 * here — seven daily ticks is the most any real window produces.
 */
const MAXIMUM_TICK_MARK_COUNT = 12;

export interface WindowTickMark {
  /**
   * Where the tick sits along the bar, 0–100. Always strictly between the two
   * ends: the window's own edges are drawn by the bar, not by a tick.
   */
  positionPercent: number;
  /** How far into the window the tick falls — "3h", "2d". */
  label: string;
}

export function buildWindowTickMarks(status: ActiveWindowStatus): WindowTickMark[] {
  const { intervalMs, unitSuffix } = TICK_INTERVALS[status.kind];
  const windowDurationMs = status.windowResetsAt.getTime() - status.windowStartedAt.getTime();

  if (!Number.isFinite(windowDurationMs) || windowDurationMs <= intervalMs) return [];
  if (Math.ceil(windowDurationMs / intervalMs) - 1 > MAXIMUM_TICK_MARK_COUNT) return [];

  const tickMarks: WindowTickMark[] = [];
  for (let elapsedMs = intervalMs; elapsedMs < windowDurationMs; elapsedMs += intervalMs) {
    tickMarks.push({
      positionPercent: (elapsedMs / windowDurationMs) * 100,
      label: `${elapsedMs / intervalMs}${unitSuffix}`,
    });
  }
  return tickMarks;
}
