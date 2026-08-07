import { formatDuration } from './formatDuration';

/**
 * The sentence the user actually acts on. Kept out of the component so it can be
 * asserted directly, since the exact wording is the product.
 *
 * It is phrased in time rather than percentage points: "36m ahead of pace" is a
 * quantity people already know how to spend, whereas "12 points ahead of pace"
 * needs the window length in your head before it means anything.
 *
 * Note that this reads the *signed gap*, not `paceStatus`. A gap inside the
 * tolerance is still worth stating — it just gets the neutral colour treatment —
 * so a card within a few minutes of an even burn shows those minutes rather than
 * a bare dash.
 */

/** Below this the gap rounds to nothing worth naming, so we just say "On pace". */
const NEGLIGIBLE_PACE_GAP_MS = 60 * 1000;

export type PaceDirection = 'ahead' | 'behind' | 'even';

/**
 * Which way the gap points, independent of whether it is big enough to be
 * called ahead or behind. Drives the icon so it always agrees with the words.
 */
export function paceDirection(paceDeltaMs: number): PaceDirection {
  if (!Number.isFinite(paceDeltaMs) || Math.abs(paceDeltaMs) < NEGLIGIBLE_PACE_GAP_MS)
    return 'even';
  return paceDeltaMs > 0 ? 'ahead' : 'behind';
}

export function paceDescription(paceDeltaMs: number): string {
  const direction = paceDirection(paceDeltaMs);
  if (direction === 'even') return 'On pace';

  const gap = formatDuration(Math.abs(paceDeltaMs));
  return direction === 'ahead' ? `${gap} ahead of pace` : `${gap} behind pace`;
}
