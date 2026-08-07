import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import { formatTimeAgo } from '@/lib/formatDuration';
import { SUGGESTED_MODEL_LABELS, type SuggestedModel } from '@/lib/suggestedModel';
import type { UsagePopupData } from '@/lib/usagePopupData';
import type { UsageErrorInfo } from '@/lib/usageTypes';
import { UsageWindowCard } from './UsageWindowCard';
import { Button } from './ui/button';
import { cn } from './ui/utils';

/**
 * The whole popup, as a pure function of a view model.
 *
 * It never touches `chrome.*` — `PopupRoot` supplies the data and the callbacks.
 * That is what lets every visual state below exist as a Storybook story.
 */

export interface UsagePopupProps {
  data: UsagePopupData;
  now: Date;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpenClaude: () => void;
}

const CLAUDE_URL = 'https://claude.ai';

function PopupFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground flex w-[22rem] flex-col gap-3 p-3.5">
      {children}
    </div>
  );
}

function SuggestedModelRow({ model }: { model: SuggestedModel }) {
  return (
    <p
      className="text-muted-foreground text-xs"
      title="Suggested model, based on how your usage windows are pacing"
    >
      Suggested model:{' '}
      <span className="text-foreground font-semibold">{SUGGESTED_MODEL_LABELS[model]}</span>
    </p>
  );
}

function PopupHeader({
  isRefreshing,
  onRefresh,
  subtitle,
}: {
  isRefreshing: boolean;
  onRefresh: () => void;
  subtitle: React.ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-2">
      <div className="flex flex-col gap-0.5">
        <h1 className="text-sm font-semibold">Claude usage</h1>
        <div className="text-muted-foreground text-xs">{subtitle}</div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label="Refresh usage"
        title="Refresh"
      >
        <RefreshCw className={cn('size-4', isRefreshing && 'animate-spin')} aria-hidden="true" />
      </Button>
    </header>
  );
}

/** Turns an error code into copy a person can act on. */
function errorHeadline(error: UsageErrorInfo): string {
  switch (error.code) {
    case 'NOT_LOGGED_IN':
      return 'Not logged in to Claude.ai';
    case 'NO_ORGANIZATIONS':
      return 'No Claude.ai account found';
    case 'NETWORK_ERROR':
      return 'Could not reach Claude.ai';
    case 'MALFORMED_RESPONSE':
      return 'Claude.ai sent something unexpected';
    case 'HTTP_ERROR':
      return 'Claude.ai could not report your usage';
    default:
      return 'Could not load your usage';
  }
}

function errorGuidance(error: UsageErrorInfo): string {
  switch (error.code) {
    case 'NOT_LOGGED_IN':
    case 'NO_ORGANIZATIONS':
      return 'Sign in to Claude.ai, then refresh.';
    case 'NETWORK_ERROR':
      return 'Check your connection and try again.';
    default:
      return 'This usually clears up on its own. Try again in a moment.';
  }
}

function OpenClaudeButton({ onOpenClaude }: { onOpenClaude: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onOpenClaude}>
      Open Claude.ai
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading usage">
      {[0, 1].map((index) => (
        <div key={index} className="bg-muted/60 h-[6.5rem] animate-pulse rounded-lg" />
      ))}
    </div>
  );
}

function ErrorState({ error, onOpenClaude }: { error: UsageErrorInfo; onOpenClaude: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed px-3.5 py-4">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <AlertTriangle className="text-pace-ahead size-4" aria-hidden="true" />
        {errorHeadline(error)}
      </div>
      <p className="text-muted-foreground text-xs">{errorGuidance(error)}</p>
      <OpenClaudeButton onOpenClaude={onOpenClaude} />
    </div>
  );
}

export function UsagePopup({ data, now, isRefreshing, onRefresh, onOpenClaude }: UsagePopupProps) {
  if (data.state === 'loading') {
    return (
      <PopupFrame>
        <PopupHeader isRefreshing={isRefreshing} onRefresh={onRefresh} subtitle="Loading…" />
        <LoadingState />
      </PopupFrame>
    );
  }

  if (data.state === 'error') {
    return (
      <PopupFrame>
        <PopupHeader isRefreshing={isRefreshing} onRefresh={onRefresh} subtitle="No data yet" />
        <ErrorState error={data.error} onOpenClaude={onOpenClaude} />
      </PopupFrame>
    );
  }

  return (
    <PopupFrame>
      <PopupHeader
        isRefreshing={isRefreshing}
        onRefresh={onRefresh}
        subtitle={
          <span className={cn(data.isStale && 'text-pace-ahead')}>
            Updated {formatTimeAgo(data.fetchedAt, now)}
            {data.isStale && ' — may be out of date'}
          </span>
        }
      />

      {data.refreshError !== null && (
        <div className="border-pace-ahead/40 bg-pace-ahead-surface text-pace-ahead flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{errorHeadline(data.refreshError)} — showing the last known figures.</span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {data.windows.map((status) => (
          <UsageWindowCard key={status.kind} status={status} now={now} />
        ))}
      </div>

      {data.suggestedModel != null && <SuggestedModelRow model={data.suggestedModel} />}

      <footer className="flex items-center justify-end gap-2">
        <a
          href={CLAUDE_URL}
          onClick={(event) => {
            event.preventDefault();
            onOpenClaude();
          }}
          className="text-brand inline-flex items-center gap-1 text-[11px] hover:underline"
        >
          Claude.ai
          <ExternalLink className="size-3" aria-hidden="true" />
        </a>
      </footer>
    </PopupFrame>
  );
}
