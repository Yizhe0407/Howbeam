import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  /** The full text, shown when the trigger cuts it off. */
  content: ReactNode;
  /** The element that truncates or line-clamps its own text. */
  children: ReactElement;
}

function isClipped(element: HTMLElement): boolean {
  return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight;
}

/** Pointed at, or reached from the keyboard. Focus moved by the page itself (the
 * editor focuses its heading after opening a step) is neither. */
function isAskedFor(element: HTMLElement): boolean {
  return element.matches(':hover') || element.matches(':focus-visible');
}

/**
 * The full text of a name the layout cuts off. It opens only while the text is
 * actually clipped, so a name that fits never repeats itself on hover.
 */
export default function OverflowTooltip({ content, children }: Props) {
  const trigger = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const element = trigger.current;
        setOpen(next && element !== null && isClipped(element) && isAskedFor(element));
      }}
    >
      {/* Radix types the trigger as a button; with asChild it is whatever element `children` is. */}
      <TooltipTrigger asChild ref={(node) => { trigger.current = node; }}>{children}</TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">{content}</TooltipContent>
    </Tooltip>
  );
}
