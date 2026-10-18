import { browser } from 'wxt/browser';
import {
  StaleCaptureError,
  queueStateMutation,
  waitForQueuedClicks,
} from '../background-queues';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { describeBrowserError } from '../../runtime/browser-errors';
import { getRecordingState, setRecordingState } from '../../storage/storage';
import type { RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { controlFailure } from './control-result';
import { deleteEmptySnapshotAnchor } from './run-cleanup';
import type { CaptureFlow } from './capture-flow';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';
import type { RunState } from './run-state';

export interface SnapshotControlDependencies {
  control: ControlPlane;
  runtime: RecorderRuntime;
  runState: RunState;
  captureFlow: CaptureFlow;
}

/** A live run's snapshot steps and its switches between steps and snapshot mode. */
export function createSnapshotControls(deps: SnapshotControlDependencies) {
  const { control, runtime: recorderRuntime } = deps;
  const { updateRunState, setRunError } = deps.runState;
  const { createAndActivateSnapshotAnchor } = deps.captureFlow;

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

  return { prepareNextSnapshot, createNextSnapshot, switchToSnapshotMode, switchToStepsMode };
}

export type SnapshotControls = ReturnType<typeof createSnapshotControls>;
