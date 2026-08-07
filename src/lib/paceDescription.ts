import type { PaceStatus } from './usageTypes';

/**
 * The sentence the user actually acts on. Kept out of the component so it can be
 * asserted directly, since the exact wording is the product.
 */
export function paceDescription(paceStatus: PaceStatus, paceDeltaPercentagePoints: number): string {
  if (paceStatus === 'onTrack') return 'On pace';

  const points = Math.round(Math.abs(paceDeltaPercentagePoints));
  const pointWord = points === 1 ? 'point' : 'points';

  return paceStatus === 'ahead'
    ? `${points} ${pointWord} ahead of pace`
    : `${points} ${pointWord} behind pace`;
}
