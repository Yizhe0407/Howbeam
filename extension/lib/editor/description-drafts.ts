import { PERSISTED_STEP_LIMITS } from '../storage/persistence-limits';

/**
 * Typed description text not saved yet, kept synchronously in localStorage so
 * closing or crashing the editor cannot lose it. Only one editor tab edits a
 * Project at a time (see editor-lock), so a draft is always this editor's own.
 */
const KEY_PREFIX = 'howbeam:description-draft:';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

interface StepIdentity {
  id: string;
  sessionId: string;
}

interface StoredDraft {
  text: string;
  savedAt: number;
}

function key(step: StepIdentity): string {
  return `${KEY_PREFIX}${step.sessionId}:${step.id}`;
}

/** Records the text; false when storage refused it (quota), so the caller saves at once instead. */
export function writeDescriptionDraft(step: StepIdentity, text: string, now = Date.now()): boolean {
  try {
    localStorage.setItem(key(step), JSON.stringify({ text, savedAt: now } satisfies StoredDraft));
    return true;
  } catch {
    return false;
  }
}

/** The step's unsaved text, if a recent one is recorded. */
export function readDescriptionDraft(step: StepIdentity, now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(key(step));
    if (raw === null) return null;
    const draft = JSON.parse(raw) as Partial<StoredDraft>;
    if (
      typeof draft.text !== 'string' ||
      draft.text.length > PERSISTED_STEP_LIMITS.maxStepDescriptionLength ||
      typeof draft.savedAt !== 'number' ||
      now - draft.savedAt > MAX_AGE_MS
    ) {
      localStorage.removeItem(key(step));
      return null;
    }
    return draft.text;
  } catch {
    return null;
  }
}

export function clearDescriptionDraft(step: StepIdentity): void {
  try {
    localStorage.removeItem(key(step));
  } catch {
    // Storage unavailable: nothing was recorded either.
  }
}
