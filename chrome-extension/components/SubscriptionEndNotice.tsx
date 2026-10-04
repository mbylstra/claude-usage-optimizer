import { AlertTriangle } from 'lucide-react';

/** Shown only when the provider reports a scheduled end to paid access. */
export function SubscriptionEndNotice({ accessEndsAt }: { accessEndsAt: Date }) {
  const endDate = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(accessEndsAt);

  return (
    <div className="border-pace-ahead/40 bg-pace-ahead-surface text-pace-ahead flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs">
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>Subscription cancelled. Access ends on {endDate}.</span>
    </div>
  );
}
