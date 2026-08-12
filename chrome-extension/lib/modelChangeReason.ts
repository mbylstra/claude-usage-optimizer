import { paceDescription } from './paceDescription';
import { findWindowStatus } from './usagePace';
import {
  USAGE_WINDOW_LABELS,
  type ActiveWindowStatus,
  type DerivedWindowStatus,
} from './usageTypes';
import type { SuggestedModel } from './suggestedModel';

const MODEL_LABELS: Record<SuggestedModel, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
};

/**
 * Explain why a model recommendation changed, so users understand which usage
 * window drove the change.
 *
 * States the same "1h 12m ahead/behind pace" gap the usage card shows, rather
 * than a vague "critical" or "healthy" label — a duration is something the
 * user can act on without having to cross-reference the popup.
 */
export function deriveModelChangeReason(
  previousModel: string | null,
  newModel: SuggestedModel,
  windows: DerivedWindowStatus[],
): string {
  if (previousModel === null) {
    return 'Initial recommendation';
  }

  if (previousModel === newModel) {
    return 'Recommendation unchanged';
  }

  const fiveHourStatus = activeStatus(findWindowStatus(windows, 'fiveHour'));
  const weeklyStatus = activeStatus(findWindowStatus(windows, 'sevenDay'));

  const gaps = [
    fiveHourStatus && gapPhrase('fiveHour', fiveHourStatus),
    weeklyStatus && gapPhrase('sevenDay', weeklyStatus),
  ].filter((gap): gap is string => Boolean(gap));

  const action = describeAction(isBetterModel(newModel, previousModel), newModel);

  return gaps.length === 0 ? action : `${gaps.join(', ')} — ${action}`;
}

function activeStatus(status: DerivedWindowStatus | undefined): ActiveWindowStatus | null {
  return status?.isActive ? status : null;
}

function gapPhrase(kind: ActiveWindowStatus['kind'], status: ActiveWindowStatus): string {
  return `${USAGE_WINDOW_LABELS[kind]} ${paceDescription(status.paceDeltaMs)}`;
}

function describeAction(isMovingToBetter: boolean, newModel: SuggestedModel): string {
  if (isMovingToBetter) {
    return newModel === 'opus' ? 'try Opus' : `switch to ${MODEL_LABELS[newModel]}`;
  }
  return newModel === 'haiku'
    ? 'switch to Haiku to conserve'
    : `switch to ${MODEL_LABELS[newModel]}`;
}

function isBetterModel(modelA: string, modelB: string): boolean {
  const modelRank = { haiku: 0, sonnet: 1, opus: 2 };
  const rankA = modelRank[modelA as SuggestedModel] ?? -1;
  const rankB = modelRank[modelB as SuggestedModel] ?? -1;
  return rankA > rankB;
}
