import { USAGE_WINDOW_LABELS, type UsageWindowKind, type UsageWindowSnapshot } from './usageTypes';

/**
 * Percent-of-limit milestones worth their own notification, independent of the
 * pace-vs-even-burn warnings in `suggestedModel.ts`. Those fire on how fast
 * you're burning; these fire on how close you are to actually running out,
 * regardless of pace — a window can be right on pace and still about to hit
 * its cap.
 */
export const USAGE_LIMIT_WARNING_THRESHOLDS_PERCENT = [90, 95, 98] as const;
export type UsageLimitWarningThreshold = (typeof USAGE_LIMIT_WARNING_THRESHOLDS_PERCENT)[number];

/**
 * Which thresholds have already fired for one window, scoped to a single
 * window generation via `resetsAt`. A window whose `resetsAt` no longer
 * matches is a new generation — its thresholds are unclaimed again.
 */
export interface UsageLimitWarningState {
  resetsAt: string | null;
  notifiedThresholds: UsageLimitWarningThreshold[];
}

export type UsageLimitWarningStateByWindow = Partial<
  Record<UsageWindowKind, UsageLimitWarningState>
>;

export interface UsageLimitWarning {
  kind: UsageWindowKind;
  threshold: UsageLimitWarningThreshold;
}

/**
 * Which thresholds a fresh snapshot newly crosses, plus the state to persist
 * afterwards so the same threshold does not fire again until its window
 * resets.
 *
 * **At most one warning per window.** A refresh can cross several thresholds at
 * once — five minutes is long enough to go from 89% to 98% — and warning three
 * times about one window says nothing the highest of the three does not. So the
 * lower ones are recorded as notified without being reported, which also stops
 * them firing individually on the next refresh.
 *
 * A stale `resetsAt` in the previous state (the window has moved on to a new
 * generation since the last check) is treated the same as no prior state at
 * all — a window that spent last cycle at 98% and has since reset to 0% can
 * warn again next time it climbs.
 */
export function deriveNewUsageLimitWarnings(
  windows: UsageWindowSnapshot[],
  previousState: UsageLimitWarningStateByWindow,
): { warnings: UsageLimitWarning[]; state: UsageLimitWarningStateByWindow } {
  const warnings: UsageLimitWarning[] = [];
  const state: UsageLimitWarningStateByWindow = {};

  for (const window of windows) {
    const previous = previousState[window.kind];
    const isSameGeneration = previous !== undefined && previous.resetsAt === window.resetsAt;
    const alreadyNotified = isSameGeneration ? previous.notifiedThresholds : [];

    const newlyCrossed = USAGE_LIMIT_WARNING_THRESHOLDS_PERCENT.filter(
      (threshold) => window.utilizationPercent >= threshold && !alreadyNotified.includes(threshold),
    );

    const highestNewlyCrossed = newlyCrossed[newlyCrossed.length - 1];
    if (highestNewlyCrossed !== undefined) {
      warnings.push({ kind: window.kind, threshold: highestNewlyCrossed });
    }

    state[window.kind] = {
      resetsAt: window.resetsAt,
      notifiedThresholds: [...alreadyNotified, ...newlyCrossed],
    };
  }

  return { warnings, state };
}

const THRESHOLD_HEADLINES: Record<UsageLimitWarningThreshold, string> = {
  90: 'Approaching limit',
  95: 'Close to limit',
  98: 'Nearly at limit',
};

export function usageLimitWarningTitle(
  kind: UsageWindowKind,
  threshold: UsageLimitWarningThreshold,
): string {
  return `${THRESHOLD_HEADLINES[threshold]}: ${USAGE_WINDOW_LABELS[kind]}`;
}

export function usageLimitWarningBody(threshold: UsageLimitWarningThreshold): string {
  return `You've used ${threshold}% of this window's limit.`;
}
