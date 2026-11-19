import { useState } from 'react';
import type { RestoredTextDraft } from '@/lib/editor/editor-draft-journal';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/shared/utils';
import { intlLocale, t } from '@/lib/shared/i18n';

interface Props {
  recoveries: RestoredTextDraft[];
  /** Returns false when the journal refused the restore (the field is untouched). */
  onRestore: (writerId: string) => boolean;
  onDiscard: (writerId: string) => void;
  onConfirmOverwrite?: () => Promise<void>;
  disabled?: boolean;
  className?: string;
}

function excerpt(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact || t().editor.drafts.empty;
}

export default function TextDraftRecoveries({
  recoveries,
  onRestore,
  onDiscard,
  onConfirmOverwrite,
  disabled = false,
  className = '',
}: Props) {
  const [confirmingWriterId, setConfirmingWriterId] = useState<string | null>(null);
  const [restoreFailedWriterId, setRestoreFailedWriterId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  if (recoveries.length === 0) return null;

  function restoreDraft(writerId: string) {
    if (onRestore(writerId)) {
      setRestoreFailedWriterId(null);
      setConfirmingWriterId(writerId);
      return;
    }
    // Restore can fail (storage pressure) or the record can be cleaned meanwhile; field stays untouched.
    setRestoreFailedWriterId(writerId);
    setConfirmingWriterId((current) => (current === writerId ? null : current));
  }

  async function confirmOverwrite() {
    if (!onConfirmOverwrite || confirming) return;
    setConfirming(true);
    try {
      await onConfirmOverwrite();
      setConfirmingWriterId(null);
    } catch {
      // The journal remains intact, so the user can retry the explicit confirmation.
    } finally {
      setConfirming(false);
    }
  }

  return (
    <section
      aria-label={t().editor.drafts.label}
      className={`rounded-md border-2 border-border bg-warning-soft p-3 text-xs text-foreground ${className}`}
    >
      <p className="font-bold">{t().editor.drafts.found(recoveries.length)}</p>
      <p className="mt-1 text-muted-foreground">
        {t().editor.drafts.intro}
      </p>
      <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto pr-1">
        {recoveries.map((recovery, index) => {
          const itemNumber = index + 1;
          const date = new Date(recovery.updatedAt);
          return (
            <li
              key={recovery.writerId}
              className="rounded-md border-2 border-border-soft bg-card p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <time dateTime={date.toISOString()} className="font-bold text-muted-foreground">
                  {date.toLocaleString(intlLocale())}
                </time>
                {recovery.conflictsWithPersistedValue && (
                  <span className="rounded-full border-2 border-recording bg-danger-soft px-2 py-0.5 font-bold text-danger">
                    {t().editor.drafts.conflict}
                  </span>
                )}
              </div>
              <p className="mt-1 break-words text-foreground">{excerpt(recovery.value)}</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t().editor.drafts.loadLabel(itemNumber)}
                  onClick={() => restoreDraft(recovery.writerId)}
                  className={cn(buttonVariants({ size: 'sm' }), 'h-7 px-2.5 text-xs')}
                >
                  {t().editor.drafts.load}
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t().editor.drafts.discardLabel(itemNumber)}
                  onClick={() => onDiscard(recovery.writerId)}
                  className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-7 px-2.5 text-xs text-danger hover:bg-danger-soft hover:text-danger')}
                >
                  {t().editor.drafts.discard}
                </button>
              </div>
              {restoreFailedWriterId === recovery.writerId && (
                <p role="alert" className="mt-1 font-bold text-danger">
                  {t().editor.drafts.loadFailed}
                </p>
              )}
              {confirmingWriterId === recovery.writerId && onConfirmOverwrite && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t-2 border-border-soft pt-2">
                  <span className="text-muted-foreground">{t().editor.drafts.loaded}</span>
                  <button
                    type="button"
                    disabled={disabled || confirming}
                    aria-label={t().editor.drafts.confirmLabel(itemNumber)}
                    onClick={() => void confirmOverwrite()}
                    className={cn(buttonVariants({ size: 'sm' }), 'h-7 px-2.5 text-xs')}
                  >
                    {t().editor.drafts.confirm}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
