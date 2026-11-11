import { AlertCircle } from 'lucide-react';
import type { DescriptionSaveIssue as SaveIssue } from '@/lib/editor/editor-autosave';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';

interface Props {
  issue: SaveIssue | null;
  className?: string;
}

/** Says, on the field itself, that its text is not saved and why. */
export default function DescriptionSaveIssue({ issue, className = '' }: Props) {
  if (!issue) return null;
  return (
    <p role="alert" className={cn('flex items-start gap-2 text-xs font-bold text-danger', className)}>
      <AlertCircle className="mt-px size-4 shrink-0" aria-hidden="true" />
      {issue === 'missing' ? t().editor.saveIssue.missing : t().editor.saveIssue.failed}
    </p>
  );
}
