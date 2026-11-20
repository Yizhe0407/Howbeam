import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';

interface Props {
  label: string;
  /** Shown on hover; defaults to `label`. */
  tooltip?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/** The icon-only actions along the bottom of a Library card. */
export default function CardIconButton({ label, tooltip = label, danger = false, disabled, onClick, children }: Props) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={cn('size-8 shrink-0', danger && 'hover:bg-danger-soft hover:text-danger')}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
