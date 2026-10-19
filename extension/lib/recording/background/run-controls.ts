import { browser } from 'wxt/browser';
import { waitForQueuedClicks } from '../background-queues';
import {
  isTrustedExtensionPageSender,
  isTrustedRecorderControlSender,
  type RuntimeMessageSenderLike,
} from '../../runtime/background-message-validation';
import { deleteStepsForRun, getSteps } from '../../storage/step-repository';
import { getRecordingState, resetRunStateToIdle } from '../../storage/storage';
import { markEditorOpenFailed } from '../recording-recovery';
import type { FinishResult, RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import { t } from '@/lib/shared/i18n';
import { controlFailure } from './control-result';
import { createSnapshotControls } from './snapshot-controls';
import { createUndoControls } from './undo-controls';
import {
  deleteEmptySnapshotAnchorBestEffort,
  reclaimAbandonedAutoCreatedProject,
} from './run-cleanup';
import type { CaptureFlow } from './capture-flow';
import type { ControlPlane } from './control-plane';
import type { EditorOpen } from './editor-open';
import type { RecorderRuntime } from './recorder-runtime';
import type { RunState } from './run-state';
import type { UndoWindow } from './undo-window';

export interface RunControlDependencies {
  control: ControlPlane;
  runtime: RecorderRuntime;
  runState: RunState;
  undoWindow: UndoWindow;
  captureFlow: CaptureFlow;
  editorOpen: EditorOpen;
}

/** The controls a live run answers from its toolbar, the popup and keyboard
 * shortcuts: pause, undo, snapshot steps, mode switches, finish and discard. */
export function createRunControls(deps: RunControlDependencies) {
  const { control, runtime: recorderRuntime, editorOpen } = deps;
  const { updateRunState } = deps.runState;
  const { undoLastCapture, restoreLastCapture } = createUndoControls(deps);
  const {
    prepareNextSnapshot,
    createNextSnapshot,
    switchToSnapshotMode,
    switchToStepsMode,
  } = createSnapshotControls(deps);

  async function pauseRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const state = await getRecordingState();
    if (
      !state.isRecording ||
      state.runId !== message.runId ||
      state.mode !== 'steps' ||
      state.phase !== 'recording'
    ) {
      return controlFailure(t().background.cannotPause);
    }
    control.acceptingClicks = false;
    const updated = await updateRunState(message.runId, (current) => ({ ...current, phase: 'paused' }));
    if (!updated) return controlFailure(t().background.stateChangedRetry);
    return { ok: true };
  }

  async function resumeRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const state = await getRecordingState();
    if (
      !state.isRecording ||
      state.runId !== message.runId ||
      state.mode !== 'steps' ||
      state.phase !== 'paused'
    ) {
      return controlFailure(t().background.cannotResume);
    }
    const updated = await updateRunState(message.runId, (current) => ({ ...current, phase: 'recording' }));
    if (!updated) return controlFailure(t().background.stateChangedRetry);
    control.acceptingClicks = true;
    return { ok: true };
  }

  async function finishRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const startedAtControlVersion = control.controlVersion;
    const initial = await getRecordingState();
    if (
      !initial.isRecording ||
      initial.runId !== message.runId ||
      (initial.phase !== 'recording' &&
        initial.phase !== 'paused' &&
        initial.phase !== 'preparing-next' &&
        initial.phase !== 'invalidated')
    ) {
      return controlFailure(initial.phase === 'finishing' ? t().background.finishing : t().background.alreadyEnded);
    }

    control.claimControl({ discardUndo: true, bumpVersion: false });
    const markedFinishing = await control.writeStateIf(
      startedAtControlVersion,
      (current) =>
        current.isRecording &&
        current.runId === message.runId &&
        (current.phase === 'recording' ||
          current.phase === 'paused' ||
          current.phase === 'preparing-next' ||
          current.phase === 'invalidated'),
      (current) => ({ ...current, phase: 'finishing', error: null, recoverableError: null }),
    );
    if (!markedFinishing) return controlFailure(t().background.stateChangedRetry);

    await waitForQueuedClicks();
    if (startedAtControlVersion !== control.controlVersion) return controlFailure(t().background.stateChanged);

    const state = await getRecordingState();
    if (!state.isRecording || !state.sessionId || state.runId !== message.runId) {
      return controlFailure(t().background.alreadyEnded);
    }
    const steps = await getSteps(state.sessionId);
    const runItems = steps.filter((step) => step.runId === message.runId && step.bounds !== null);
    const lastItem = runItems.at(-1) ?? null;
    const result: FinishResult = {
      sessionId: state.sessionId,
      entryId: lastItem?.groupId ?? lastItem?.id ?? null,
      itemCount: runItems.length,
    };

    const version = control.bumpVersion();
    // No reclaim on FINISH even at zero items: openEditor below opens this very
    // Project, and the user reaches it visibly in the editor.
    const stopped = await control.writeStateForControl(version, resetRunStateToIdle);
    if (!stopped) return controlFailure(t().background.finishFailed);

    // Only after the finish won the state write: doing it earlier risked leaving a
    // run in phase 'finishing' whose groupAnchorId pointed at a deleted anchor row.
    await deleteEmptySnapshotAnchorBestEffort(state);
    await recorderRuntime.stopRecorderInTab(state.tabId);
    try {
      await editorOpen.openEditor({ sessionId: result.sessionId, entryId: result.entryId });
    } catch (error) {
      console.error('[howbeam] failed to open editor after recording', error);
      await control.writeStateForControl(version, markEditorOpenFailed);
      return { ok: true, finish: result };
    }
    return { ok: true, finish: result };
  }

  async function discardCurrentRecording(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const startedAtControlVersion = control.controlVersion;
    const initial = await getRecordingState();
    if (
      startedAtControlVersion !== control.controlVersion ||
      !initial.isRecording ||
      !initial.sessionId ||
      initial.runId !== message.runId ||
      initial.phase === 'starting' ||
      initial.phase === 'finishing'
    ) {
      return controlFailure(t().background.cannotDiscard);
    }

    const version = control.claimControl({ discardUndo: true });
    await waitForQueuedClicks();

    const state = await getRecordingState();
    if (
      version !== control.controlVersion ||
      !state.isRecording ||
      !state.sessionId ||
      state.runId !== message.runId
    ) {
      return controlFailure(t().background.stateChangedRetry);
    }

    try {
      await deleteStepsForRun(state.sessionId, message.runId);
      const stopped = await control.writeStateForControl(version, resetRunStateToIdle);
      if (!stopped) return controlFailure(t().background.discardFailed);
      await recorderRuntime.stopRecorderInTab(state.tabId);
      // The run's steps are already deleted, so a popup-created Project is back to
      // an empty shell here — the exact case the reclaim exists for.
      await reclaimAbandonedAutoCreatedProject(state);
      return { ok: true };
    } catch (error) {
      console.error('[howbeam] failed to discard current recording', error);
      await control.writeStateForControl(version, (current) => ({
        ...current,
        error: t().background.discardFailed,
        recoverableError: { code: 'DISCARD_FAILED', message: t().background.discardFailed },
      }));
      return controlFailure(t().background.discardFailed);
    }
  }

  async function handleRecordingControl(
    message: RecordingControlMessage,
    sender?: RuntimeMessageSenderLike,
  ): Promise<RecordingControlResult> {
    if (sender && !isTrustedExtensionPageSender(sender, browser.runtime.getURL('/'))) {
      const state = await getRecordingState();
      if (
        !state.isRecording ||
        state.runId !== message.runId ||
        !isTrustedRecorderControlSender(sender, state.tabId)
      ) {
        console.warn('[howbeam] rejected an untrusted recorder control message', message.type);
        return controlFailure(t().background.actionUnavailable);
      }
    }

    switch (message.type) {
      case 'PAUSE_RECORDING':
        return pauseRecording(message);
      case 'RESUME_RECORDING':
        return resumeRecording(message);
      case 'UNDO_LAST_CAPTURE':
        return undoLastCapture(message);
      case 'RESTORE_LAST_CAPTURE':
        return restoreLastCapture(message);
      case 'PREPARE_NEXT_SNAPSHOT':
        return prepareNextSnapshot(message);
      case 'CREATE_NEXT_SNAPSHOT':
        return createNextSnapshot(message);
      case 'REBUILD_INVALIDATED_SNAPSHOT':
        return createNextSnapshot(message, 'invalidated');
      case 'SWITCH_TO_SNAPSHOT_MODE':
        return switchToSnapshotMode(message);
      case 'SWITCH_TO_STEPS_MODE':
        return switchToStepsMode(message);
      case 'DISCARD_CURRENT_RECORDING':
        return discardCurrentRecording(message);
      case 'FINISH_RECORDING':
        return finishRecording(message);
    }
  }

  /** 將沒有 runId 的瀏覽器快捷鍵交由具冪等性的控制 handler 處理。 */
  async function handleCommandShortcut(command: string): Promise<void> {
    const state = await getRecordingState();
    if (!state.isRecording || !state.runId) return;
    const runId = state.runId;
    switch (command) {
      case 'toggle-pause':
        // Pause/resume is a steps-mode affordance; snapshot has no pause (§9.2).
        if (state.mode !== 'steps') return;
        if (state.phase === 'recording') {
          await handleRecordingControl({ type: 'PAUSE_RECORDING', runId });
        } else if (state.phase === 'paused') {
          await handleRecordingControl({ type: 'RESUME_RECORDING', runId });
        }
        return;
      case 'undo-last-capture':
        await handleRecordingControl({ type: 'UNDO_LAST_CAPTURE', runId });
        return;
      case 'finish-recording':
        await handleRecordingControl({ type: 'FINISH_RECORDING', runId });
        return;
    }
  }

  return { handleRecordingControl, handleCommandShortcut };
}
