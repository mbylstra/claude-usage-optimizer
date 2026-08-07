import { formatClockTimeWithDay } from '@/lib/formatClockTime';
import { formatDuration } from '@/lib/formatDuration';
import {
  USAGE_WINDOW_DURATION_LABELS,
  USAGE_WINDOW_LABELS,
  type DerivedWindowStatus,
  type PaceStatus,
} from '@/lib/usageTypes';
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

const BAR_FILL_CLASSES: Record<PaceStatus, string> = {
  ahead: 'bg-pace-ahead',
  behind: 'bg-pace-behind',
  onTrack: 'bg-pace-on-track',
};

function UsageBar({
  percentUsed,
  pacePercent,
  paceStatus,
}: {
  percentUsed: number;
  pacePercent: number;
  paceStatus: PaceStatus;
}) {
  return (
    <div
      className="bg-muted relative h-2 w-full overflow-hidden rounded-full"
      role="progressbar"
      aria-valuenow={Math.round(percentUsed)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Usage"
    >
      <div
        className={cn('h-full rounded-full transition-[width]', BAR_FILL_CLASSES[paceStatus])}
        style={{ width: `${percentUsed}%` }}
      />
      {/* The even-burn line: where you would be if you spent this window evenly. */}
      <div
        className="bg-foreground/45 absolute inset-y-0 w-0.5"
        style={{ left: `calc(${pacePercent}% - 1px)` }}
        title="Even-burn pace"
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

      <CardContent className="flex flex-col gap-2.5 pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl leading-none font-semibold tabular-nums">
            {Math.round(status.percentUsed)}
            <span className="text-muted-foreground ml-0.5 text-sm font-normal">% used</span>
          </span>
          <PaceIndicator paceStatus={status.paceStatus} paceDeltaMs={status.paceDeltaMs} />
        </div>

        <UsageBar
          percentUsed={status.percentUsed}
          pacePercent={status.pacePercent}
          paceStatus={status.paceStatus}
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
