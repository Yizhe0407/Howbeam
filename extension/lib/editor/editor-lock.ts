import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { focusTab } from '../runtime/navigation';

/**
 * One editor tab edits a Project at a time. The tab holding the Project's Web
 * Lock is its only writer, which is why the editor's saves never have to
 * compare against what another tab might have written. A second tab opened on
 * the same Project waits, takes over once the first one closes or leaves the
 * Project, and can ask the holder to come to the front meanwhile.
 *
 * - `held`: this tab edits the Project (also when there is no Project yet, or
 *   the browser has no Web Locks).
 * - `elsewhere`: another editor tab has it.
 * - `pending`: still asking.
 */
export type EditorLockState = 'pending' | 'held' | 'elsewhere';

const CHANNEL = 'howbeam:editor-lock';

interface ShowHolderMessage {
  type: 'show-holder';
  projectId: string;
}

function lockName(projectId: string): string {
  return `howbeam-editor:${projectId}`;
}

async function bringThisTabForward(): Promise<void> {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id != null) await focusTab(tab.id, tab.windowId);
}

export function useEditorLock(projectId: string | null): { state: EditorLockState; showHolder: () => void } {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const [lock, setLock] = useState<{ projectId: string; state: EditorLockState } | null>(null);
  const state: EditorLockState = !projectId || !locks ? 'held' : lock?.projectId === projectId ? lock.state : 'pending';

  useEffect(() => {
    if (!projectId || !locks) return;
    const name = lockName(projectId);
    const waiting = new AbortController();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold = () => {
      setLock({ projectId, state: 'held' });
      return released;
    };
    const failed = (error: unknown) => {
      if (waiting.signal.aborted) return;
      // Locking is a guard, not a feature: without it this tab still edits.
      console.error('[howbeam] failed to lock the Project for this editor', error);
      setLock({ projectId, state: 'held' });
    };
    void locks.request(name, { ifAvailable: true }, (granted) => {
      if (granted) return hold();
      if (waiting.signal.aborted) return undefined;
      setLock({ projectId, state: 'elsewhere' });
      void locks.request(name, { signal: waiting.signal }, hold).catch(failed);
      return undefined;
    }).catch(failed);
    return () => {
      waiting.abort();
      release();
    };
  }, [locks, projectId]);

  useEffect(() => {
    if (!projectId || state !== 'held' || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<ShowHolderMessage>) => {
      if (event.data?.type !== 'show-holder' || event.data.projectId !== projectId) return;
      void bringThisTabForward().catch((error) => console.warn('[howbeam] failed to show the editing tab', error));
    };
    return () => channel.close();
  }, [projectId, state]);

  const showHolder = useCallback(() => {
    if (!projectId || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: 'show-holder', projectId } satisfies ShowHolderMessage);
    channel.close();
  }, [projectId]);

  return { state, showHolder };
}
