import { paceDescription, paceHeadline } from '@/lib/paceDescription';
import type { PaceTone } from '@/lib/paceTone';
import { cn } from './ui/utils';

/**
 * The scalar the whole extension exists to show, set as the card's hero: how far
 * ahead of, or behind, an even burn you are — in minutes and hours rather than
 * percentage points, because that is the form you can act on.
 *
 * Colour comes from the `tone` its caller derived, so this and the bar beneath
 * it always agree. There is no icon: an arrow can only say "up" or "down", and
 * neither maps cleanly onto a quantity that is good in one direction and bad in
 * the other. The colour carries the judgement and the words carry the direction.
 */

export interface PaceIndicatorProps {
  tone: PaceTone;
  paceDeltaMs: number;
  className?: string;
}

const PACE_TONE_TEXT_CLASSES: Record<PaceTone, string> = {
  steady: 'text-pace-steady',
  headroom: 'text-pace-headroom',
  aheadSlight: 'text-pace-ahead-slight',
  aheadModerate: 'text-pace-ahead-moderate',
  aheadSevere: 'text-pace-ahead-severe',
};

export function PaceIndicator({ tone, paceDeltaMs, className }: PaceIndicatorProps) {
  const { value, qualifier } = paceHeadline(paceDeltaMs);

  return (
    <div
      className={cn('flex flex-col gap-0.5', className)}
      title={paceDescription(paceDeltaMs)}
      aria-label={paceDescription(paceDeltaMs)}
    >
      <span
        className={cn(
          'text-[1.75rem] leading-none font-semibold tracking-tight tabular-nums',
          PACE_TONE_TEXT_CLASSES[tone],
        )}
      >
        {value}
      </span>
      {qualifier !== null && (
        <span className={cn('text-xs font-medium', PACE_TONE_TEXT_CLASSES[tone])}>{qualifier}</span>
      )}
    </div>
  );
}
