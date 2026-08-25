import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Code2, Square } from 'lucide-react';
import { Button } from './ui/button';
import { RunTimelineEntry } from './RunTimelineEntry';
import { cn } from './ui/utils';
import {
  describeRunStatus,
  formatRunCost,
  isRunInFlight,
  type AutonomousRunStatus,
  type AutonomousRunViewModel,
} from '@/lib/autonomousRunViewModel';
import type { AutonomousRunEvent } from '@/lib/autonomousRunEvents';
import { formatStopwatch } from '@/lib/formatDuration';
import { formatClockTime } from '@/lib/formatClockTime';
import {
  describeRunCancelStatus,
  isRunCancelStatusError,
  type RunCancelStatus,
} from '@/lib/runCancelStatus';
import {
  describeRunStreamStatus,
  isRunStreamStatusError,
  type RunStreamStatus,
} from '@/lib/runStreamStatus';

/**
 * The run-log window: status header, timeline, footer.
 *
 * Pure presentation — `RunLogRoot` owns the port and hands the whole state down.
 * The only state kept here is about *looking* at the log: whether the view is
 * following the bottom, and whether the raw JSON is showing.
 */

export interface RunLogViewProps {
  model: AutonomousRunViewModel;
  events: readonly AutonomousRunEvent[];
  streamStatus: RunStreamStatus;
  cancelStatus: RunCancelStatus;
  onCancel: () => void;
}

const STATUS_DOT_CLASSES: Record<AutonomousRunStatus, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-pace-steady animate-pulse',
  completed: 'bg-pace-headroom',
  error: 'bg-destructive',
  timeout: 'bg-pace-ahead-severe',
  cancelled: 'bg-muted-foreground',
  sessionLimit: 'bg-muted-foreground',
  skipped: 'bg-muted-foreground',
};

/** Close enough to the bottom to count as following it, in pixels. */
const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

function RunHeader({ model }: { model: AutonomousRunViewModel }) {
  const cost = formatRunCost(model.costUsd);
  const facts = [
    model.elapsedMs === null ? null : formatStopwatch(model.elapsedMs),
    cost,
    model.turns === null ? null : `${model.turns} turns`,
    model.model,
  ].filter((fact): fact is string => fact !== null && fact !== '');

  return (
    <header className="bg-card flex flex-col gap-1 border-b px-3.5 py-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASSES[model.status])}
          aria-hidden="true"
        />
        <span className="font-medium">{describeRunStatus(model.status)}</span>
        <span className="text-muted-foreground truncate">{facts.join(' · ')}</span>
      </div>

      {model.projectName !== null && (
        <p className="text-muted-foreground truncate text-xs" title={model.workingDirectory ?? ''}>
          {model.isNewProject ? 'new project' : 'project'}:{' '}
          <span className="text-foreground font-mono">{model.projectName}</span>
        </p>
      )}

      {model.prompt !== null && model.prompt !== '' && (
        <p className="line-clamp-2 text-xs" title={model.prompt}>
          {model.prompt}
        </p>
      )}

      {/* A skip's reason is deliberately *not* repeated here: it is the single
          line of the timeline below, and saying it twice in eighty pixels reads
          as two different facts. */}
    </header>
  );
}

export function RunLogView({
  model,
  events,
  streamStatus,
  cancelStatus,
  onCancel,
}: RunLogViewProps) {
  const [isShowingRawEvents, setIsShowingRawEvents] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
    setIsFollowingLatest(true);
  }, []);

  /**
   * Follow the bottom, but yield the moment the user scrolls away from it.
   *
   * Nothing is more irritating in a log view than being yanked back down
   * mid-read, so the "▼ live" button is the only way back to following.
   */
  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setIsFollowingLatest(distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD_PX);
  }, []);

  // Before paint, so a growing log never shows a frame of the wrong position.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null || !isFollowingLatest) return;
    node.scrollTop = node.scrollHeight;
  }, [model.timeline.length, isShowingRawEvents, isFollowingLatest]);

  const streamMessage = describeRunStreamStatus(streamStatus);
  const cancelMessage = describeRunCancelStatus(cancelStatus);
  const canCancel = isRunInFlight(model.status) && cancelStatus.kind !== 'cancelling';

  return (
    // `h-full`, not `h-screen`: the window sizes the page, and the preview
    // harness sizes a box, and both want the same thing — fill the parent.
    <div className="bg-background text-foreground flex h-full flex-col">
      <RunHeader model={model} />

      {streamMessage !== null && (
        <p
          role="status"
          className={cn(
            'border-b px-3.5 py-1.5 text-xs',
            isRunStreamStatusError(streamStatus) ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {streamMessage}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto py-1.5">
          {isShowingRawEvents ? (
            <pre className="px-3 py-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              {events.map((event) => JSON.stringify(event)).join('\n')}
            </pre>
          ) : (
            <ol>
              {model.timeline.map((entry) => (
                <RunTimelineEntry key={entry.id} entry={entry} />
              ))}
            </ol>
          )}

          {model.timeline.length === 0 && !isShowingRawEvents && (
            <p className="text-muted-foreground px-3.5 py-6 text-center text-xs">
              No run has been recorded yet. Press <span className="font-medium">Run now</span> in
              the popup to start one.
            </p>
          )}
        </div>

        {!isFollowingLatest && (
          <Button
            variant="secondary"
            size="sm"
            className="absolute right-3 bottom-3 shadow"
            onClick={scrollToLatest}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
            live
          </Button>
        )}
      </div>

      <footer className="bg-card flex flex-col gap-2 border-t px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Button
            variant={cancelStatus.kind === 'confirming' ? 'default' : 'outline'}
            size="sm"
            onClick={onCancel}
            disabled={!canCancel}
          >
            <Square className="size-3.5" aria-hidden="true" />
            {cancelStatus.kind === 'confirming' ? 'Confirm cancel' : 'Cancel run'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsShowingRawEvents((showing) => !showing)}
            aria-pressed={isShowingRawEvents}
          >
            <Code2 className="size-3.5" aria-hidden="true" />
            {isShowingRawEvents ? 'Timeline' : 'Raw JSON'}
          </Button>
        </div>

        {model.resumeScheduledFor !== null && (
          // The footer's answer to "so is that it for tonight?". A run that
          // stopped on a spent 5-hour window has asked launchd to pick the
          // queue back up, and a job starting hours later for no visible reason
          // is worse than one that never starts.
          <p className="text-muted-foreground text-xs">
            Resuming at {formatClockTime(new Date(model.resumeScheduledFor))}, when the 5-hour
            session window resets.
          </p>
        )}

        {cancelMessage !== null && (
          <p
            role="status"
            className={cn(
              'text-xs',
              isRunCancelStatusError(cancelStatus) ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {cancelMessage}
          </p>
        )}
      </footer>
    </div>
  );
}
