import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { useStepDescriptionAutosave } from '@/lib/editor/editor-autosave';
import { Textarea } from '@/components/ui/textarea';
import DescriptionSaveIssue from './DescriptionSaveIssue';
import { t } from '@/lib/shared/i18n';

interface Props {
  step: Step;
  disabled?: boolean;
}

export default function DescriptionField({ step, disabled = false }: Props) {
  const { description, setDescription, saveIssue, flush } = useStepDescriptionAutosave(step);

  return (
    <div className="mt-4 flex w-full flex-col gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor={`description-${step.id}`} className="text-xs font-bold text-muted-foreground">
          {t().editor.description.label}
        </label>
      </div>
      <Textarea
        id={`description-${step.id}`}
        value={description}
        maxLength={PERSISTED_STEP_LIMITS.maxStepDescriptionLength}
        onChange={(e) => setDescription(e.target.value)}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder={t().editor.description.placeholder}
        className="min-h-16 resize-none px-3.5 py-3 text-sm leading-relaxed"
      />
      <DescriptionSaveIssue
        issue={saveIssue}
      />
    </div>
  );
}
