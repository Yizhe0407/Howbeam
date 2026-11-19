import { stepDescriptionLimit, type Step } from '@/lib/storage/models';
import { useStepTextAutosave } from '@/lib/editor/editor-autosave';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';
import { Textarea } from '@/components/ui/textarea';
import TextDraftRecoveries from './TextDraftRecoveries';
import TextSaveIssue from './TextSaveIssue';
import TextLengthHint from './TextLengthHint';
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
    cutCount,
  } = useStepTextAutosave(step, 'description');
  const limit = stepDescriptionLimit(step);
  const lengthId = `description-length-${step.id}`;
  const scrollbar = useAutoHideScrollbar<HTMLTextAreaElement>();

  return (
    <div className="flex w-full flex-col gap-2">
      <label htmlFor={`description-${step.id}`} className="sr-only">
        {t().editor.description.label}
      </label>
      <Textarea
        id={`description-${step.id}`}
        value={value}
        maxLength={limit}
        aria-describedby={lengthId}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder={t().editor.description.placeholder}
        {...scrollbar}
        rows={1}
        // Starts one line tall and grows with the text, so the screenshot above keeps the height until it is needed.
        // The auto-hide scrollbar reserves a 10px gutter on both edges, so 4px of padding keeps the 14px text inset.
        className="app-scrollbar-autohide min-h-10 max-h-40 resize-none overflow-y-auto px-1 py-2 text-sm leading-relaxed"
      />
      <TextLengthHint id={lengthId} length={value.length} limit={limit} cutCount={cutCount} className="-mt-1" />
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
