import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

export const RECORDING_TOOLBAR_COLLAPSED_KEY = 'howbeam:recordingToolbarCollapsed';

interface StoredCollapse {
  runId: string;
  collapsed: boolean;
}

function readStored(value: unknown): StoredCollapse | null {
  if (!value || typeof value !== 'object') return null;
  const { runId, collapsed } = value as Partial<StoredCollapse>;
  return typeof runId === 'string' && typeof collapsed === 'boolean' ? { runId, collapsed } : null;
}

/**
 * Whether the toolbar is collapsed, kept for the whole run. The toolbar is mounted afresh whenever the run moves
 * (another tab, a new page), so state held in the component would reset to expanded each time. The choice belongs
 * to one run: a new recording always starts expanded. `ready` turns true once the saved choice has been read, so
 * the toolbar is never drawn in the wrong shape first.
 */
export function useToolbarCollapsed(runId: string): { collapsed: boolean; setCollapsed: (next: boolean) => void; ready: boolean } {
  const [collapsed, setLocal] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    void browser.storage.local.get(RECORDING_TOOLBAR_COLLAPSED_KEY).then((stored) => {
      if (disposed) return;
      const saved = readStored(stored?.[RECORDING_TOOLBAR_COLLAPSED_KEY]);
      setLocal(saved?.runId === runId && saved.collapsed);
      setReady(true);
    }).catch(() => {
      if (!disposed) setReady(true);
    });
    return () => { disposed = true; };
  }, [runId]);

  const setCollapsed = useCallback((next: boolean) => {
    setLocal(next);
    void browser.storage.local.set({ [RECORDING_TOOLBAR_COLLAPSED_KEY]: { runId, collapsed: next } }).catch((error) => {
      console.warn('[howbeam] failed to save the toolbar collapse state', error);
    });
  }, [runId]);

  return { collapsed, setCollapsed, ready };
}
