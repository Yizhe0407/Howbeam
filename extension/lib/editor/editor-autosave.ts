import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { saveStepDescription, StepNotFoundError } from '../storage/step-repository';
import { type Step } from '../storage/models';
import { normalizeStoredText } from '../storage/stored-text';
import { clearDescriptionDraft, readDescriptionDraft, writeDescriptionDraft } from './description-drafts';

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
    // Best effort only: the synchronous localStorage draft is what survives a
    // close, since browsers may abort IndexedDB work after pagehide.
    const flushBeforeLeaving = () => {
      void flushAll().catch((error) => {
        console.error('[howbeam] failed to save descriptions before leaving the editor', error);
      });
    };
    window.addEventListener('pagehide', flushBeforeLeaving);
    return () => window.removeEventListener('pagehide', flushBeforeLeaving);
  }, [flushAll]);

  return createElement(EditorSaveContext.Provider, { value: { register, flushAll } }, children);
}

export function useEditorSaveRegistry(): EditorSaveRegistry {
  const registry = useContext(EditorSaveContext);
  if (!registry) throw new Error('useEditorSaveRegistry must be used inside EditorSaveProvider.');
  return registry;
}

/** Why the text in the field is not (yet) the stored description:
 * - `missing`: the step no longer exists, so nothing can be saved.
 * - `failed`: the last save failed for another reason; the next edit retries.
 * The typed text stays in the local draft either way. */
export type DescriptionSaveIssue = 'missing' | 'failed';

export interface DescriptionAutosaveResult {
  description: string;
  setDescription: (description: string) => void;
  saveIssue: DescriptionSaveIssue | null;
  flush: () => Promise<void>;
}

/**
 * Autosaves one step's description. This editor tab is the Project's only
 * writer (editor-lock), so a save simply writes; the text is kept in a local
 * draft first so a closed or crashed tab resumes where the typing stopped.
 * Saves are serialized, and a response never replaces text typed meanwhile.
 */
export function useStepDescriptionAutosave(step: Step, delay = 650): DescriptionAutosaveResult {
  const { register } = useEditorSaveRegistry();
  const [initial] = useState(() => {
    const restored = readDescriptionDraft(step);
    return restored === null ? step.description : normalizeStoredText(restored);
  });
  const [description, setDescriptionState] = useState(initial);
  const [saveIssue, setSaveIssue] = useState<DescriptionSaveIssue | null>(null);
  const draft = useRef(initial);
  const persisted = useRef(step.description);
  const identity = useRef({ id: step.id, sessionId: step.sessionId });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSave = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const flush = useCallback(async () => {
    clearTimer();
    if (activeSave.current) await activeSave.current;
    if (draft.current === persisted.current) {
      clearDescriptionDraft(identity.current);
      return;
    }
    const operation = (async () => {
      while (draft.current !== persisted.current) {
        const sent = draft.current;
        let stored: string;
        try {
          stored = await saveStepDescription(identity.current.id, sent);
        } catch (error) {
          // The draft stays as the only copy of the typed text; for a deleted
          // step an undo that restores it brings the text back.
          if (mounted.current) setSaveIssue(error instanceof StepNotFoundError ? 'missing' : 'failed');
          throw error;
        }
        if (mounted.current) setSaveIssue(null);
        persisted.current = stored;
        if (draft.current === sent && stored !== sent) {
          draft.current = stored;
          if (mounted.current) setDescriptionState(stored);
        }
      }
      clearDescriptionDraft(identity.current);
    })();
    activeSave.current = operation;
    try {
      await operation;
    } finally {
      if (activeSave.current === operation) activeSave.current = null;
    }
  }, [clearTimer]);

  const setDescription = useCallback(
    (typed: string) => {
      // Normalize as the user types, so the draft is exactly what storage keeps.
      const next = normalizeStoredText(typed);
      const kept = writeDescriptionDraft(identity.current, next);
      draft.current = next;
      setDescriptionState(next);
      clearTimer();
      if (next === persisted.current) {
        clearDescriptionDraft(identity.current);
        return;
      }
      // Without a local copy, storage is the only place left: save at once.
      timer.current = setTimeout(
        () => {
          void flush().catch((error) => console.error('[howbeam] description autosave failed', error));
        },
        kept ? delay : 0,
      );
    },
    [clearTimer, delay, flush],
  );

  useEffect(() => {
    // Edits from this same editor (undo, restore) change the stored value; an
    // untouched field follows them, a field with typed text keeps it.
    const previous = persisted.current;
    identity.current = { id: step.id, sessionId: step.sessionId };
    persisted.current = step.description;
    if (draft.current === previous || draft.current === step.description) {
      draft.current = step.description;
      setDescriptionState(step.description);
      clearDescriptionDraft(identity.current);
    }
  }, [step.description, step.id, step.sessionId]);

  useEffect(() => register(`description:${step.id}`, flush), [flush, register, step.id]);

  useEffect(() => {
    mounted.current = true;
    if (draft.current !== persisted.current) {
      timer.current = setTimeout(() => {
        void flush().catch((error) => console.error('[howbeam] saving a restored draft failed', error));
      }, delay);
    }
    return () => {
      mounted.current = false;
      clearTimer();
      void flush().catch((error) =>
        console.error('[howbeam] saving before unmounting a description field failed', error),
      );
    };
  }, [clearTimer, delay, flush]);

  return { description, setDescription, saveIssue, flush };
}
