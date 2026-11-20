import { useEffect, useRef, useState } from 'react';
import { exportFailureMessage, type PublicationAction } from '@/lib/export/export-failure';
import { isAbortError, throwIfAborted } from '@/lib/shared/abort';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

/** Runs `task` as the page's one data operation of the moment; rejects when that is not possible. */
export type RunExport = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * One export at a time, cancellable, with what to tell the user afterwards.
 * A task resolves 'nothing' when it found nothing to download; `nothingNotice`
 * is what is said then. Shared by every export surface so they fail, cancel
 * and report alike.
 */
export function useExportRunner(runExport: RunExport, nothingNotice: () => string) {
  const [pendingAction, setPendingAction] = useState<PublicationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);
  const busy = pendingAction !== null;
  // `busy` guards the export; only how it looks waits until the export proves slow.
  const busyShown = useDeferredBusy(busy);

  useEffect(() => () => activeController.current?.abort(), []);

  async function run(action: PublicationAction, task: (signal: AbortSignal) => Promise<'nothing' | void>) {
    if (activeController.current) return;

    const controller = new AbortController();
    activeController.current = controller;
    setPendingAction(action);
    setError(null);
    setNotice(null);

    try {
      const outcome = await runExport(() => task(controller.signal));
      throwIfAborted(controller.signal);
      // The browser shows the download itself; only an export that produced nothing needs saying.
      setNotice(outcome === 'nothing' ? nothingNotice() : null);
    } catch (actionError) {
      if (!isAbortError(actionError) && !controller.signal.aborted) {
        console.error(`[howbeam] project export failed: ${action}`, actionError);
        setError(exportFailureMessage(action, actionError));
      }
    } finally {
      if (activeController.current === controller) activeController.current = null;
      setPendingAction(null);
    }
  }

  return {
    busy,
    busyShown,
    error,
    notice,
    run,
    cancel: () => activeController.current?.abort(),
    /** Clears the last outcome, for a panel that opens afresh. */
    reset: () => {
      setError(null);
      setNotice(null);
    },
  };
}
