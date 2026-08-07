import { COMFORTABLE_HEADROOM_THRESHOLD_MS, type ActiveWindowStatus } from './usageTypes';

/**
 * The single colour decision, made once and shared by the hero stat and the
 * usage bar — so they can never disagree about how alarming a window is.
 *
 * Burning *faster* than an even burn escalates through three steps, because
 * "you will run out early" is a matter of degree: an hour ahead in a five-hour
 * session is a different afternoon from fifteen minutes ahead.
 *
 * The other side of the line is only two steps. `steady` — plain blue — is the
 * resting state, covering both a dead-even burn and any gap too small to act
 * on, in either direction; there is no grey, because nothing here is an absence
 * of information. `headroom` is green, and means a spare hour of the session or
 * a spare day of the week: enough slack that you could deliberately spend it.
 */
export type PaceTone = 'steady' | 'aheadSlight' | 'aheadModerate' | 'aheadSevere' | 'headroom';

export function paceTone(status: ActiveWindowStatus): PaceTone {
  if (status.paceStatus === 'ahead') {
    switch (status.paceSeverity) {
      case 'severe':
        return 'aheadSevere';
      case 'moderate':
        return 'aheadModerate';
      // 'none' cannot reach here — it is what makes a window `onTrack` instead.
      default:
        return 'aheadSlight';
    }
  }

  // Behind an even burn, or close enough to it to be neither. A negative delta
  // is time you have not spent yet, so flip the sign to read it as headroom.
  const headroomMs = -status.paceDeltaMs;
  return headroomMs >= COMFORTABLE_HEADROOM_THRESHOLD_MS[status.kind] ? 'headroom' : 'steady';
}
