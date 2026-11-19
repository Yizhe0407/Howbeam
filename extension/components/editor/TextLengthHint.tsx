import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  id: string;
  length: number;
  limit: number;
  /** How many characters the last edit lost to the limit. */
  cutCount?: number;
  /** `focus`: shown only while a field inside the nearest `group/text` has focus, or once the limit is reached. */
  visibility?: 'always' | 'focus';
  className?: string;
}

/** How many characters a field holds against its storage limit, and what the limit cut off; the field points to it with `aria-describedby`. */
export default function TextLengthHint({ id, length, limit, cutCount = 0, visibility = 'always', className }: Props) {
  const full = length >= limit;
  return (
    <p
      id={id}
      className={cn(
        'self-end text-right text-xs tabular-nums',
        full ? 'text-danger' : 'text-muted-foreground',
        visibility === 'focus' && !full && 'hidden group-focus-within/text:block',
        className,
      )}
    >
      {/* Only the cut is announced as it happens; the count is read with the field. */}
      <span role="status">{cutCount > 0 ? `${t().editor.textCut(limit, cutCount)} · ` : ''}</span>
      {t().editor.textLength(length, limit)}
    </p>
  );
}
