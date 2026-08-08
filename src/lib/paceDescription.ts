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
  const headline = paceHeadline(paceDeltaMs);
  return headline.qualifier === null ? headline.value : `${headline.value} ${headline.qualifier}`;
}

/**
 * The same sentence, split where the card sets it in two type sizes.
 *
 * The gap itself is the hero — it is the one number the extension exists to
 * report — so it is separated from the words that qualify it rather than being
 * one long string the component would have to slice up again.
 */
export interface PaceHeadline {
  /** The span alone: "1h 12m". "On pace" when there is no gap worth naming. */
  value: string;
  /** "ahead of pace" / "behind pace", or null when `value` already says it. */
  qualifier: string | null;
}

export function paceHeadline(paceDeltaMs: number): PaceHeadline {
  const direction = paceDirection(paceDeltaMs);
  if (direction === 'even') return { value: 'On pace', qualifier: null };

  return {
    value: formatDuration(Math.abs(paceDeltaMs)),
    qualifier: direction === 'ahead' ? 'ahead of optimal pace' : 'behind optimal pace',
  };
}
