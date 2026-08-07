import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { paceDescription } from '@/lib/paceDescription';
import type { PaceStatus } from '@/lib/usageTypes';
import { cn } from './ui/utils';

/**
 * The scalar the whole extension exists to show: how far ahead of, or behind,
 * an even burn you are.
 *
 * Renders purely from `paceStatus` — the colour treatment is identical on every
 * window, so there is no per-window behaviour flag to reason about.
 */

export interface PaceIndicatorProps {
  paceStatus: PaceStatus;
  paceDeltaPercentagePoints: number;
  className?: string;
}

const PACE_ICONS = {
  ahead: TrendingUp,
  behind: TrendingDown,
  onTrack: Minus,
} as const;

const PACE_CLASSES: Record<PaceStatus, string> = {
  ahead: 'bg-pace-ahead-surface text-pace-ahead',
  behind: 'bg-pace-behind-surface text-pace-behind',
  onTrack: 'bg-pace-on-track-surface text-pace-on-track',
};

export function PaceIndicator({
  paceStatus,
  paceDeltaPercentagePoints,
  className,
}: PaceIndicatorProps) {
  const Icon = PACE_ICONS[paceStatus];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        PACE_CLASSES[paceStatus],
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {paceDescription(paceStatus, paceDeltaPercentagePoints)}
    </span>
  );
}
