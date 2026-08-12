import { formatClockTimeWithDay } from '@/lib/formatClockTime';
import { formatDuration } from '@/lib/formatDuration';
import { paceTone, type PaceTone } from '@/lib/paceTone';
import {
  USAGE_WINDOW_DURATION_LABELS,
  USAGE_WINDOW_LABELS,
  type DerivedWindowStatus,
} from '@/lib/usageTypes';
import { buildWindowTickMarks, type WindowTickMark } from '@/lib/windowTickMarks';
import { PaceIndicator } from './PaceIndicator';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { cn } from './ui/utils';

/**
 * One usage window. Takes a fully derived status plus `now` — it does no maths
 * of its own beyond rounding for display.
 */

export interface UsageWindowCardProps {
  status: DerivedWindowStatus;
  now: Date;
}

/** The fill is the region you have spent; the marker is its precise edge. */
const BAR_FILL_CLASSES: Record<PaceTone, string> = {
  steady: 'bg-pace-steady/30',
  headroom: 'bg-pace-headroom/30',
  aheadSlight: 'bg-pace-ahead-slight/30',
  aheadModerate: 'bg-pace-ahead-moderate/30',
  aheadSevere: 'bg-pace-ahead-severe/30',
};

const USAGE_MARKER_CLASSES: Record<PaceTone, string> = {
  steady: 'bg-pace-steady',
  headroom: 'bg-pace-headroom',
  aheadSlight: 'bg-pace-ahead-slight',
  aheadModerate: 'bg-pace-ahead-moderate',
  aheadSevere: 'bg-pace-ahead-severe',
};

/**
 * One of the two lines the card is really about. Taller than the track it
 * crosses, so it reads as a mark *against* a scale rather than as part of the
 * bar, and ringed in the card colour so it stays legible wherever it lands.
 */
function BarMarker({
  positionPercent,
  colorClassName,
  title,
}: {
  positionPercent: number;
  colorClassName: string;
  title: string;
}) {
  return (
    <div
      className={cn(
        'ring-card absolute inset-y-0 w-[3px] rounded-full ring-[1.5px]',
        colorClassName,
      )}
      style={{ left: `calc(${positionPercent}% - 1.5px)` }}
      title={title}
    />
  );
}

function UsageBar({
  percentUsed,
  pacePercent,
  tone,
  tickMarks,
}: {
  percentUsed: number;
  pacePercent: number;
  tone: PaceTone;
  tickMarks: WindowTickMark[];
}) {
  return (
    // Padded so the two markers can overhang the track without being clipped by
    // the rounded overflow the fill needs.
    <div className="relative py-1.5">
      <div
        className="bg-muted relative h-2.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-valuenow={Math.round(percentUsed)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Usage"
      >
        <div
          className={cn('h-full rounded-full transition-[width]', BAR_FILL_CLASSES[tone])}
          style={{ width: `${percentUsed}%` }}
        />
        {/* Hour or day boundaries, so the bar reads as a scale and the two
            markers can be placed against it. Half-height and faint, so they
            stay clearly subordinate to those markers. */}
        {tickMarks.map((tickMark) => (
          <div
            key={tickMark.label}
            className="absolute bottom-0 h-1 w-px"
            style={{
              left: `${tickMark.positionPercent}%`,
              backgroundColor: 'white',
              mixBlendMode: 'screen',
              opacity: 0.6,
            }}
            title={`${tickMark.label} into the window`}
            aria-hidden="true"
          />
        ))}
      </div>

      {/* Where an even burn would have you. Drawn first so that when the two
          coincide it is the coloured one — the live figure — left on top. */}
      <BarMarker
        positionPercent={pacePercent}
        colorClassName="bg-foreground"
        title="Even-burn pace"
      />
      <BarMarker
        positionPercent={percentUsed}
        colorClassName={USAGE_MARKER_CLASSES[tone]}
        title="Where you are"
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</span>
      <span className="text-foreground text-xs font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function UsageWindowCard({ status, now }: UsageWindowCardProps) {
  const title = USAGE_WINDOW_LABELS[status.kind];

  if (!status.isActive) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-baseline justify-between">
            <CardTitle>{title}</CardTitle>
            <span className="text-muted-foreground text-xs">
              {USAGE_WINDOW_DURATION_LABELS[status.kind]}
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-2">
          <p className="text-muted-foreground text-xs">
            Not started — this window begins with your next message.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Derived once so the hero and the bar cannot end up different colours.
  const tone = paceTone(status);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-baseline justify-between">
          <CardTitle>{title}</CardTitle>
          <span className="text-muted-foreground text-xs">
            {USAGE_WINDOW_DURATION_LABELS[status.kind]}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2 pt-2">
        {/* The gap is the hero; the raw percentage is supporting detail, because
            "72% used" means nothing until you know how far into the window you
            are — which is exactly what the gap has already worked out. */}
        <div className="flex items-baseline justify-between gap-2">
          <PaceIndicator tone={tone} paceDeltaMs={status.paceDeltaMs} />
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {Math.round(status.percentUsed)}% used
          </span>
        </div>

        <UsageBar
          percentUsed={status.percentUsed}
          pacePercent={status.pacePercent}
          tone={tone}
          tickMarks={buildWindowTickMarks(status)}
        />

        <div className="grid grid-cols-3 gap-2">
          <DetailRow label="Started" value={formatClockTimeWithDay(status.windowStartedAt, now)} />
          <DetailRow label="Resets" value={formatClockTimeWithDay(status.windowResetsAt, now)} />
          <DetailRow
            label="Left"
            value={status.hasResetElapsed ? 'Resetting…' : formatDuration(status.timeRemainingMs)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
