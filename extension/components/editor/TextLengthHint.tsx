import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  id: string;
  length: number;
  limit: number;
  /** `focus`: shown only while a field inside the nearest `group/text` has focus, or once the limit is reached. */
  visibility?: 'always' | 'focus';
  className?: string;
}

/** How many characters a field holds against its storage limit; the field points to it with `aria-describedby`. */
export default function TextLengthHint({ id, length, limit, visibility = 'always', className }: Props) {
  const full = length >= limit;
  return (
    <p
      id={id}
      className={cn(
        'self-end text-xs tabular-nums',
        full ? 'text-danger' : 'text-muted-foreground',
        visibility === 'focus' && !full && 'hidden group-focus-within/text:block',
        className,
      )}
    >
      {t().editor.textLength(length, limit)}
    </p>
  );
}
