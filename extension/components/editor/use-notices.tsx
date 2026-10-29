import { useEffect, useRef } from 'react';
import toast from 'react-hot-toast';
import UndoNotice from '@/components/editor/UndoNotice';
import type { UndoAction } from '@/lib/editor/editor-app-model';
import { useDeferredBusy } from '@/lib/shared/use-deferred-busy';

const UNDO_NOTICE_ID = 'editor-undo';
const BUSY_NOTICE_ID = 'editor-busy';
const UNDO_WINDOW_MS = 5_000;

/**
 * Offers the pending undo on the notice stack. The notice has no timer of its
 * own: the window runs here, is held while a restore is in flight (the notice
 * must not vanish mid-operation) and restarts once that settles. Removed, not
 * dismissed, so it is gone at once rather than after the toast exit delay. The
 * notice shows a restore as in progress only once it proves slow.
 */
export function useUndoNotice({ action, pending, onUndo, onDismiss }: {
  action: UndoAction | null;
  pending: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const handlers = useRef({ onUndo, onDismiss });
  handlers.current = { onUndo, onDismiss };
  const pendingShown = useDeferredBusy(pending);

  const id = action?.id;
  const message = action?.message;

  useEffect(() => {
    if (id === undefined || message === undefined) {
      toast.remove(UNDO_NOTICE_ID);
      return;
    }
    toast.custom(
      <UndoNotice
        message={message}
        pending={pendingShown}
        onUndo={() => handlers.current.onUndo()}
        onDismiss={() => handlers.current.onDismiss()}
      />,
      { id: UNDO_NOTICE_ID, duration: Infinity },
    );
  }, [id, message, pendingShown]);

  useEffect(() => {
    if (id === undefined || pending) return;
    const timer = setTimeout(() => handlers.current.onDismiss(), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [id, pending]);

  useEffect(() => () => toast.remove(UNDO_NOTICE_ID), []);
}

/** Shows `label` as work in progress while it is non-null, once the work proves slow. */
export function useBusyNotice(label: string | null) {
  const shown = useDeferredBusy(label !== null);
  const lastLabel = useRef(label);
  if (label !== null) lastLabel.current = label;
  const visibleLabel = shown ? lastLabel.current : null;

  useEffect(() => {
    if (!visibleLabel) return;
    // The Toaster's default duration would otherwise apply to a loading toast too and hide it mid-work.
    toast.loading(visibleLabel, { id: BUSY_NOTICE_ID, duration: Infinity });
    return () => toast.remove(BUSY_NOTICE_ID);
  }, [visibleLabel]);
}
