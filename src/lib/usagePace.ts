import {
  PACE_SEVERITY_THRESHOLDS_MS,
  USAGE_WINDOW_DURATIONS_MS,
  type ActiveWindowStatus,
  type DerivedWindowStatus,
  type PaceSeverity,
  type PaceStatus,
  type UsageSnapshot,
  type UsageWindowKind,
  type UsageWindowSnapshot,
} from './usageTypes';

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Bands the gap by how much time it is worth in *this* window. The same
 * percentage gap means very different things across five hours and seven days,
 * so the thresholds are per window kind and the comparison is done in
 * milliseconds — see `PACE_SEVERITY_THRESHOLDS_MS`.
 */
function classifyPaceSeverity(kind: UsageWindowKind, paceDeltaMs: number): PaceSeverity {
  const thresholds = PACE_SEVERITY_THRESHOLDS_MS[kind];
  const gapMs = Math.abs(paceDeltaMs);

  if (gapMs >= thresholds.severe) return 'severe';
  if (gapMs >= thresholds.moderate) return 'moderate';
  if (gapMs >= thresholds.slight) return 'slight';
  return 'none';
}

/** Direction, but only once the gap is big enough to have one worth naming. */
function classifyPace(paceSeverity: PaceSeverity, paceDeltaMs: number): PaceStatus {
  if (paceSeverity === 'none') return 'onTrack';
  return paceDeltaMs > 0 ? 'ahead' : 'behind';
}

function parseTimestamp(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Turns one API window into everything the UI needs to render it.
 *
 * `now` is always passed in and never read from the clock, which is what makes
 * the pace maths deterministic under test.
 *
 * The window start is taken from the API when it supplies one, and otherwise
 * derived as `resetsAt - windowDuration`. That derivation assumes the window is
 * a fixed block of exactly 5h / 7d; see the note in
 * `plans/mvp-chrome-extension.md` §2.
 */
export function deriveWindowStatus(snapshot: UsageWindowSnapshot, now: Date): DerivedWindowStatus {
  const percentUsed = clampPercent(snapshot.utilizationPercent);
  const windowResetsAt = parseTimestamp(snapshot.resetsAt);

  if (windowResetsAt === null) {
    return { kind: snapshot.kind, isActive: false, percentUsed };
  }

  const windowDurationMs = USAGE_WINDOW_DURATIONS_MS[snapshot.kind];
  const reportedStart = parseTimestamp(snapshot.startedAt);
  const windowStartedAt = reportedStart ?? new Date(windowResetsAt.getTime() - windowDurationMs);

  // Trust the reported span over the nominal duration when the API gave us both
  // ends of the window; they can differ if a window is extended or shortened.
  const effectiveDurationMs = Math.max(1, windowResetsAt.getTime() - windowStartedAt.getTime());

  const elapsedMs = now.getTime() - windowStartedAt.getTime();
  const pacePercent = clampPercent((elapsedMs / effectiveDurationMs) * 100);
  const paceDeltaPercentagePoints = percentUsed - pacePercent;

  const remainingMs = windowResetsAt.getTime() - now.getTime();

  // A percentage point of this window is worth this much wall-clock time, so
  // the gap converts straight into "you are 36m ahead of an even burn".
  const paceDeltaMs = (paceDeltaPercentagePoints / 100) * effectiveDurationMs;
  const paceSeverity = classifyPaceSeverity(snapshot.kind, paceDeltaMs);

  const status: ActiveWindowStatus = {
    kind: snapshot.kind,
    isActive: true,
    windowStartedAt,
    windowResetsAt,
    timeRemainingMs: Math.max(0, remainingMs),
    hasResetElapsed: remainingMs <= 0,
    percentUsed,
    pacePercent,
    paceDeltaPercentagePoints,
    paceDeltaMs,
    paceStatus: classifyPace(paceSeverity, paceDeltaMs),
    paceSeverity,
  };
  return status;
}

export function deriveUsageStatuses(snapshot: UsageSnapshot, now: Date): DerivedWindowStatus[] {
  return snapshot.windows.map((window) => deriveWindowStatus(window, now));
}

/** Highest utilisation across every window — what the toolbar badge shows. */
export function highestUtilizationPercent(snapshot: UsageSnapshot): number {
  return snapshot.windows.reduce(
    (highest, window) => Math.max(highest, clampPercent(window.utilizationPercent)),
    0,
  );
}

export function findWindowStatus(
  statuses: DerivedWindowStatus[],
  kind: DerivedWindowStatus['kind'],
): DerivedWindowStatus | undefined {
  return statuses.find((status) => status.kind === kind);
}
