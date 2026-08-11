import type { ComponentProps } from 'react';
import { cn } from './utils';

/**
 * The `[&::-webkit-*]` rules are for `type="time"`: Chrome renders a spin button
 * and a clock picker inside the field, both of which ignore the surrounding
 * colours and look wrong in dark mode.
 */
export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring/50 flex h-8 w-full rounded-md border px-2.5 py-1 text-sm transition-colors outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        '[&::-webkit-calendar-picker-indicator]:opacity-60 dark:[&::-webkit-calendar-picker-indicator]:invert',
        '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        className,
      )}
      {...props}
    />
  );
}
