import { paceTone, type PaceTone } from './paceTone';
import { deriveUsageStatuses, highestUtilizationPercent } from './usagePace';
import type { UsageSnapshot } from './usageTypes';

/**
 * The toolbar badge: the highest utilisation across every window, coloured by
 * how the *weekly* window is pacing. The number answers "how much have I used",
 * the colour answers "should I care", and the weekly window is the one where
 * being ahead of pace is a real budget breach.
 */

export interface BadgeState {
  text: string;
  backgroundColor: string;
  /** Screen-reader / tooltip text for the toolbar icon. */
  title: string;
}

/** The same ramp as the popup's pace pill, in the hex the badge API wants. */
const BADGE_COLORS: Record<PaceTone, string> = {
  onPace: '#3F3F46',
  aheadSlight: '#A16207',
  aheadModerate: '#C2410C',
  aheadSevere: '#B91C1C',
  behind: '#1D4ED8',
};

export const EMPTY_BADGE_STATE: BadgeState = {
  text: '',
  backgroundColor: BADGE_COLORS.onPace,
  title: 'Claude Usage Optimizer',
};

export function deriveBadgeState(snapshot: UsageSnapshot, now: Date): BadgeState {
  const statuses = deriveUsageStatuses(snapshot, now);
  const weekly = statuses.find((status) => status.kind === 'sevenDay');
  const tone: PaceTone =
    weekly?.isActive === true ? paceTone(weekly.paceStatus, weekly.paceSeverity) : 'onPace';

  const highestPercent = Math.round(highestUtilizationPercent(snapshot));

  return {
    text: `${highestPercent}`,
    backgroundColor: BADGE_COLORS[tone],
    title: `Claude usage: ${highestPercent}% of the closest limit`,
  };
}
