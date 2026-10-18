import { queueLifecycle } from '../background-queues';
import { getRecordingState } from '../../storage/storage';
import { recordedTabClosedError } from '../recording-recovery';
import type { RecoverableRecordingError } from '../../storage/recording-state';
import { deleteEmptySnapshotAnchorBestEffort } from './run-cleanup';
import type { ControlPlane } from './control-plane';
import type { FollowMode } from './follow-mode';
import type { RecorderRuntime } from './recorder-runtime';

/** How a live run ends on an error, and what happens when its tab is gone. */
export function createRunEnding(deps: { control: ControlPlane; runtime: RecorderRuntime; followMode: FollowMode }) {
  const { control, runtime: recorderRuntime, followMode } = deps;

  function stopRunWithError(
    runId: string,
    error: string,
    expectedControlVersion: number,
    recoverableError?: RecoverableRecordingError,
  ): Promise<void> {
    if (expectedControlVersion !== control.controlVersion) return Promise.resolve();
    const version = control.claimControl({ cancelRecorderGate: true, clearSnapshotContext: true });
    return handleStopRunWithError(runId, error, version, recoverableError);
  }

  /**
   * The tab the run lives in is gone (closed, or found missing mid-operation).
   * A run that could follow the user continues in another tab; only a run with
   * nowhere to go ends with RECORDED_TAB_CLOSED. Serialized with START/STOP and
   * follow moves through the lifecycle queue — callers already inside the click
   * queue must not await it (START/STOP wait for queued clicks).
   */
  function handleRecordedTabGone(tabId: number): Promise<void> {
    const expectedControlVersion = control.controlVersion;
    return queueLifecycle(async () => {
      const state = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        !state.isRecording ||
        state.operation !== 'recording' ||
        state.tabId !== tabId ||
        !state.runId
      ) {
        return;
      }
      const outcome = await followMode.continueAfterRecordedTabClosed(tabId, expectedControlVersion);
      if (outcome !== 'nowhere') return;
      await stopRunWithError(
        state.runId,
        recordedTabClosedError().message,
        expectedControlVersion,
        recordedTabClosedError(),
      );
    });
  }

  async function handleStopRunWithError(
    runId: string,
    error: string,
    version: number,
    recoverableError?: RecoverableRecordingError,
  ): Promise<void> {
    // The error-stop shape deliberately differs from resetRunStateToIdle: phase
    // 'error' plus the kept error text drive the popup's recovery flow.
    const stopped = await control.writeStateIf(
      version,
      (state) => state.isRecording && state.runId === runId,
      (state) => ({
        ...state,
        operation: null,
        isRecording: false,
        phase: 'error',
        tabId: null,
        error,
        recoverableError: recoverableError ?? { code: 'RECORDING_STOPPED', message: error },
        groupAnchorId: null,
        runId: null,
        // Error stops never reclaim the auto-created Project: the recovery flow
        // (完成並開啟編輯器) still targets sessionId and must find it.
        autoCreatedProjectId: null,
        snapshotViewport: null,
        snapshotDevicePixelRatio: null,
      }),
    );
    if (!stopped) return;
    const stoppedState = stopped.previous;
    // Only after the run stopped referencing it: an interruption here leaks an
    // orphan row at worst, never a live run pointing at a deleted anchor.
    await deleteEmptySnapshotAnchorBestEffort(stoppedState);
    await recorderRuntime.stopRecorderInTab(stoppedState.tabId);
  }

  return { stopRunWithError, handleRecordedTabGone };
}

export type RunEnding = ReturnType<typeof createRunEnding>;
