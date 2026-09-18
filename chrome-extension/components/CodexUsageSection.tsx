import { AlertTriangle } from 'lucide-react';
import type { CodexUsagePopupData } from '@/lib/codexUsagePopupData';
import { errorHeadline } from '@/lib/usageErrorCopy';
import { UsageWindowCard } from './UsageWindowCard';

/**
 * `errorHeadline` is named 'Codex' throughout this file, not the default
 * 'Claude.ai' — a Codex-side `NOT_LOGGED_IN` must not read as a Claude.ai
 * sign-in problem. The body renders `error.message` verbatim rather than
 * calling the generic `errorGuidance`: the host (`codex_usage.py`) and
 * `codexUsageSource.ts` already write specific, actionable text ("run `codex
 * login`", "Install it with `just install-usage-host`") that a generic
 * per-code mapping cannot improve on.
 */
const SERVICE_NAME = 'Codex';

/**
 * Codex/ChatGPT usage, below the Claude section — pure, props in only, same
 * constraint every other file in `components/` follows. See
 * `plans/codex-subscription-usage.md`.
 *
 * Copies `UsagePopup`'s three-state branch (loading / error / ready) rather
 * than inventing a fourth top-level state for the popup as a whole.
 */

export interface CodexUsageSectionProps {
  data: CodexUsagePopupData;
  now: Date;
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading Codex usage">
      <div className="bg-muted/60 h-[6.5rem] animate-pulse rounded-lg" />
    </div>
  );
}

export function CodexUsageSection({ data, now }: CodexUsageSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Codex</h2>

      {data.state === 'loading' && <LoadingState />}

      {data.state === 'error' && (
        <div className="flex flex-col items-start gap-1.5 rounded-lg border border-dashed px-3.5 py-3">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="text-pace-ahead size-4" aria-hidden="true" />
            {errorHeadline(data.error, SERVICE_NAME)}
          </div>
          <p className="text-muted-foreground text-xs">{data.error.message}</p>
        </div>
      )}

      {data.state === 'ready' && (
        <>
          {data.refreshError !== null && (
            <div className="border-pace-ahead/40 bg-pace-ahead-surface text-pace-ahead flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              <span>{data.refreshError.message} — showing the last known figures.</span>
            </div>
          )}
          <div className="flex flex-col gap-2">
            {data.windows.map((status) => (
              <UsageWindowCard key={status.kind} status={status} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
