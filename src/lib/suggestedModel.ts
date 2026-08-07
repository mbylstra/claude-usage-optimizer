import { paceTone } from './paceTone';
import { findWindowStatus } from './usagePace';
import type { DerivedWindowStatus } from './usageTypes';

/**
 * Which Claude model is worth reaching for right now, given how the two
 * windows that gate every conversation — the five-hour session and the
 * weekly cap — are tracking against an even burn.
 *
 * Deliberately reads only `fiveHour` and `sevenDay`. `sevenDayOpus` caps
 * Opus specifically rather than describing overall burn rate, so including
 * it here would penalise Opus twice.
 */
export type SuggestedModel = 'opus' | 'sonnet' | 'haiku';

export const SUGGESTED_MODEL_LABELS: Record<SuggestedModel, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * The three-band simplification of `PaceTone` this suggestion is built on.
 * `headroom` and `steady` both read as favourable here — the distinction
 * between "spare capacity" and "on pace" does not change which model is
 * affordable. `aheadSlight` and `aheadModerate` both read as a caution
 * short of urgent; only `aheadSevere` is treated as a reason to conserve.
 */
type PaceBand = 'favourable' | 'caution' | 'severe';

function paceBand(status: DerivedWindowStatus): PaceBand {
  if (!status.isActive) return 'favourable';

  switch (paceTone(status)) {
    case 'aheadSevere':
      return 'severe';
    case 'aheadSlight':
    case 'aheadModerate':
      return 'caution';
    default:
      return 'favourable';
  }
}

/**
 * Opus when both gating windows have room to spare, Haiku the moment either
 * one is burning severely ahead of even pace, Sonnet for everything between.
 *
 * Null only when a snapshot is missing one of the two windows this reads —
 * the popup should already be showing an error state in that case.
 */
export function deriveSuggestedModel(windows: DerivedWindowStatus[]): SuggestedModel | null {
  const fiveHourStatus = findWindowStatus(windows, 'fiveHour');
  const weeklyStatus = findWindowStatus(windows, 'sevenDay');
  if (fiveHourStatus === undefined || weeklyStatus === undefined) return null;

  const bands = [paceBand(fiveHourStatus), paceBand(weeklyStatus)];
  if (bands.includes('severe')) return 'haiku';
  if (bands.includes('caution')) return 'sonnet';
  return 'opus';
}
