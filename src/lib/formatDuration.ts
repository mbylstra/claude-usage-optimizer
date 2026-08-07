const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

/**
 * A compact span for display: "6d 3h", "2h 14m", "45m", "< 1m".
 *
 * Two units at most — the third never changes a decision and only adds noise.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0m';

  const days = Math.floor(durationMs / MILLISECONDS_PER_DAY);
  const hours = Math.floor((durationMs % MILLISECONDS_PER_DAY) / MILLISECONDS_PER_HOUR);
  const minutes = Math.floor((durationMs % MILLISECONDS_PER_HOUR) / MILLISECONDS_PER_MINUTE);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '< 1m';
}

/**
 * A pace gap, which wants a coarser unit than a countdown does: once the gap
 * passes a day it reads in days alone — "2.9d", "3d" — and only below a day does
 * it fall back to hours and minutes.
 *
 * Only the weekly windows can produce a gap of a day or more (a five-hour window
 * cannot be more than five hours off an even burn), so this needs no per-window
 * branching — the magnitude picks the unit on its own.
 */
export function formatPaceGap(gapMs: number): string {
  const magnitude = Math.abs(gapMs);
  if (!Number.isFinite(magnitude) || magnitude < MILLISECONDS_PER_DAY) {
    return formatDuration(magnitude);
  }

  // One decimal place: whole days alone would round 2d 21h down to "2d", which
  // is most of a day of headroom thrown away.
  const days = (magnitude / MILLISECONDS_PER_DAY).toFixed(1);
  return `${days.endsWith('.0') ? days.slice(0, -2) : days}d`;
}

/**
 * "updated 2m ago" style freshness text for the cached snapshot.
 */
export function formatTimeAgo(pastMoment: Date, now: Date): string {
  const elapsedMs = now.getTime() - pastMoment.getTime();
  if (!Number.isFinite(elapsedMs)) return 'unknown';
  if (elapsedMs < MILLISECONDS_PER_MINUTE) return 'just now';
  return `${formatDuration(elapsedMs)} ago`;
}
