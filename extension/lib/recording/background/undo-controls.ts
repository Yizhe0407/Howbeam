import { browser } from 'wxt/browser';
import { queueClick } from '../background-queues';
import { addStepsAfter, deleteStep, getSteps } from '../../storage/step-repository';
import { getRecordingState } from '../../storage/storage';
import type { HowbeamSnapshotHistoryMessage, RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import { UNDO_WINDOW_MS, type RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { controlFailure } from './control-result';
import type { ControlPlane } from './control-plane';
import type { RunState } from './run-state';
import type { UndoWindow } from './undo-window';

/** The frozen snapshot draws and deduplicates its annotations itself, so it
 * hears about every undo and restore here, whether the shield toolbar, the
 * page toolbar or a keyboard shortcut asked for it. */
function notifySnapshotHistory(state: RecordingState, runId: string, change: HowbeamSnapshotHistoryMessage['change']): void {
  if (state.mode !== 'snapshot' || state.tabId == null) return;
  const message: HowbeamSnapshotHistoryMessage = { type: 'HOWBEAM_SNAPSHOT_HISTORY', runId, change };
  browser.tabs.sendMessage(state.tabId, message, { frameId: 0 }).catch((error: unknown) => {
    console.warn('[howbeam] snapshot did not hear an annotation undo/restore', error);
  });
}

/** Undo of a run's last item and its restore, through the run's one undo window. */
export function createUndoControls(deps: { control: ControlPlane; runState: RunState; undoWindow: UndoWindow }) {
  const { control, undoWindow } = deps;
  const { updateRunState } = deps.runState;

  async function undoLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
    return queueClick(async () => {
      const expectedControlVersion = control.controlVersion;
      const state = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        !state.isRecording ||
        !state.sessionId ||
        !state.runId ||
        state.runId !== message.runId ||
        (state.phase !== 'recording' && state.phase !== 'paused')
      ) {
        return controlFailure(t().background.nothingToUndo);
      }

      const steps = await getSteps(state.sessionId);
      const last = [...steps]
        .reverse()
        .find((step) => step.runId === message.runId && step.bounds !== null);
      if (!last || state.itemCount === 0) return controlFailure(t().background.nothingToUndo);

      const nextCount = Math.max(0, state.itemCount - 1);
      const undoRecord = {
        token: crypto.randomUUID(),
        runId: message.runId,
        step: last,
        expectedItemCount: nextCount,
        expiresAt: Date.now() + UNDO_WINDOW_MS,
      };
      // Soft delete: persist a copy first, since MV3 may terminate the worker inside
      // the restore window.
      await undoWindow.persist(undoRecord);
      await deleteStep(last.id);
      const updated = await updateRunState(
        message.runId,
        (current) => ({
          ...current,
          itemCount: nextCount,
          runItemCount: Math.max(0, current.runItemCount - 1),
          error: null,
          recoverableError: null,
        }),
        expectedControlVersion,
      );
      if (!updated) {
        await addStepsAfter([last], state.insertAfterStepId);
        undoWindow.discard();
        return controlFailure(t().background.undoStateChanged);
      }

      undoWindow.open(undoRecord);
      notifySnapshotHistory(state, message.runId, 'undo');
      return { ok: true, undoToken: undoRecord.token, removedItemNumber: state.itemCount };
    });
  }

  async function restoreLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
    return queueClick(async () => {
      const undo = undoWindow.current();
      const expectedControlVersion = control.controlVersion;
      const state = await getRecordingState();
      if (
        !undo ||
        undo.token !== message.undoToken ||
        undo.runId !== message.runId ||
        undo.expiresAt < Date.now() ||
        !state.isRecording ||
        !state.sessionId ||
        !state.runId ||
        state.runId !== message.runId ||
        state.itemCount !== undo.expectedItemCount ||
        // Same phases undo itself allows: a window rehydrated after a worker
        // restart must not restore into preparing-next/invalidated/finishing.
        (state.phase !== 'recording' && state.phase !== 'paused')
      ) {
        undoWindow.discard();
        return controlFailure(t().background.cannotRestore);
      }

      await addStepsAfter([undo.step], state.insertAfterStepId);
      const updated = await updateRunState(
        message.runId,
        (current) => ({
          ...current,
          itemCount: current.itemCount + 1,
          runItemCount: current.runItemCount + 1,
          error: null,
          recoverableError: null,
        }),
        expectedControlVersion,
      );
      if (!updated) {
        await deleteStep(undo.step.id);
        return controlFailure(t().background.restoreStateChanged);
      }
      undoWindow.discard();
      notifySnapshotHistory(state, message.runId, 'restore');
      return { ok: true };
    });
  }

  return { undoLastCapture, restoreLastCapture };
}

export type UndoControls = ReturnType<typeof createUndoControls>;
