import { browser } from 'wxt/browser';
import {
  StaleCaptureError,
  queueClick,
  queueStateMutation,
  waitForQueuedClicks,
} from '../background-queues';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import {
  isTrustedExtensionPageSender,
  isTrustedRecorderControlSender,
  type RuntimeMessageSenderLike,
} from '../../runtime/background-message-validation';
import { addStepsAfter, deleteStep, deleteStepsForRun, getSteps } from '../../storage/step-repository';
import { describeBrowserError } from '../../runtime/browser-errors';
import { getRecordingState, resetRunStateToIdle, setRecordingState } from '../../storage/storage';
import { markEditorOpenFailed } from '../recording-recovery';
import type { FinishResult, RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import { UNDO_WINDOW_MS, type RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import {
  deleteEmptySnapshotAnchor,
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
  const { control, runtime: recorderRuntime, undoWindow, captureFlow, editorOpen } = deps;
  const { updateRunState, setRunError } = deps.runState;
  const { createAndActivateSnapshotAnchor } = captureFlow;

  function controlFailure(error: string): RecordingControlResult {
    return { ok: false, error };
  }

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
      return { ok: true };
    });
  }

  async function prepareNextSnapshot(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const initial = await getRecordingState();
    if (
      !initial.isRecording ||
      !initial.sessionId ||
      initial.runId !== message.runId ||
      initial.mode !== 'snapshot' ||
      initial.phase !== 'recording'
    ) {
      return controlFailure(t().background.cannotCreateNextSnapshot);
    }

    control.claimControl({ discardUndo: true, bumpVersion: false });
    await waitForQueuedClicks();

    const previous = await queueStateMutation(async () => {
      const current = await getRecordingState();
      if (
        !current.isRecording ||
        current.runId !== message.runId ||
        current.mode !== 'snapshot' ||
        current.phase !== 'recording'
      ) {
        return null;
      }
      await setRecordingState({
        ...current,
        phase: 'preparing-next',
        itemCount: 0,
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        error: null,
        recoverableError: null,
      });
      return current;
    });
    if (!previous) return controlFailure(t().background.nextSnapshotStateChanged);

    await deleteEmptySnapshotAnchor(previous);
    try {
      if (previous.tabId == null) throw new Error('Recorded tab is no longer available.');
      // Re-injection tears down the shield and mounts the lightweight preparing-next
      // toolbar; all-frames mirrors startup injection so stale child recorders tear down too.
      await recorderRuntime.injectRecorder(previous.tabId, true);
    } catch (error) {
      console.error('[stepmark] failed to enter snapshot preparation state', error);
      await setRunError(message.runId, t().background.nextSnapshotControlsFailed);
      return controlFailure(t().background.nextSnapshotPrepareFailed);
    }
    return { ok: true };
  }

  async function createNextSnapshot(
    message: RecordingControlMessage,
    sourcePhase: 'preparing-next' | 'invalidated' = 'preparing-next',
  ): Promise<RecordingControlResult> {
    const claimed = await queueStateMutation(async () => {
      const current = await getRecordingState();
      if (
        !current.isRecording ||
        !current.sessionId ||
        current.tabId == null ||
        current.runId !== message.runId ||
        current.mode !== 'snapshot' ||
        current.phase !== sourcePhase
      ) {
        return null;
      }
      const version = control.bumpVersion();
      const next: RecordingState = {
        ...current,
        phase: 'starting',
        itemCount: 0,
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        error: null,
        recoverableError: null,
      };
      await setRecordingState(next);
      return { state: next, previous: current, version };
    });
    if (!claimed) return controlFailure(t().background.cannotCreateNextSnapshot);

    // Version already bumped in the claim mutation above; cancelling the recorder gate
    // here (not via manual pre-cancel) lets the ready-gate helper publish into an empty slot.
    control.claimControl({
      cancelRecorderGate: true,
      discardUndo: true,
      clearSnapshotContext: true,
      bumpVersion: false,
    });
    const { state, previous, version } = claimed;

    try {
      const tab = await browser.tabs.get(state.tabId!);
      if (tab.windowId == null || !isRecordableTabUrl(tab.url)) throw new Error('Snapshot tab cannot be captured.');
      return await control.withRecorderReadyGate({
        slot: 'pendingRecorderReady',
        identity: { runId: message.runId, tabId: state.tabId!, controlVersion: version },
        inject: () => recorderRuntime.injectRecorder(state.tabId!, true),
        notReadyError: () => new StaleCaptureError('Snapshot recorder did not become ready.'),
        ready: async () => {
          if (version !== control.controlVersion) {
            throw new StaleCaptureError('Snapshot recorder did not become ready.');
          }
          const context = control.pendingSnapshotContext;
          if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
          await createAndActivateSnapshotAnchor(state, state.tabId!, tab.windowId!, context, version);
          const updated = await updateRunState(
            message.runId,
            (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
            version,
          );
          if (!updated) throw new StaleCaptureError('Recording changed while activating the next snapshot.');
          control.acceptingClicks = true;
          return { ok: true } as const;
        },
      });
    } catch (error) {
      console.error('[stepmark] failed to create next snapshot', error);
      control.acceptingClicks = false;
      const rebuildingInvalidated = sourcePhase === 'invalidated';
      const errorMessage = rebuildingInvalidated ? t().background.rebuildSnapshotFailed : t().background.createSnapshotFailed;
      if (version === control.controlVersion) {
        await updateRunState(
          message.runId,
          (current) => ({
            ...current,
            phase: sourcePhase,
            itemCount: rebuildingInvalidated ? previous.itemCount : 0,
            groupAnchorId: rebuildingInvalidated ? previous.groupAnchorId : null,
            snapshotViewport: rebuildingInvalidated ? previous.snapshotViewport : null,
            snapshotDevicePixelRatio: rebuildingInvalidated ? previous.snapshotDevicePixelRatio : null,
            error: errorMessage,
            recoverableError: {
              code: rebuildingInvalidated ? 'REBUILD_SNAPSHOT_FAILED' : 'CREATE_SNAPSHOT_FAILED',
              message: errorMessage,
            },
          }),
          version,
        );
        try {
          await recorderRuntime.injectRecorder(state.tabId!, true);
        } catch (reinjectionError) {
          console.error('[stepmark] failed to restore snapshot preparation toolbar', reinjectionError);
        }
      }
      return controlFailure(errorMessage);
    }
  }

  async function switchToSnapshotMode(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const isSwitchable = (state: RecordingState) =>
      state.isRecording &&
      state.operation === 'recording' &&
      state.runId === message.runId &&
      state.tabId != null &&
      state.mode === 'steps' &&
      (state.phase === 'recording' || state.phase === 'paused');
    if (!isSwitchable(await getRecordingState())) return controlFailure(t().background.cannotSwitchToSnapshot);

    control.claimControl({ discardUndo: true, bumpVersion: false });
    control.acceptingClicks = false;
    await waitForQueuedClicks();

    const previous = await queueStateMutation(async () => {
      const current = await getRecordingState();
      if (!isSwitchable(current)) return null;
      await setRecordingState({
        ...current,
        mode: 'snapshot',
        phase: 'preparing-next',
        itemCount: 0,
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        error: null,
        recoverableError: null,
      });
      return current;
    });
    if (!previous) return controlFailure(t().background.switchStateChanged);

    try {
      await recorderRuntime.injectRecorder(previous.tabId!, true);
    } catch (error) {
      console.error('[stepmark] failed to switch to snapshot mode', describeBrowserError(error), error);
      await updateRunState(message.runId, () => previous);
      control.acceptingClicks = previous.phase === 'recording';
      try {
        await recorderRuntime.injectRecorder(previous.tabId!, true);
      } catch (restoreError) {
        console.error('[stepmark] failed to restore the step recorder', describeBrowserError(restoreError), restoreError);
      }
      return controlFailure(t().background.switchToSnapshotFailed);
    }
    return { ok: true };
  }

  async function switchToStepsMode(message: RecordingControlMessage): Promise<RecordingControlResult> {
    const isSwitchable = (state: RecordingState) =>
      state.isRecording &&
      state.operation === 'recording' &&
      !!state.sessionId &&
      state.runId === message.runId &&
      state.tabId != null &&
      state.mode === 'snapshot' &&
      (state.phase === 'recording' || state.phase === 'preparing-next' || state.phase === 'invalidated');
    if (!isSwitchable(await getRecordingState())) return controlFailure(t().background.cannotSwitchToSteps);

    control.claimControl({ discardUndo: true, bumpVersion: false });
    control.acceptingClicks = false;
    await waitForQueuedClicks();

    const claimed = await queueStateMutation(async () => {
      const current = await getRecordingState();
      if (!isSwitchable(current)) return null;
      const version = control.bumpVersion();
      await setRecordingState({
        ...current,
        mode: 'steps',
        phase: 'starting',
        itemCount: 0,
        groupAnchorId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
        error: null,
        recoverableError: null,
      });
      return { previous: current, version };
    });
    if (!claimed) return controlFailure(t().background.switchStateChanged);
    const { previous, version } = claimed;
    control.claimControl({
      cancelRecorderGate: true,
      discardUndo: true,
      clearSnapshotContext: true,
      bumpVersion: false,
    });

    try {
      // What was annotated stays; only a snapshot that never got an annotation is dropped.
      await deleteEmptySnapshotAnchor(previous);
      return await control.withRecorderReadyGate({
        slot: 'pendingRecorderReady',
        identity: { runId: message.runId, tabId: previous.tabId!, controlVersion: version },
        inject: () => recorderRuntime.injectRecorder(previous.tabId!, true),
        notReadyError: () => new StaleCaptureError('Step recorder did not become ready.'),
        ready: async () => {
          const updated = await updateRunState(
            message.runId,
            (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
            version,
          );
          if (!updated) throw new StaleCaptureError('Recording changed while switching to steps.');
          control.acceptingClicks = true;
          return { ok: true } as const;
        },
      });
    } catch (error) {
      console.error('[stepmark] failed to switch to steps mode', describeBrowserError(error), error);
      control.acceptingClicks = false;
      if (version === control.controlVersion) {
        await updateRunState(
          message.runId,
          (current) => ({
            ...current,
            mode: 'snapshot',
            phase: 'preparing-next',
            error: t().background.switchToStepsFailed,
            recoverableError: { code: 'SWITCH_TO_STEPS_FAILED', message: t().background.switchToStepsFailed },
          }),
          version,
        );
        try {
          await recorderRuntime.injectRecorder(previous.tabId!, true);
        } catch (reinjectionError) {
          console.error('[stepmark] failed to restore snapshot preparation toolbar', reinjectionError);
        }
      }
      return controlFailure(t().background.switchToStepsFailed);
    }
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
      console.error('[stepmark] failed to open editor after recording', error);
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
      console.error('[stepmark] failed to discard current recording', error);
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
        console.warn('[stepmark] rejected an untrusted recorder control message', message.type);
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
