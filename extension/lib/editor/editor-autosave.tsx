import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { saveStepDescription, StepDescriptionConflictError, StepNotFoundError } from '../storage/step-repository';
import { type Step } from '../storage/models';
import { normalizeStoredText } from '../storage/stored-text';
import {
  clearMatchingCommittedDescriptionDrafts,
  DESCRIPTION_DRAFT_KEY_PREFIX,
  discardDescriptionDraft,
  getDescriptionDraftWriterId,
  readDescriptionDrafts,
  writeDescriptionDraft,
  type RestoredDescriptionDraft,
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
          console.error('[howbeam] failed to save descriptions before leaving the editor', error);
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

/** Why the text in the field is not (yet) the stored description:
 * - `conflict`: the stored description changed elsewhere (another tab) after
 *   this field loaded it; nothing is saved until the user picks a version.
 * - `missing`: the step no longer exists, so nothing can be saved.
 * - `failed`: the last save failed for another reason; the next edit retries.
 * The typed text stays journaled in every case. */
export type DescriptionSaveIssue = 'conflict' | 'missing' | 'failed';

export interface DescriptionAutosaveResult {
  description: string;
  setDescription: (description: string) => void;
  saveIssue: DescriptionSaveIssue | null;
  /** The stored description the field conflicts with (meaningful while `saveIssue` is `conflict`). */
  savedDescription: string;
  /** Resolves a conflict by dropping this field's text for the stored description. */
  keepSaved: () => void;
  recoveries: RestoredDescriptionDraft[];
  /** Returns false when the journal rejected the copy (quota); the field then
   * keeps its current text so the UI can surface the failure. */
  restoreRecovery: (writerId: string) => boolean;
  discardRecovery: (writerId: string) => void;
  flush: () => Promise<void>;
  confirmOverwrite: () => Promise<void>;
}

/** Thrown by flush() while an explicit user confirmation is outstanding. The
 * message is localized because it can surface in UI error paths. */
export class DraftConfirmationRequiredError extends Error {
  constructor() {
    super(t().editor.draftConfirmationRequired);
    this.name = 'DraftConfirmationRequiredError';
  }
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
export function useStepDescriptionAutosave(
  step: Step,
  onChange: () => void | Promise<void>,
  delay = 650,
): DescriptionAutosaveResult {
  const { register } = useEditorSaveRegistry();
  const writerId = useRef(getDescriptionDraftWriterId());
  // Reading the journal scans all of localStorage and performs destructive
  // cleanup, so it must run once per mounted field, never per render. A plain
  // `useRef(readDescriptionDrafts(...))` re-evaluates its argument on every
  // render; the lazy useState initializer below runs only on the initial one.
  const [initial] = useState(() => {
    const candidates = readDescriptionDrafts(step, writerId.current);
    const restored = candidates.find((candidate) => candidate.belongsToCurrentWriter) ?? null;
    return {
      // A journal record can predate the stored-text rule; normalize it like typed text.
      description: restored ? normalizeStoredText(restored.description) : step.description,
      recoveries: candidates.filter((candidate) => !candidate.belongsToCurrentWriter),
      confirmationRequired: Boolean(restored?.conflictsWithPersistedValue),
    };
  });
  const [description, setDescriptionState] = useState(initial.description);
  const [recoveries, setRecoveries] = useState<RestoredDescriptionDraft[]>(initial.recoveries);
  const [saveIssue, setSaveIssue] = useState<DescriptionSaveIssue | null>(
    initial.confirmationRequired ? 'conflict' : null,
  );
  const [savedDescription, setSavedDescription] = useState(step.description);
  const draft = useRef(initial.description);
  const persisted = useRef(step.description);
  const lastExternalValue = useRef(step.description);
  const stepId = useRef(step.id);
  const sessionId = useRef(step.sessionId);
  const onChangeRef = useRef(onChange);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const confirmationRequired = useRef(initial.confirmationRequired);

  // Writing a ref during render breaks under concurrent rendering, where a
  // render can be discarded. Committing it in an effect keeps the latest
  // callback available to the save loop, which only ever runs from a timer,
  // a blur, or an explicit flush — always after the commit.
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Gates saving on an explicit choice. `conflict` is also shown on the field;
   * a draft loaded from another tab (`restored`) is confirmed on its own card. */
  const requireConfirmation = useCallback((reason: 'conflict' | 'restored' | null) => {
    confirmationRequired.current = reason !== null;
    if (reason === 'conflict') setSavedDescription(persisted.current);
    setSaveIssue((current) => (
      reason === 'conflict' ? 'conflict' : current === 'conflict' ? null : current
    ));
  }, []);

  const refreshRecoveries = useCallback(() => {
    const candidates = readDescriptionDrafts(
      { id: stepId.current, sessionId: sessionId.current, description: persisted.current },
      writerId.current,
    );
    if (mounted.current) setRecoveries(candidates.filter((candidate) => !candidate.belongsToCurrentWriter));
  }, []);

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
      clearMatchingCommittedDescriptionDrafts(
        { id: stepId.current, sessionId: sessionId.current },
        persisted.current,
      );
      refreshRecoveries();
      return;
    }

    const operation = (async () => {
      while (draft.current !== persisted.current) {
        // A conflict observed while an earlier iteration was saving (the
        // stored value changed under this field) must stop the loop too.
        if (confirmationRequired.current) throw new DraftConfirmationRequiredError();
        const nextDescription = draft.current;
        let storedDescription: string;
        try {
          storedDescription = await saveStepDescription(stepId.current, nextDescription, persisted.current);
        } catch (saveError) {
          if (
            saveError instanceof StepDescriptionConflictError &&
            saveError.actualDescription === nextDescription
          ) {
            // Another tab already committed exactly this text; adopt it as saved.
            storedDescription = nextDescription;
          } else if (saveError instanceof StepDescriptionConflictError) {
            // Another tab committed a different description while this one was
            // typing. Rebase on the committed value, keep this tab's text
            // journaled against the new baseline, and demand an explicit
            // overwrite instead of silent last-write-wins.
            persisted.current = saveError.actualDescription;
            writeDescriptionDraft(
              { id: stepId.current, sessionId: sessionId.current, description: saveError.actualDescription },
              draft.current,
              writerId.current,
            );
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
        persisted.current = storedDescription;
        if (draft.current === nextDescription && storedDescription !== nextDescription) {
          draft.current = storedDescription;
          if (mounted.current) setDescriptionState(storedDescription);
        }
        // See above: clearMatching is a superset of the targeted clear.
        clearMatchingCommittedDescriptionDrafts(
          { id: stepId.current, sessionId: sessionId.current },
          storedDescription,
        );
        refreshRecoveries();
        try {
          await onChangeRef.current();
        } catch (refreshError) {
          // The IndexedDB commit is authoritative. A failed UI refresh must not
          // misreport a successfully persisted draft as data loss.
          console.warn('[howbeam] description saved, but refreshing editor data failed', refreshError);
        }
      }
    })();

    activeSave.current = operation;
    try {
      await operation;
    } finally {
      if (activeSave.current === operation) activeSave.current = null;
    }
  }, [clearTimer, refreshRecoveries, requireConfirmation]);

  const flush = useCallback(() => performFlush(false), [performFlush]);
  const confirmOverwrite = useCallback(() => performFlush(true), [performFlush]);

  const setDescription = useCallback(
    (typedDescription: string) => {
      // Normalize as the user types, so the draft is exactly what storage will keep.
      const nextDescription = normalizeStoredText(typedDescription);
      const journaled = writeDescriptionDraft(
        {
          id: stepId.current,
          sessionId: sessionId.current,
          description: persisted.current,
        },
        nextDescription,
        writerId.current,
      );
      draft.current = nextDescription;
      setDescriptionState(nextDescription);
      clearTimer();
      if (confirmationRequired.current || nextDescription === persisted.current) return;
      // The debounce only trades latency for fewer IndexedDB writes while the
      // synchronous journal already guarantees durability. When the journal
      // write failed (record cap, size cap, quota), IndexedDB is the only
      // remaining destination, so flush immediately instead of gating the
      // timer on journal success — otherwise typed text would only persist on
      // blur or unmount.
      timer.current = setTimeout(() => {
        void flush().catch(logAutosaveFailure('[howbeam] description autosave failed'));
      }, journaled ? delay : 0);
    },
    [clearTimer, delay, flush],
  );

  const restoreRecovery = useCallback((recoveryWriterId: string): boolean => {
    const recovery = recoveries.find((candidate) => candidate.writerId === recoveryWriterId);
    if (!recovery) return false;
    clearTimer();
    const recovered = normalizeStoredText(recovery.description);
    const journaled = writeDescriptionDraft(
      { id: stepId.current, sessionId: sessionId.current, description: persisted.current },
      recovered,
      writerId.current,
    );
    // The journal write's integrity pass may have cleaned records that are
    // still on screen; re-read so the visible list matches storage.
    refreshRecoveries();
    if (!journaled) return false;
    draft.current = recovered;
    setDescriptionState(recovered);
    requireConfirmation('restored');
    return true;
  }, [clearTimer, recoveries, refreshRecoveries, requireConfirmation]);

  const keepSaved = useCallback(() => {
    if (activeSave.current) return;
    clearTimer();
    discardDescriptionDraft({ id: stepId.current, sessionId: sessionId.current }, writerId.current);
    draft.current = persisted.current;
    setDescriptionState(persisted.current);
    requireConfirmation(null);
    refreshRecoveries();
  }, [clearTimer, refreshRecoveries, requireConfirmation]);

  const discardRecovery = useCallback((recoveryWriterId: string) => {
    discardDescriptionDraft(
      { id: stepId.current, sessionId: sessionId.current },
      recoveryWriterId,
    );
    refreshRecoveries();
  }, [refreshRecoveries]);

  useEffect(() => {
    // Only these three fields identify the draft, so the effect reads them
    // through a narrowed identity object instead of depending on the `step`
    // object, whose reference changes on unrelated edits.
    const external = { id: step.id, sessionId: step.sessionId, description: step.description };
    const previousExternalValue = lastExternalValue.current;
    lastExternalValue.current = external.description;
    stepId.current = external.id;
    sessionId.current = external.sessionId;
    persisted.current = external.description;

    if (draft.current === previousExternalValue || draft.current === external.description) {
      draft.current = external.description;
      setDescriptionState(external.description);
      requireConfirmation(null);
      // clearMatching covers this writer's record too; see performFlush.
      clearMatchingCommittedDescriptionDrafts(external, external.description);
    } else if (external.description !== previousExternalValue) {
      clearTimer();
      writeDescriptionDraft(external, draft.current, writerId.current);
      requireConfirmation('conflict');
    }
    refreshRecoveries();
  }, [clearTimer, refreshRecoveries, requireConfirmation, step.description, step.id, step.sessionId]);

  useEffect(() => register(`description:${step.id}`, flush), [flush, register, step.id]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea === localStorage && event.key?.startsWith(DESCRIPTION_DRAFT_KEY_PREFIX)) {
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
        void flush().catch(logAutosaveFailure('[howbeam] saving before unmounting a description field failed'));
      }
    };
  }, [clearTimer, delay, flush]);

  return {
    description,
    setDescription,
    saveIssue,
    savedDescription,
    keepSaved,
    recoveries,
    restoreRecovery,
    discardRecovery,
    flush,
    confirmOverwrite,
  };
}
