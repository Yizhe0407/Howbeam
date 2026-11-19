import { PERSISTED_STEP_LIMITS } from '@/lib/storage/persistence-limits';
import { type Step } from '@/lib/storage/models';
import { useStepTextAutosave } from '@/lib/editor/editor-autosave';
import TextDraftRecoveries from './TextDraftRecoveries';
import TextSaveIssue from './TextSaveIssue';
import { t } from '@/lib/shared/i18n';

interface Props {
  step: Step;
  number: number;
  disabled?: boolean;
}

/** The step's heading, edited where the export prints it: above the screenshot. */
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

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="shrink-0 text-lg font-bold text-muted-foreground">{number}.</span>
        <input
          type="text"
          aria-label={t().editor.title.label(number)}
          value={value}
          maxLength={PERSISTED_STEP_LIMITS.maxStepTitleLength}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            e.currentTarget.blur();
          }}
          onBlur={() => void flush().catch(() => undefined)}
          disabled={disabled}
          placeholder={t().editor.title.placeholder}
          className="min-w-0 flex-1 rounded-md border-2 border-transparent bg-transparent px-2 py-1 text-lg leading-tight font-bold text-foreground outline-none transition-colors focus-ring placeholder:font-normal placeholder:text-muted-foreground hover:border-border-soft focus:border-border focus:bg-card disabled:opacity-60"
        />
      </div>
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
