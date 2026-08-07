/**
 * Shared vocabulary for the whole extension. Pure types plus the window-duration
 * table — no browser APIs, no I/O.
 */

export type UsageWindowKind = 'fiveHour' | 'sevenDay' | 'sevenDayOpus';

export const USAGE_WINDOW_KINDS: readonly UsageWindowKind[] = [
  'fiveHour',
  'sevenDay',
  'sevenDayOpus',
];

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;

/**
 * How long each window lasts. The usage API only tells us when a window
 * *resets*, so these durations are what let us derive when it started.
 */
export const USAGE_WINDOW_DURATIONS_MS: Record<UsageWindowKind, number> = {
  fiveHour: 5 * MILLISECONDS_PER_HOUR,
  sevenDay: 7 * MILLISECONDS_PER_DAY,
  sevenDayOpus: 7 * MILLISECONDS_PER_DAY,
};

export const USAGE_WINDOW_LABELS: Record<UsageWindowKind, string> = {
  fiveHour: 'Current session',
  sevenDay: 'This week',
  sevenDayOpus: 'This week (Opus)',
};

export const USAGE_WINDOW_DURATION_LABELS: Record<UsageWindowKind, string> = {
  fiveHour: '5 hours',
  sevenDay: '7 days',
  sevenDayOpus: '7 days',
};

/**
 * One window as reported by the API, after defensive normalisation.
 *
 * `resetsAt` is null when the API omitted it, which we read as "this window is
 * not currently running" rather than as a reset at the epoch.
 *
 * `startedAt` is populated only if the API actually told us when the window
 * began. It usually does not, in which case the pace engine derives the start
 * from `resetsAt` minus the window duration.
 */
export interface UsageWindowSnapshot {
  kind: UsageWindowKind;
  utilizationPercent: number;
  resetsAt: string | null;
  startedAt: string | null;
}

export interface UsageSnapshot {
  windows: UsageWindowSnapshot[];
}

export type PaceStatus = 'ahead' | 'behind' | 'onTrack';

export interface ActiveWindowStatus {
  kind: UsageWindowKind;
  isActive: true;
  windowStartedAt: Date;
  windowResetsAt: Date;
  /** Clamped to >= 0. Zero once the reset time has passed. */
  timeRemainingMs: number;
  /** True when `resetsAt` is already in the past, i.e. the snapshot is stale. */
  hasResetElapsed: boolean;
  percentUsed: number;
  /** Where an even burn would have you at this point in the window. */
  pacePercent: number;
  /** percentUsed - pacePercent. Positive means burning faster than even. */
  paceDeltaPercentagePoints: number;
  /**
   * The same gap expressed as time, which is the form people can act on:
   * how far along the window an even burn would have to travel to reach the
   * usage you have already spent. Positive means ahead of the even burn — you
   * are where you would otherwise be this much later in the window.
   */
  paceDeltaMs: number;
  paceStatus: PaceStatus;
}

export interface InactiveWindowStatus {
  kind: UsageWindowKind;
  isActive: false;
  percentUsed: number;
}

export type DerivedWindowStatus = ActiveWindowStatus | InactiveWindowStatus;

/** Error codes surfaced by the usage client; the popup maps these to copy. */
export type UsageErrorCode =
  'NOT_LOGGED_IN' | 'NO_ORGANIZATIONS' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'MALFORMED_RESPONSE';

export interface UsageErrorInfo {
  code: UsageErrorCode;
  message: string;
  httpStatus?: number;
}

/**
 * What the service worker persists and the popup renders from. Either half may
 * be null on a first run, and a failed refresh keeps the last good snapshot
 * alongside the error rather than blanking it.
 */
export interface UsageCacheEntry {
  snapshot: UsageSnapshot | null;
  fetchedAt: string | null;
  error: UsageErrorInfo | null;
}
