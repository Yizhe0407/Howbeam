import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { ImageEditItem } from './image-edit-items';

/** Undo/redo over whole item lists. Items are immutable, so each snapshot is
 * cheap to keep and identity comparison tells whether anything changed. */
interface History {
  past: ImageEditItem[][];
  present: ImageEditItem[];
  future: ImageEditItem[][];
}

type HistoryAction =
  | { type: 'commit'; items: ImageEditItem[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; items: ImageEditItem[] };

const HISTORY_LIMIT = 200;

export function historyReducer(history: History, action: HistoryAction): History {
  switch (action.type) {
    case 'commit':
      if (action.items === history.present) return history;
      return { past: [...history.past, history.present].slice(-HISTORY_LIMIT), present: action.items, future: [] };
    case 'undo': {
      const previous = history.past.at(-1);
      if (!previous) return history;
      return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
    }
    case 'redo': {
      const [next, ...rest] = history.future;
      if (!next) return history;
      return { past: [...history.past, history.present], present: next, future: rest };
    }
    case 'reset':
      // Stored items replaced from outside: older steps would restore what another tab removed.
      return initialHistory(action.items);
  }
}

export const initialHistory = (items: ImageEditItem[]): History => ({ past: [], present: items, future: [] });

/** Thrown by `persist` when storage holds items this session has not seen (another
 * tab saved meanwhile). Carries those stored items: the session refuses its own
 * write, shows them instead, and reports the conflict so the person can redo. */
export class ImageEditSessionConflict extends Error {
  constructor(
    public readonly storedItems: ImageEditItem[],
    options?: { cause?: unknown },
  ) {
    super('The image edits were changed elsewhere.', options);
    this.name = 'ImageEditSessionConflict';
  }
}

interface Options {
  initialItems: ImageEditItem[];
  /** Writes the full item list. Calls never overlap, and always carry the newest items.
   * Throws `ImageEditSessionConflict` when storage changed underneath the session. */
  persist: (items: ImageEditItem[]) => Promise<void>;
  /** Quiet time after the last change before it is written. */
  debounceMs?: number;
}

/**
 * One editing session over a screenshot's items: the draft the user is
 * looking at, its undo history, and saving it in the background.
 *
 * The draft is the source of truth while editing, so the screen reacts to a
 * change instantly instead of waiting for storage. Saving follows behind it,
 * debounced, and serialized so two writes never race and none is dropped;
 * `flush` resolves once everything shown has been written.
 */
export function useImageEditSession({ initialItems, persist, debounceMs = 600 }: Options) {
  const [history, dispatch] = useReducer(historyReducer, initialItems, initialHistory);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  /** The last save was refused because another tab changed the image first. */
  const [conflicted, setConflicted] = useState(false);

  const latest = useRef(history.present);
  latest.current = history.present;
  const persisted = useRef(history.present);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const inflight = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /** Replaces the draft and its history with items already in storage. */
  const adopt = useCallback((items: ImageEditItem[]) => {
    clearTimeout(timer.current);
    latest.current = items;
    persisted.current = items;
    dispatch({ type: 'reset', items });
  }, []);

  /** `force` writes once even when nothing changed, for a save that carries
   * more than the items (confirming the masks). */
  const flush = useCallback(
    (options: { force?: boolean } = {}): Promise<void> => {
      clearTimeout(timer.current);
      if (inflight.current) {
        const running = inflight.current;
        return options.force ? running.then(() => flush(options)) : running;
      }
      const run: Promise<void> = Promise.resolve().then(async () => {
        try {
          let forced = options.force === true;
          // Loops until caught up, so edits made while a write was running are written too.
          while (forced || latest.current !== persisted.current) {
            forced = false;
            const target = latest.current;
            setSaving(true);
            await persistRef.current(target);
            persisted.current = target;
          }
          setSaveFailed(false);
          setConflicted(false);
        } catch (error) {
          if (error instanceof ImageEditSessionConflict) {
            adopt(error.storedItems);
            setSaveFailed(false);
            setConflicted(true);
          } else {
            setSaveFailed(true);
          }
          throw error;
        } finally {
          setSaving(false);
          if (inflight.current === run) inflight.current = null;
        }
      });
      inflight.current = run;
      return run;
    },
    [adopt],
  );

  useEffect(() => {
    if (history.present === persisted.current) return undefined;
    timer.current = setTimeout(() => void flush().catch(() => undefined), debounceMs);
    return () => clearTimeout(timer.current);
  }, [history.present, flush, debounceMs]);

  // Closing the editor must not strand unsaved edits.
  useEffect(() => () => void flush().catch(() => undefined), [flush]);

  // Leaving the page must not strand unsaved edits.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [flush]);

  /** Takes items another tab stored, but only while nothing here is waiting to be
   * saved: unsaved local edits are instead checked against storage when they are
   * written, and a conflict is reported then. Returns whether they were taken. */
  const adoptIfSettled = useCallback(
    (items: ImageEditItem[]): boolean => {
      if (inflight.current || latest.current !== persisted.current) return false;
      adopt(items);
      return true;
    },
    [adopt],
  );

  const commit = useCallback((items: ImageEditItem[]) => dispatch({ type: 'commit', items }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  return {
    items: history.present,
    commit,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    saving,
    saveFailed,
    conflicted,
    flush,
    adoptIfSettled,
  };
}
