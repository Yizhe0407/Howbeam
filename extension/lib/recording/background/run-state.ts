import { queueStateMutation } from '../background-queues';
import { isMatchingSnapshotViewport } from '../recording-guards';
import { getRecordingState, setRecordingState } from '../../storage/storage';
import type { ClickCapture } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import type { ControlPlane } from './control-plane';
import type { CopyKey } from '../../shared/i18n/copy';

/** Guarded writes to the live recording run's state. */
export function createRunState(deps: { control: ControlPlane }) {
  const { control } = deps;

  /** Applies `update` only while `runId` is still the live recording (and the
   * control version, when given, still matches). */
  async function updateRunState(
    runId: string,
    update: (current: RecordingState) => RecordingState,
    expectedControlVersion?: number,
  ): Promise<boolean> {
    const written = await control.writeStateIf(
      expectedControlVersion ?? null,
      (current) => current.isRecording && current.operation === 'recording' && current.runId === runId,
      update,
    );
    return written !== null;
  }

  async function setRunError(runId: string, error: CopyKey): Promise<void> {
    await updateRunState(runId, (current) => ({
      ...current,
      error,
      recoverableError: { code: 'CAPTURE_FAILED', copy: error },
    }));
  }

  // Not writeStateIf: the already-invalidated -> true answer must stay atomic with
  // the claim-and-write, or a racing control could wrongly report false here.
  async function invalidateSnapshotRun(
    runId: string,
    viewport: ClickCapture['viewport'],
    devicePixelRatio: number,
    expectedControlVersion: number,
  ): Promise<boolean> {
    return queueStateMutation(async () => {
      const current = await getRecordingState();
      if (
        current.isRecording &&
        current.runId === runId &&
        current.mode === 'snapshot' &&
        current.phase === 'invalidated'
      ) {
        return true;
      }
      if (
        expectedControlVersion !== control.controlVersion ||
        !current.isRecording ||
        current.runId !== runId ||
        current.mode !== 'snapshot' ||
        current.phase !== 'recording' ||
        !current.snapshotViewport ||
        current.snapshotDevicePixelRatio == null ||
        isMatchingSnapshotViewport(
          current.snapshotViewport,
          current.snapshotDevicePixelRatio,
          viewport,
          devicePixelRatio,
        )
      ) {
        return false;
      }

      control.claimControl({ discardUndo: true });
      await setRecordingState({
        ...current,
        phase: 'invalidated',
        error: null,
        recoverableError: {
          code: 'SNAPSHOT_VIEWPORT_CHANGED',
          copy: 'background.snapshotViewportChanged',
        },
      });
      return true;
    });
  }

  return { updateRunState, setRunError, invalidateSnapshotRun };
}

export type RunState = ReturnType<typeof createRunState>;
