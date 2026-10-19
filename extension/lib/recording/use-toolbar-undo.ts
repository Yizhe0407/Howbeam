import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { UNDO_WINDOW_MS } from '@/lib/storage/recording-state';

export const RECORDING_TOOLBAR_UNDO_KEY = 'howbeam:recordingToolbarUndo';

export interface UndoOffer {
  token: string;
  /** The number of the item that was removed, for the message. */
  itemNumber: number;
}

interface StoredOffer extends UndoOffer {
  runId: string;
  expiresAt: number;
  /** The item count right after the undo. Restoring only makes sense while it still holds. */
  itemCount: number;
}

function readStored(value: unknown): StoredOffer | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredOffer>;
  return typeof v.token === 'string' && typeof v.runId === 'string' && Number.isFinite(v.itemNumber)
    && Number.isFinite(v.expiresAt) && Number.isFinite(v.itemCount)
    ? (v as StoredOffer)
    : null;
}

/**
 * The "Restore" offer after an undo. It is kept in storage, not just in the component, because the toolbar is mounted
 * afresh when the run moves to another tab or page; an offer that lived only in the component would vanish while the
 * background still holds the removed item. Like the background's own restore check, an offer is only valid for the run
 * it was made in, until it expires, and while no item has been added or removed since.
 */
export function useToolbarUndo(runId: string, itemCount: number) {
  const [stored, setStored] = useState<StoredOffer | null>(null);
  /** Whether the item count has been seen to match the offer yet: right after an undo the new count is still on its way. */
  const settled = useRef(false);
  const countRef = useRef(itemCount);
  countRef.current = itemCount;

  useEffect(() => {
    let disposed = false;
    void browser.storage.local.get(RECORDING_TOOLBAR_UNDO_KEY).then((result) => {
      if (disposed) return;
      const saved = readStored(result?.[RECORDING_TOOLBAR_UNDO_KEY]);
      if (saved && saved.runId === runId && saved.expiresAt > Date.now() && saved.itemCount === countRef.current) {
        settled.current = true;
        hasOffer.current = true;
        setStored(saved);
      }
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [runId]);

  const hasOffer = useRef(false);
  const clear = useCallback(() => {
    setStored(null);
    if (!hasOffer.current) return;
    hasOffer.current = false;
    void browser.storage.local.remove(RECORDING_TOOLBAR_UNDO_KEY).catch(() => undefined);
  }, []);

  const offer = useCallback((next: UndoOffer, countAfterUndo: number) => {
    const record: StoredOffer = { ...next, runId, expiresAt: Date.now() + UNDO_WINDOW_MS, itemCount: countAfterUndo };
    settled.current = false;
    hasOffer.current = true;
    setStored(record);
    void browser.storage.local.set({ [RECORDING_TOOLBAR_UNDO_KEY]: record }).catch((error) => {
      console.warn('[howbeam] failed to save the undo offer', error);
    });
  }, [runId]);

  const expiresAt = stored?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return undefined;
    const timer = window.setTimeout(clear, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt, clear]);

  // An item added or removed since makes the restore impossible, so the offer goes with it.
  if (stored !== null && itemCount === stored.itemCount) settled.current = true;
  const stale = stored !== null && settled.current && stored.itemCount !== itemCount;
  useEffect(() => {
    if (stale) clear();
  }, [stale, clear]);

  return { undo: stored && !stale ? { token: stored.token, itemNumber: stored.itemNumber } : null, offer, clear };
}
