import { paceTone } from './paceTone';
import { findWindowStatus } from './usagePace';
import type { DerivedWindowStatus } from './usageTypes';
import type { SuggestedModel } from './suggestedModel';

/**
 * Explain why a model recommendation changed, so users understand which usage
 * window drove the change.
 */
export function deriveModelChangeReason(
  previousModel: string | null,
  newModel: SuggestedModel,
  windows: DerivedWindowStatus[],
): string {
  const fiveHourStatus = findWindowStatus(windows, 'fiveHour');
  const weeklyStatus = findWindowStatus(windows, 'sevenDay');

  if (previousModel === null) {
    return 'Initial recommendation';
  }

  if (previousModel === newModel) {
    return 'Recommendation unchanged';
  }

  const fiveHourTone = fiveHourStatus?.isActive ? paceTone(fiveHourStatus) : null;
  const weeklyTone = weeklyStatus?.isActive ? paceTone(weeklyStatus) : null;

  const isMovingToBetter = isBetterModel(newModel, previousModel);

  if (isMovingToBetter) {
    return deriveImprovement(fiveHourTone, weeklyTone, newModel);
  } else {
    return deriveConservation(fiveHourTone, weeklyTone, newModel);
  }
}

function isBetterModel(modelA: string, modelB: string): boolean {
  const modelRank = { haiku: 0, sonnet: 1, opus: 2 };
  const rankA = modelRank[modelA as SuggestedModel] ?? -1;
  const rankB = modelRank[modelB as SuggestedModel] ?? -1;
  return rankA > rankB;
}

function deriveImprovement(
  fiveHourTone: string | null,
  weeklyTone: string | null,
  newModel: SuggestedModel,
): string {
  const isFiveHourHealthy = !['aheadSlight', 'aheadModerate', 'aheadSevere'].includes(
    fiveHourTone || '',
  );
  const isWeeklyHealthy = !['aheadSlight', 'aheadModerate', 'aheadSevere'].includes(
    weeklyTone || '',
  );

  if (isFiveHourHealthy && isWeeklyHealthy) {
    if (newModel === 'opus') {
      return 'Usage back on track, try Opus';
    }
    return 'Usage improving';
  }

  if (newModel === 'sonnet') {
    if (isFiveHourHealthy && !isWeeklyHealthy) {
      return '5-hour session is healthy, weekly pace improving';
    }
    if (!isFiveHourHealthy && isWeeklyHealthy) {
      return 'Weekly pace is healthy, 5-hour session improving';
    }
    return 'Usage improving';
  }

  return 'Usage improving';
}

function deriveConservation(
  fiveHourTone: string | null,
  weeklyTone: string | null,
  newModel: SuggestedModel,
): string {
  const fiveHourSevere = fiveHourTone === 'aheadSevere';
  const weeklySevere = weeklyTone === 'aheadSevere';

  if (newModel === 'haiku') {
    if (fiveHourSevere && weeklySevere) {
      return 'Both windows at critical pace — switch to Haiku to conserve';
    }
    if (fiveHourSevere) {
      return '5-hour session at critical pace — switch to Haiku to conserve';
    }
    if (weeklySevere) {
      return 'Weekly usage at critical pace — switch to Haiku to conserve';
    }
    return 'Usage accelerating — switch to Haiku to conserve';
  }

  if (newModel === 'sonnet') {
    if (fiveHourTone === 'aheadModerate' || fiveHourTone === 'aheadSlight') {
      if (weeklyTone === 'aheadModerate' || weeklyTone === 'aheadSlight') {
        return 'Both windows approaching limit — switch to Sonnet';
      }
      return '5-hour session approaching limit — switch to Sonnet';
    }
    if (weeklyTone === 'aheadModerate' || weeklyTone === 'aheadSlight') {
      return 'Weekly usage approaching limit — switch to Sonnet';
    }
  }

  return 'Usage pattern changed';
}
