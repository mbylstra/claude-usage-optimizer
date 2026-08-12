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

const MILLISECONDS_PER_MINUTE = 60 * 1000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
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

/** How loudly a pace gap deserves to be flagged. `none` is the neutral case. */
export type PaceSeverity = 'none' | 'slight' | 'moderate' | 'severe';

export interface PaceSeverityThresholdsMs {
  slight: number;
  moderate: number;
  severe: number;
}

const FIVE_HOUR_PACE_SEVERITY_THRESHOLDS_MS: PaceSeverityThresholdsMs = {
  slight: 15 * MILLISECONDS_PER_MINUTE,
  moderate: 30 * MILLISECONDS_PER_MINUTE,
  severe: 60 * MILLISECONDS_PER_MINUTE,
};

const WEEKLY_PACE_SEVERITY_THRESHOLDS_MS: PaceSeverityThresholdsMs = {
  slight: 12 * MILLISECONDS_PER_HOUR,
  moderate: 24 * MILLISECONDS_PER_HOUR,
  severe: 48 * MILLISECONDS_PER_HOUR,
};

/**
 * How far off an even burn you have to be before the gap is worth flagging, and
 * how hard.
 *
 * These are wall-clock spans rather than percentage points because that is the
 * only way the two window lengths can be judged on the same scale: a quarter of
 * an hour is a real dent in a five-hour session and nothing at all across a
 * week. An hour ahead in a five-hour window, or two days ahead in a week, is the
 * point at which you are genuinely going to run out early.
 */
export const PACE_SEVERITY_THRESHOLDS_MS: Record<UsageWindowKind, PaceSeverityThresholdsMs> = {
  fiveHour: FIVE_HOUR_PACE_SEVERITY_THRESHOLDS_MS,
  sevenDay: WEEKLY_PACE_SEVERITY_THRESHOLDS_MS,
  sevenDayOpus: WEEKLY_PACE_SEVERITY_THRESHOLDS_MS,
};

/**
 * How much headroom counts as *comfortably* under an even burn — the point at
 * which a window goes green rather than staying the plain blue of "fine".
 *
 * One spare unit of the window's own scale: an hour of a five-hour session, a
 * day of a week. Below that the headroom is real but not yet worth celebrating,
 * which is why this is its own threshold rather than a rung of
 * `PACE_SEVERITY_THRESHOLDS_MS` — those bands escalate a warning, and no rung of
 * them lands on 1h and 1d together.
 */
export const COMFORTABLE_HEADROOM_THRESHOLD_MS: Record<UsageWindowKind, number> = {
  fiveHour: MILLISECONDS_PER_HOUR,
  sevenDay: MILLISECONDS_PER_DAY,
  sevenDayOpus: MILLISECONDS_PER_DAY,
};

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
  /**
   * How big `paceDeltaMs` is against this window's thresholds. `none` exactly
   * when `paceStatus` is `onTrack` — both come out of the same classification,
   * so they cannot disagree.
   */
  paceSeverity: PaceSeverity;
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
