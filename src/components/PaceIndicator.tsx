import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { paceDescription, paceDirection, type PaceDirection } from '@/lib/paceDescription';
import type { PaceStatus } from '@/lib/usageTypes';
import { cn } from './ui/utils';

/**
 * The scalar the whole extension exists to show: how far ahead of, or behind,
 * an even burn you are, in minutes and hours rather than percentage points.
 *
 * Colour comes from `paceStatus`, so it is identical on every window and there
 * is no per-window behaviour flag to reason about. The wording and the icon come
 * from the signed gap, which means a card inside the tolerance still names its
 * gap while staying neutral.
 */

export interface PaceIndicatorProps {
  paceStatus: PaceStatus;
  paceDeltaMs: number;
  className?: string;
}

const PACE_ICONS: Record<PaceDirection, typeof Minus> = {
  ahead: TrendingUp,
  behind: TrendingDown,
  even: Minus,
};

const PACE_CLASSES: Record<PaceStatus, string> = {
  ahead: 'bg-pace-ahead-surface text-pace-ahead',
  behind: 'bg-pace-behind-surface text-pace-behind',
  onTrack: 'bg-pace-on-track-surface text-pace-on-track',
};

export function PaceIndicator({ paceStatus, paceDeltaMs, className }: PaceIndicatorProps) {
  const Icon = PACE_ICONS[paceDirection(paceDeltaMs)];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        PACE_CLASSES[paceStatus],
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {paceDescription(paceDeltaMs)}
    </span>
  );
}
