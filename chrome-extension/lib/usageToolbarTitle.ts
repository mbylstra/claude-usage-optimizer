import { highestUtilizationPercent } from './usagePace';
import type { UsageSnapshot } from './usageTypes';

/**
 * The toolbar icon's tooltip: the highest utilisation across every window, i.e.
 * how close you are to the limit you will hit first.
 *
 * The icon deliberately carries no badge. A percentage painted over the toolbar
 * is a permanent alarm for a number that is usually unremarkable; the figure is
 * worth having on hover, and the popup is where the pace story actually lives.
 */

export const DEFAULT_TOOLBAR_TITLE = 'Claude Usage Optimizer';

export function deriveToolbarTitle(snapshot: UsageSnapshot): string {
  return `Claude usage: ${Math.round(highestUtilizationPercent(snapshot))}% of the closest limit`;
}
