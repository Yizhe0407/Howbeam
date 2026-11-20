import { stepDescriptionLimit, type Step } from '@/lib/storage/models';
import { useStepTextAutosave } from '@/lib/editor/editor-autosave';
import { useAutoHideScrollbar } from '@/lib/editor/use-auto-hide-scrollbar';
import TextDraftRecoveries from './TextDraftRecoveries';
import TextSaveIssue from './TextSaveIssue';
import TextLimitFrame from './TextLimitFrame';
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
      <TextLimitFrame
        id={lengthId}
        length={value.length}
        limit={limit}
        cutCount={cutCount}
        className="items-end rounded-md border-2 border-input bg-card py-2 pr-3 has-[:disabled]:opacity-50"
      >
        <textarea
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
          className="app-scrollbar-autohide field-sizing-content min-h-lh max-h-36 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
      </TextLimitFrame>
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
