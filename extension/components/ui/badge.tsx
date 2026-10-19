import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/** Every badge is a 2px-outlined pill. */
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border-2 border-border px-2.5 py-0.5 text-xs font-bold outline-none transition-colors focus-ring aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
        outline: 'bg-card text-foreground [a&]:hover:bg-secondary',
        ghost: 'border-transparent [a&]:hover:bg-secondary',
        link: 'border-transparent text-brand-text underline-offset-4 [a&]:hover:underline',
        /** Soft red rather than solid `destructive`: reports an operation in progress, not a failure. */
        status: 'gap-1.5 border-recording bg-danger-soft px-2.5 py-1 text-xs text-danger',
        /** A dashed "add" control, for actions that create something. */
        dashedAction:
          'relative h-8 gap-1 overflow-visible border-transparent bg-transparent px-3 py-1 text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge };
