import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { saveStepText, StepTextConflictError, StepNotFoundError } from '../storage/step-repository';
import { stepTextLimit, type Step, type StepTextField } from '../storage/models';
import { clampStoredText, normalizeStoredLine, normalizeStoredText } from '../storage/stored-text';
import {
  clearMatchingCommittedTextDrafts,
  TEXT_DRAFT_KEY_PREFIX,
  discardTextDraft,
  getTextDraftWriterId,
  readTextDrafts,
  writeTextDraft,
  type RestoredTextDraft,
} from './editor-draft-journal';
import { t } from '@/lib/shared/i18n';

type SaveCallback = () => Promise<void>;

interface EditorSaveRegistry {
  register: (id: string, save: SaveCallback) => () => void;
  flushAll: () => Promise<void>;
}

const EditorSaveContext = createContext<EditorSaveRegistry | null>(null);

export function EditorSaveProvider({ children }: { children: ReactNode }) {
  const saves = useRef(new Map<string, SaveCallback>());

  const register = useCallback((id: string, save: SaveCallback) => {
    saves.current.set(id, save);
    return () => {
      if (saves.current.get(id) === save) saves.current.delete(id);
    };
  }, []);

  const flushAll = useCallback(async () => {
    await Promise.all([...saves.current.values()].map((save) => save()));
  }, []);

  useEffect(() => {
    // This is only a best-effort fast path. The synchronous localStorage draft
    // journal is the durable close/reload guarantee because browsers may abort
    // IndexedDB work after pagehide.
    const flushBeforeLeaving = () => {
      void flushAll().catch((error) => {
        if (!(error instanceof DraftConfirmationRequiredError)) {
          console.error('[howbeam] failed to save step text before leaving the editor', error);
        }
      });
    };
    window.addEventListener('pagehide', flushBeforeLeaving);
    return () => window.removeEventListener('pagehide', flushBeforeLeaving);
  }, [flushAll]);

  return <EditorSaveContext.Provider value={{ register, flushAll }}>{children}</EditorSaveContext.Provider>;
}

export function useEditorSaveRegistry(): EditorSaveRegistry {
  const registry = useContext(EditorSaveContext);
  if (!registry) throw new Error('useEditorSaveRegistry must be used inside EditorSaveProvider.');
  return registry;
}

/** Why the text in the field is not (yet) the stored value:
 * - `conflict`: the stored value changed elsewhere (another tab) after
 *   this field loaded it; nothing is saved until the user picks a version.
 * - `missing`: the step no longer exists, so nothing can be saved.
 * - `failed`: the last save failed for another reason; the next edit retries.
 * The typed text stays journaled in every case. */
export type TextSaveIssue = 'conflict' | 'missing' | 'failed';

export interface TextAutosaveResult {
  value: string;
  setValue: (value: string) => void;
  saveIssue: TextSaveIssue | null;
  /** The stored value the field conflicts with (meaningful while `saveIssue` is `conflict`). */
  savedValue: string;
  /** Resolves a conflict by dropping this field's text for the stored value. */
  keepSaved: () => void;
  recoveries: RestoredTextDraft[];
  /** Returns false when the journal rejected the copy (quota); the field then
   * keeps its current text so the UI can surface the failure. */
  restoreRecovery: (writerId: string) => boolean;
  discardRecovery: (writerId: string) => void;
  flush: () => Promise<void>;
  confirmOverwrite: () => Promise<void>;
  /** How many characters the last edit lost to the field's limit; 0 when none. */
  cutCount: number;
}

/** Thrown by flush() while an explicit user confirmation is outstanding. The
 * message is localized because it can surface in UI error paths. */
export class DraftConfirmationRequiredError extends Error {
  constructor() {
    super(t().editor.draftConfirmationRequired);
    this.name = 'DraftConfirmationRequiredError';
  }
}

/** A title is one line; a description keeps its line breaks. Both are cut to
 * storage's limit, because `maxLength` does not hold during IME composition. */
function normalizeStepText(field: StepTextField, value: string, limit: number): { text: string; cut: number } {
  const normalized = field === 'title' ? normalizeStoredLine(value) : normalizeStoredText(value);
  const text = clampStoredText(normalized, limit);
  return { text, cut: normalized.length - text.length };
}

function logAutosaveFailure(message: string): (error: unknown) => void {
  return (error) => {
    // Confirmation is surfaced through the recovery UI, not the console.
    if (!(error instanceof DraftConfirmationRequiredError)) console.error(message, error);
  };
}

/** Keeps the draft editable while writes are pending and serializes updates so
 * an older response can never replace text entered during the request. Every
 * change is first journaled synchronously, so closing the editor cannot create
 * an IndexedDB-unload data-loss window. Concurrent tabs use separate writers;
 * foreign drafts require an explicit load and confirmation. */
