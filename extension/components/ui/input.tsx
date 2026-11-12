import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/**
 * The bordered text field. Chrome-less inline editors (rename-on-click titles,
 * bordered search boxes) should not use this — they must stay borderless.
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-10 w-full min-w-0 rounded-md border-2 border-input bg-card px-3 py-1 text-sm text-foreground focus-ring transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-bold file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
