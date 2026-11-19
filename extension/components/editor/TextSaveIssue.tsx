import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { TextSaveIssue as SaveIssue } from '@/lib/editor/editor-autosave';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  issue: SaveIssue | null;
  savedValue: string;
  onOverwrite: () => Promise<void>;
  onKeepSaved: () => void;
  disabled?: boolean;
  className?: string;
}

function excerpt(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact || t().editor.saveIssue.savedEmpty;
}

/** Says, on the field itself, that its text is not saved and why. A conflict
 * with another tab offers the two ways out: overwrite, or take the saved text. */
export default function TextSaveIssue({
  issue,
  savedValue,
  onOverwrite,
  onKeepSaved,
  disabled = false,
  className = '',
}: Props) {
  const [overwriting, setOverwriting] = useState(false);
  if (!issue) return null;

  async function overwrite() {
    if (overwriting) return;
    setOverwriting(true);
    try {
      await onOverwrite();
    } catch {
      // The autosave hook turns every failure into `issue`: a repeated conflict
      // re-renders this card with the newer saved text, anything else replaces it.
    } finally {
      setOverwriting(false);
    }
  }

  if (issue !== 'conflict') {
    return (
      <p role="alert" className={cn('flex items-start gap-2 text-xs font-bold text-danger', className)}>
        <AlertCircle className="mt-px size-4 shrink-0" aria-hidden="true" />
        {issue === 'missing' ? t().editor.saveIssue.missing : t().editor.saveIssue.failed}
      </p>
    );
  }

  return (
    <section
      role="alert"
      className={cn('rounded-md border-2 border-recording bg-danger-soft p-3 text-xs text-foreground', className)}
    >
      <p className="flex items-center gap-2 font-bold">
        <AlertCircle className="size-4 shrink-0 text-danger" aria-hidden="true" />
        {t().editor.saveIssue.conflict}
      </p>
      <p className="mt-1 text-muted-foreground">{t().editor.saveIssue.conflictBody}</p>
      <p className="mt-1 break-words">{t().editor.saveIssue.savedVersion(excerpt(savedValue))}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled || overwriting}
          onClick={() => void overwrite()}
          className={cn(buttonVariants({ size: 'sm' }), 'h-7 px-2.5 text-xs')}
        >
          {t().editor.saveIssue.overwrite}
        </button>
        <button
          type="button"
          disabled={disabled || overwriting}
          onClick={onKeepSaved}
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 px-2.5 text-xs')}
        >
          {t().editor.saveIssue.keepSaved}
        </button>
      </div>
    </section>
  );
}
