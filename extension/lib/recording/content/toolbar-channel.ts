import { sendToBackground, type BackgroundTransport } from '../../runtime/background-client';
import type { RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';

export type ToolbarChannel = ReturnType<typeof createToolbarChannel>;

/** The in-page toolbar's view of the run, and its control channel to the
 * background. Shared by the floating step toolbar and the shield toolbar so
 * their state and command handling cannot drift apart. */
export function createToolbarChannel(runId: string, send: BackgroundTransport) {
  function toToolbarState(state: RecordingState) {
    return {
      runId,
      mode: state.mode,
      phase: state.phase,
      itemCount: state.itemCount,
      runItemCount: state.runItemCount,
      projectTitle: state.targetProjectTitle,
      error: state.recoverableError?.copy ?? state.error,
    };
  }

  /** Sends a toolbar command over the recorder's connection. A worker that
   * stops or restarts closes it, which fails the command at once, so no timer
   * stands guard any more. */
  async function sendCommand(
    action: RecordingControlMessage['type'],
    undoToken?: string,
  ): Promise<RecordingControlResult> {
    const message: RecordingControlMessage = { type: action, runId, ...(undoToken ? { undoToken } : {}) };
    return sendToBackground(message, undefined, send).catch(
      (): RecordingControlResult => ({ ok: false, error: 'runtime.recordingChannelLost' }),
    );
  }

  return { toToolbarState, sendCommand };
}
