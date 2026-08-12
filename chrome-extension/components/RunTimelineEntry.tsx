import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Flag,
  MessageSquare,
  SkipForward,
  Terminal,
} from 'lucide-react';
import type { RunTimelineEntry as RunTimelineEntryData } from '@/lib/autonomousRunViewModel';
import { formatTimestampWithSeconds } from '@/lib/formatClockTime';
import { cn } from './ui/utils';

/**
 * One line of the run timeline: time, icon, label, detail.
 *
 * The timestamp column is fixed-width and tabular so the lines form a column
 * that can be scanned down rather than read across.
 */

const ICONS_BY_KIND = {
  runStarted: Flag,
  claudeStarted: CircleDot,
  assistant: MessageSquare,
  tool: ArrowRight,
  notice: AlertTriangle,
  output: Terminal,
  result: CheckCircle2,
  finished: CheckCircle2,
  skipped: SkipForward,
} as const;

const TONE_CLASSES = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  success: 'text-pace-headroom',
  error: 'text-destructive',
} as const;

export function RunTimelineEntry({ entry }: { entry: RunTimelineEntryData }) {
  const Icon = ICONS_BY_KIND[entry.kind];
  const at = new Date(entry.at);

  return (
    <li className="flex items-baseline gap-2 px-3 py-1 text-xs">
      <time
        className="text-muted-foreground shrink-0 font-mono tabular-nums"
        dateTime={entry.at}
        title={at.toLocaleString()}
      >
        {formatTimestampWithSeconds(at)}
      </time>
      <Icon
        className={cn('size-3.5 shrink-0 translate-y-0.5', TONE_CLASSES[entry.tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <span className={cn('break-words', TONE_CLASSES[entry.tone])}>{entry.label}</span>
        {entry.detail !== null && (
          // `break-all`, not `break-words`: details are commands and paths, which
          // have no spaces to break at and would otherwise force a sideways scroll.
          <span className="text-muted-foreground ml-1.5 font-mono break-all" title={entry.detail}>
            {entry.detail}
          </span>
        )}
      </div>
    </li>
  );
}
