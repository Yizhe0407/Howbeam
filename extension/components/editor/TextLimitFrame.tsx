import { useState, type FocusEvent, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  /** What the field's `aria-describedby` points to; a frame drawn only as a picture of a field (a drag overlay) has none. */
  id?: string;
  length: number;
  limit: number;
  /** How many characters the last edit lost to the limit. */
  cutCount?: number;
  /** `focus`: the count shows only while the field has focus, or once the limit is reached. */
  visibility?: 'always' | 'focus';
  /** The box: border, background, padding and how the count lines up with the text. The field inside is bare. */
  className?: string;
  children: ReactNode;
}

/**
 * A text field's box with its character count inside, after the text. The count
 * keeps its place while hidden, so showing it never moves the field or rewraps its text;
 * what the limit cut off is shown beside it without taking any room.
 */
export default function TextLimitFrame({ id, length, limit, cutCount = 0, visibility = 'always', className, children }: Props) {
  const [focused, setFocused] = useState(false);
  const full = length >= limit;
  const shown = visibility === 'always' || full || focused;
  const cutNote = cutCount > 0 ? t().editor.textCut(limit, cutCount) : '';

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  }

  return (
    <div className={cn('flex min-w-0 gap-2 focus-ring-within', className)} onFocus={() => setFocused(true)} onBlur={handleBlur}>
      {children}
      <Tooltip open={focused && cutNote !== ''}>
        <TooltipTrigger asChild>
          <p
            id={id}
            aria-hidden={id ? undefined : true}
            className={cn(
              'pointer-events-none shrink-0 text-xs whitespace-nowrap tabular-nums',
              full ? 'text-danger' : 'text-muted-foreground',
              !shown && 'invisible',
            )}
          >
            <span aria-hidden="true">{`${length}/${limit}`}</span>
            <span className="sr-only">{t().editor.textLength(length, limit)}</span>
            {/* Only the cut is announced as it happens; the count is read with the field. */}
            {id && <span role="status" className="sr-only">{cutNote}</span>}
          </p>
        </TooltipTrigger>
        <TooltipContent>{cutNote}</TooltipContent>
      </Tooltip>
    </div>
  );
}