export function useStepTextAutosave(
  step: Step,
  field: StepTextField,
  delay = 650,
): TextAutosaveResult {
  const { register } = useEditorSaveRegistry();
  const writerId = useRef(getTextDraftWriterId());
  const stored = step[field];
  const limit = stepTextLimit(step, field);
  // Reading the journal scans all of localStorage and performs destructive
  // cleanup, so it must run once per mounted field, never per render. A plain
  // `useRef(readTextDrafts(...))` re-evaluates its argument on every
  // render; the lazy useState initializer below runs only on the initial one.
  const [initial] = useState(() => {
    const candidates = readTextDrafts(
      { id: step.id, sessionId: step.sessionId, field, value: stored },
      writerId.current,
    );
    const restored = candidates.find((candidate) => candidate.belongsToCurrentWriter) ?? null;
    // A journal record can predate the stored-text rule; normalize it like typed text.
    const normalized = restored ? normalizeStepText(field, restored.value, limit) : { text: stored, cut: 0 };
    return {
      value: normalized.text,
      cut: normalized.cut,
      recoveries: candidates.filter((candidate) => !candidate.belongsToCurrentWriter),
      confirmationRequired: Boolean(restored?.conflictsWithPersistedValue),
    };
  });
  const [value, setValueState] = useState(initial.value);
  const [cutCount, setCutCount] = useState(initial.cut);
  const [recoveries, setRecoveries] = useState<RestoredTextDraft[]>(initial.recoveries);
  const [saveIssue, setSaveIssue] = useState<TextSaveIssue | null>(
    initial.confirmationRequired ? 'conflict' : null,
  );
  const [savedValue, setSavedValue] = useState(stored);
  const draft = useRef(initial.value);
  const persisted = useRef(stored);
  const lastExternalValue = useRef(stored);
  const stepId = useRef(step.id);
  const sessionId = useRef(step.sessionId);
  const target = useCallback(() => ({ id: stepId.current, sessionId: sessionId.current, field }), [field]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const confirmationRequired = useRef(initial.confirmationRequired);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Gates saving on an explicit choice. `conflict` is also shown on the field;
   * a draft loaded from another tab (`restored`) is confirmed on its own card. */
  const requireConfirmation = useCallback((reason: 'conflict' | 'restored' | null) => {
    confirmationRequired.current = reason !== null;
    if (reason === 'conflict') setSavedValue(persisted.current);
    setSaveIssue((current) => (
      reason === 'conflict' ? 'conflict' : current === 'conflict' ? null : current
    ));
  }, []);

  const refreshRecoveries = useCallback(() => {
    const candidates = readTextDrafts({ ...target(), value: persisted.current }, writerId.current);
    if (mounted.current) setRecoveries(candidates.filter((candidate) => !candidate.belongsToCurrentWriter));
  }, [target]);

  const performFlush = useCallback(async (confirmed: boolean) => {
    clearTimer();
    if (confirmationRequired.current && !confirmed) {
      throw new DraftConfirmationRequiredError();
    }
    if (confirmed) requireConfirmation(null);
    if (activeSave.current) return activeSave.current;
    if (draft.current === persisted.current) {
      // clearMatching covers every writer's record for this step — including
      // this writer's own — so no targeted clear is needed alongside it.
      clearMatchingCommittedTextDrafts(target(), persisted.current);
      refreshRecoveries();
      return;
    }

    const operation = (async () => {
      while (draft.current !== persisted.current) {
        // A conflict observed while an earlier iteration was saving (the
        // stored value changed under this field) must stop the loop too.
        if (confirmationRequired.current) throw new DraftConfirmationRequiredError();
        const nextValue = draft.current;
        let storedValue: string;
        try {
          storedValue = await saveStepText(stepId.current, field, nextValue, persisted.current);
        } catch (saveError) {
          if (
            saveError instanceof StepTextConflictError &&
            saveError.actualValue === nextValue
          ) {
            // Another tab already committed exactly this text; adopt it as saved.
            storedValue = nextValue;
          } else if (saveError instanceof StepTextConflictError) {
            // Another tab committed a different value while this one was
            // typing. Rebase on the committed value, keep this tab's text
            // journaled against the new baseline, and demand an explicit
            // overwrite instead of silent last-write-wins.
            persisted.current = saveError.actualValue;
            writeTextDraft({ ...target(), value: saveError.actualValue }, draft.current, writerId.current);
            requireConfirmation('conflict');
            refreshRecoveries();
            throw new DraftConfirmationRequiredError();
          } else {
            // StepNotFoundError: the row is gone (deleted in another tab, or
            // locally with an undo pending). Nothing was committed, so the
            // journal record must survive as the only durable copy of the
            // typed text — an undo that restores the step resurfaces it as a
            // recoverable draft. Every other failure propagates unchanged too,
            // and the field says the text is not saved.
            if (mounted.current) setSaveIssue(saveError instanceof StepNotFoundError ? 'missing' : 'failed');
            throw saveError;
          }
        }
        if (mounted.current) setSaveIssue((current) => (current === 'conflict' ? current : null));
        // Compare against what storage kept from now on, never against what was
        // sent: a value that differs only by stored-text normalization would
        // otherwise look like a conflict on the next save.
        persisted.current = storedValue;
        if (draft.current === nextValue && storedValue !== nextValue) {
          draft.current = storedValue;
          if (mounted.current) setValueState(storedValue);
        }
        // See above: clearMatching is a superset of the targeted clear.
        clearMatchingCommittedTextDrafts(target(), storedValue);
        refreshRecoveries();
      }
    })();

    activeSave.current = operation;
    try {
      await operation;
    } finally {
      if (activeSave.current === operation) activeSave.current = null;
    }
  }, [clearTimer, field, refreshRecoveries, requireConfirmation, target]);

  const flush = useCallback(() => performFlush(false), [performFlush]);
  const confirmOverwrite = useCallback(() => performFlush(true), [performFlush]);

  const setValue = useCallback(
    (typedValue: string) => {
      // Normalize as the user types, so the draft is exactly what storage will keep.
      const { text: nextValue, cut } = normalizeStepText(field, typedValue, limit);
      setCutCount(cut);
      const journaled = writeTextDraft({ ...target(), value: persisted.current }, nextValue, writerId.current);
      draft.current = nextValue;
      setValueState(nextValue);
      clearTimer();
      if (confirmationRequired.current || nextValue === persisted.current) return;
      // The debounce only trades latency for fewer IndexedDB writes while the
      // synchronous journal already guarantees durability. When the journal
      // write failed (record cap, size cap, quota), IndexedDB is the only
      // remaining destination, so flush immediately instead of gating the
      // timer on journal success — otherwise typed text would only persist on
      // blur or unmount.
      timer.current = setTimeout(() => {
        void flush().catch(logAutosaveFailure(`[howbeam] step ${field} autosave failed`));
      }, journaled ? delay : 0);
    },
    [clearTimer, delay, field, flush, limit, target],
  );

  const restoreRecovery = useCallback((recoveryWriterId: string): boolean => {
    const recovery = recoveries.find((candidate) => candidate.writerId === recoveryWriterId);
    if (!recovery) return false;
    clearTimer();
    const { text: recovered, cut } = normalizeStepText(field, recovery.value, limit);
    const journaled = writeTextDraft({ ...target(), value: persisted.current }, recovered, writerId.current);
    // The journal write's integrity pass may have cleaned records that are
    // still on screen; re-read so the visible list matches storage.
    refreshRecoveries();
    if (!journaled) return false;
    draft.current = recovered;
    setValueState(recovered);
    setCutCount(cut);
    requireConfirmation('restored');
    return true;
  }, [clearTimer, field, limit, recoveries, refreshRecoveries, requireConfirmation, target]);

  const keepSaved = useCallback(() => {
    if (activeSave.current) return;
    clearTimer();
    discardTextDraft(target(), writerId.current);
    draft.current = persisted.current;
    setValueState(persisted.current);
    setCutCount(0);
    requireConfirmation(null);
    refreshRecoveries();
  }, [clearTimer, refreshRecoveries, requireConfirmation, target]);

  const discardRecovery = useCallback((recoveryWriterId: string) => {
    discardTextDraft(target(), recoveryWriterId);
    refreshRecoveries();
  }, [refreshRecoveries, target]);

  useEffect(() => {
    // Only these fields identify the draft, so the effect reads them through
    // a narrowed identity object instead of depending on the `step` object,
    // whose reference changes on unrelated edits.
    const external = { id: step.id, sessionId: step.sessionId, field, value: stored };
    const previousExternalValue = lastExternalValue.current;
    lastExternalValue.current = external.value;
    stepId.current = external.id;
    sessionId.current = external.sessionId;
    persisted.current = external.value;

    if (draft.current === previousExternalValue || draft.current === external.value) {
      draft.current = external.value;
      setValueState(external.value);
      setCutCount(0);
      requireConfirmation(null);
      // clearMatching covers this writer's record too; see performFlush.
      clearMatchingCommittedTextDrafts(external, external.value);
    } else if (external.value !== previousExternalValue) {
      clearTimer();
      writeTextDraft(external, draft.current, writerId.current);
      requireConfirmation('conflict');
    }
    refreshRecoveries();
  }, [clearTimer, field, refreshRecoveries, requireConfirmation, step.id, step.sessionId, stored]);

  useEffect(() => register(`${field}:${step.id}`, flush), [field, flush, register, step.id]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key?.startsWith(TEXT_DRAFT_KEY_PREFIX)) {
        refreshRecoveries();
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [refreshRecoveries]);

  useEffect(() => {
    mounted.current = true;
    if (draft.current !== persisted.current && !confirmationRequired.current) {
      timer.current = setTimeout(() => {
        void flush().catch(logAutosaveFailure('[howbeam] saving a recovered draft failed'));
      }, delay);
    }
    return () => {
      mounted.current = false;
      clearTimer();
      if (!confirmationRequired.current) {
        void flush().catch(logAutosaveFailure(`[howbeam] saving before unmounting a step ${field} field failed`));
      }
    };
  }, [clearTimer, delay, field, flush]);

  return {
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
  };
}
