import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '@/lib/shared/utils';

/** Radix provides the roving focus and arrow-key selection; the item is a bare
 * sticker-style button that callers lay out with `className`. */
function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn('grid gap-2', className)} {...props} />;
}

function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        'rounded-md border-2 border-border bg-surface-raised text-foreground outline-none transition-colors focus-ring disabled:pointer-events-none disabled:opacity-40 data-[state=checked]:bg-selected data-[state=checked]:text-on-accent data-[state=unchecked]:hover:bg-secondary',
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupItem };
