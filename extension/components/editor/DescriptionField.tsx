import { stepDescriptionLimit, type Step } from '@/lib/storage/models';
import { useStepTextAutosave } from '@/lib/editor/editor-autosave';
import { Textarea } from '@/components/ui/textarea';
import TextDraftRecoveries from './TextDraftRecoveries';
import TextSaveIssue from './TextSaveIssue';
import { t } from '@/lib/shared/i18n';

interface Props {
  step: Step;
  disabled?: boolean;
}

export default function DescriptionField({ step, disabled = false }: Props) {
  const {
    value,
    setValue,
    saveIssue,
    savedValue,
    keepSaved,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    confirmOverwrite,
  } = useStepTextAutosave(step, 'description');

  return (
    <div className="flex w-full flex-col gap-2">
      <label htmlFor={`description-${step.id}`} className="sr-only">
        {t().editor.description.label}
      </label>
      <Textarea
        id={`description-${step.id}`}
        value={value}
        maxLength={stepDescriptionLimit(step)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder={t().editor.description.placeholder}
        rows={1}
        // Starts one line tall and grows with the text, so the screenshot above keeps the height until it is needed.
        className="app-scrollbar min-h-10 max-h-40 resize-none overflow-y-auto px-3.5 py-2 text-sm leading-relaxed"
      />
      <TextSaveIssue
        issue={saveIssue}
        savedValue={savedValue}
        onOverwrite={confirmOverwrite}
        onKeepSaved={keepSaved}
        disabled={disabled}
      />
      <TextDraftRecoveries
        recoveries={recoveries}
        onRestore={restoreRecovery}
        onDiscard={discardRecovery}
        onConfirmOverwrite={() => confirmOverwrite()}
        disabled={disabled}
      />
    </div>
  );
}
