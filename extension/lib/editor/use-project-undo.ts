import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { PendingUndoAction, UndoAction } from '@/lib/editor/editor-app-model';
import { type Project } from '@/lib/storage/models';
import { t } from '@/lib/shared/i18n';

/**
 * Bookkeeping for the editor's single offered undo action. An undo is only valid against the exact
 * revision its mutation produced, so it ends as soon as the Project moves on. A newer undo simply
 * replaces it on the snackbar; when nothing replaces it, a toast says it is now final.
 */
export function useProjectUndo({ project, operationActive, projectDeleted = false }: {
  project: Project | null;
  operationActive: boolean;
  /** A deleted Project has nothing left to undo into; its undo ends silently. */
  projectDeleted?: boolean;
}) {
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null);
  // Refs are the source of truth so a mutation can take the pending undo synchronously.
  /** The undo in play: it can be used, and it ends when the Project moves on. */
  const current = useRef<UndoAction | null>(null);
  /** The undo on screen, which stays while a mutation that took it runs. Null once the user closed it. */
  const displayed = useRef<UndoAction | null>(null);
  const latestProject = useRef(project);
  const undoSequence = useRef(0);

  const publish = useCallback((next: UndoAction | null) => {
    current.current = next;
    displayed.current = next;
    setUndoAction(next);
  }, []);

  /** Why `action` can no longer be offered, if it can't: 'gone' when its Project is. */
  const invalidity = useCallback((action: UndoAction): 'gone' | 'moved' | null => {
    const latest = latestProject.current;
    if (!latest || projectDeleted || action.projectId !== latest.id) return 'gone';
    if (operationActive || action.expectedRevision !== latest.contentRevision) return 'moved';
    return null;
  }, [operationActive, projectDeleted]);

  useEffect(() => {
    latestProject.current = project;
    const pending = current.current;
    if (!pending) return;
    const reason = invalidity(pending);
    if (!reason) return;
    publish(null);
    if (reason === 'moved') toast(t().editor.undo.nowFinal(pending.message));
  }, [project, invalidity, publish]);

  /** Offers a new undo, replacing any earlier one on the snackbar. */
  const offerUndo = useCallback((pending: PendingUndoAction, projectId: string) => {
    publish({ ...pending, id: ++undoSequence.current, projectId });
  }, [publish]);

  /** Takes the pending undo out of play while another mutation runs: it can no longer expire or
   * be invalidated. It stays on screen until the mutation's outcome replaces it, so the notice
   * updates in place instead of vanishing and coming back. The caller settles it through `offerUndo`
   * (as `superseded`), `returnUndo` (the mutation failed) or `finalizeUndo`. */
  const takeUndo = useCallback((): UndoAction | null => {
    const taken = current.current;
    current.current = null;
    return taken;
  }, []);

  /** Puts a taken undo back after a mutation that changed nothing, if it is still valid and on screen. */
  const returnUndo = useCallback((taken: UndoAction | null) => {
    if (!taken || current.current || displayed.current !== taken) return;
    const reason = invalidity(taken);
    if (!reason) {
      publish(taken);
      return;
    }
    publish(null);
    if (reason === 'moved') toast(t().editor.undo.nowFinal(taken.message));
  }, [invalidity, publish]);

  /** Tells the user a taken undo became final without a new undo to say it on. */
  const finalizeUndo = useCallback((taken: UndoAction | null) => {
    if (!taken || displayed.current !== taken) return;
    publish(null);
    toast(t().editor.undo.nowFinal(taken.message));
  }, [publish]);

  const clearUndo = useCallback(() => publish(null), [publish]);

  /** The undo that can be used right now, if any. */
  const offeredUndo = useCallback(() => current.current, []);

  return { undoAction, offeredUndo, offerUndo, takeUndo, returnUndo, finalizeUndo, clearUndo };
}
