import { Loader2, RotateCcw, X } from 'lucide-react';
import { noticeStyle } from '@/components/shared/AppToaster';
import { t } from '@/lib/shared/i18n';

interface Props {
  message: string;
  /** A second, quieter line, e.g. that the undo this one replaced is now final. */
  note?: string;
  pending?: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

/** The content of the undo notice; `useUndoNotice` puts it on the notice stack. */
export default function UndoNotice({ message, note, pending = false, onUndo, onDismiss }: Props) {
  return (
    <div role="status" style={{ ...noticeStyle, maxWidth: 'calc(100vw - 2rem)', padding: '6px 6px 6px 14px' }} className="flex items-center gap-2">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{message}</span>
        {note && <span className="truncate text-xs font-normal text-muted-foreground">{note}</span>}
      </span>
      <button
        type="button"
        onClick={onUndo}
        disabled={pending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border-2 border-border bg-selected px-3 font-bold text-on-accent outline-none transition-colors focus-ring hover:brightness-95 disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        {pending ? t().common.restoring : t().common.restore}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        disabled={pending}
        aria-label={t().editor.undo.close}
        className="flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors focus-ring hover:bg-secondary hover:text-foreground disabled:opacity-60"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
