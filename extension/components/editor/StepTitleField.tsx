import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { useStepTextAutosave } from '@/lib/editor/editor-autosave';
import TextDraftRecoveries from './TextDraftRecoveries';
import TextSaveIssue from './TextSaveIssue';
import TextLengthHint from './TextLengthHint';
import { t } from '@/lib/shared/i18n';

interface Props {
  step: Step;
  number: number;
  disabled?: boolean;
}

/** The step's heading, edited in the row above the screenshot. `number` only names the field: the rail already shows it. */
export default function StepTitleField({ step, number, disabled = false }: Props) {
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
  } = useStepTextAutosave(step, 'title');
  const limit = PERSISTED_STEP_LIMITS.maxStepTitleLength;
  const lengthId = `title-length-${step.id}`;

  return (
    <div className="group/text flex w-full flex-col gap-2">
      <input
        type="text"
        aria-label={t().editor.title.label(number)}
        aria-describedby={lengthId}
        value={value}
        maxLength={limit}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.currentTarget.blur();
        }}
        onBlur={() => void flush().catch(() => undefined)}
        disabled={disabled}
        placeholder={t().editor.title.placeholder}
        className="h-10 w-full min-w-0 rounded-md border-2 border-transparent bg-transparent px-2 text-base font-bold text-foreground outline-none transition-colors focus-ring placeholder:font-normal placeholder:text-muted-foreground hover:border-border-soft focus:border-border focus:bg-card disabled:opacity-60"
      />
      <TextLengthHint id={lengthId} length={value.length} limit={limit} visibility="focus" className="-mt-1" />
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
