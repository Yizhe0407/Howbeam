import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/**
 * Sticker buttons: every filled or outlined variant carries the 2px ink
 * outline; `ghost` is the only borderless one, for dense icon toolbars. The
 * border is reserved (transparent) on ghost too, so swapping variants never
 * shifts layout.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border-2 text-sm font-bold whitespace-nowrap focus-ring transition-colors outline-none active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'border-border bg-primary text-primary-foreground hover:bg-sora-hover',
        destructive: 'border-border bg-destructive text-destructive-foreground hover:bg-recording-hover',
        outline: 'border-border bg-card text-foreground hover:bg-secondary',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:bg-tamago hover:text-on-accent',
        ghost: 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground',
        link: 'border-transparent text-brand-text underline-offset-4 hover:underline',
        success: 'border-border bg-matcha text-on-accent hover:brightness-95',
      },
      size: {
        default: 'h-10 px-4 has-[>svg]:px-3.5',
        sm: 'h-8 gap-1.5 px-3 text-[13px] has-[>svg]:px-2.5',
        lg: 'h-12 px-6 text-base has-[>svg]:px-5',
        icon: 'size-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
