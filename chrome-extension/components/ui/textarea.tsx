import type { ComponentProps } from 'react';
import { cn } from './utils';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 flex min-h-16 w-full rounded-md border px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
