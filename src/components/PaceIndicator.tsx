import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { paceDescription, paceDirection, type PaceDirection } from '@/lib/paceDescription';
import type { PaceTone } from '@/lib/paceTone';
import { cn } from './ui/utils';

/**
 * The scalar the whole extension exists to show: how far ahead of, or behind,
 * an even burn you are, in minutes and hours rather than percentage points.
 *
 * Colour comes from the `tone` its caller derived, so the pill and the bar
 * beneath it always agree. The wording and the icon come from the signed gap,
 * which means a window inside the thresholds still names its gap while staying
 * neutral.
 */

export interface PaceIndicatorProps {
  tone: PaceTone;
  paceDeltaMs: number;
  className?: string;
}

const PACE_ICONS: Record<PaceDirection, typeof Minus> = {
  ahead: TrendingUp,
  behind: TrendingDown,
  even: Minus,
};

const PACE_TONE_CLASSES: Record<PaceTone, string> = {
  onPace: 'bg-pace-on-track-surface text-pace-on-track',
  aheadSlight: 'bg-pace-ahead-slight-surface text-pace-ahead-slight',
  aheadModerate: 'bg-pace-ahead-moderate-surface text-pace-ahead-moderate',
  aheadSevere: 'bg-pace-ahead-severe-surface text-pace-ahead-severe',
  behind: 'bg-pace-behind-surface text-pace-behind',
};

export function PaceIndicator({ tone, paceDeltaMs, className }: PaceIndicatorProps) {
  const Icon = PACE_ICONS[paceDirection(paceDeltaMs)];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        PACE_TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {paceDescription(paceDeltaMs)}
    </span>
  );
}
