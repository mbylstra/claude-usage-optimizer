import type { PaceSeverity, PaceStatus } from './usageTypes';

/**
 * The single colour decision, made once and shared by the pace pill, the usage
 * bar and the toolbar badge — so they can never disagree about how alarming a
 * window is.
 *
 * Being ahead escalates through three steps, because "you will run out early"
 * is a matter of degree: an hour ahead in a five-hour session is a different
 * afternoon from fifteen minutes ahead.
 *
 * Being behind does not escalate. Headroom is good news at any size, and three
 * shades of good news would imply a scale you cannot act on.
 */
export type PaceTone = 'onPace' | 'aheadSlight' | 'aheadModerate' | 'aheadSevere' | 'behind';

export function paceTone(paceStatus: PaceStatus, paceSeverity: PaceSeverity): PaceTone {
  if (paceStatus === 'onTrack') return 'onPace';
  if (paceStatus === 'behind') return 'behind';

  switch (paceSeverity) {
    case 'severe':
      return 'aheadSevere';
    case 'moderate':
      return 'aheadModerate';
    // 'none' cannot reach here — it is what makes a window `onTrack` above.
    default:
      return 'aheadSlight';
  }
}
