import { browser } from 'wxt/browser';
import { RECORDING_CONTROL_TIMEOUT_MS } from '../content-script-constants';
import { isRecordingControlResult, requireRuntimeMessageResult } from '../../runtime/runtime-message-result';
import type { RecordingControlMessage, RecordingControlResult } from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';

export type ToolbarChannel = ReturnType<typeof createToolbarChannel>;

/** The in-page toolbar's view of the run, and its control channel to the
 * background. Shared by the floating step toolbar and the shield toolbar so
 * their state and command handling cannot drift apart. */
export function createToolbarChannel(runId: string) {
  function toToolbarState(state: RecordingState) {
    return {
      runId,
      mode: state.mode,
      phase: state.phase,
      itemCount: state.itemCount,
      runItemCount: state.runItemCount,
      projectTitle: state.targetProjectTitle,
      error: state.recoverableError?.message ?? state.error,
    };
  }

  async function sendCommand(
    action: RecordingControlMessage['type'],
    undoToken?: string,
  ): Promise<RecordingControlResult> {
    const command = (async () =>
      requireRuntimeMessageResult<RecordingControlResult>(
        await browser.runtime.sendMessage({
          type: action,
          runId,
          ...(undoToken ? { undoToken } : {}),
        } satisfies RecordingControlMessage),
        isRecordingControlResult,
        t().runtime.recordingChannelLost,
      ))();
    // A hung background must not wedge the in-page toolbar forever: surface
    // the channel-failure error after the shared control budget (the same
    // one the shield toolbar uses), so controls re-enable and the user sees
    // what went wrong.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        command,
        new Promise<RecordingControlResult>((resolve) => {
          timeout = setTimeout(
            () => resolve({ ok: false, error: t().runtime.recordingChannelLost }),
            RECORDING_CONTROL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      // A late settlement after the timeout must not surface as unhandled.
      command.catch(() => undefined);
    }
  }

  return { toToolbarState, sendCommand };
}
