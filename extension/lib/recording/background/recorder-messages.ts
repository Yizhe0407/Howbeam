import type { Browser } from 'wxt/browser';
import { isTrustedRecorderControlSender } from '../../runtime/background-message-validation';
import { isValidSnapshotViewportContext } from '../recording-guards';
import { t } from '@/lib/shared/i18n';
import { getRecordingState } from '../../storage/storage';
import type {
  BackgroundMessage,
  ClickCaptureResult,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
} from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { cancelCapture } from './capture-registry';
import type { ControlPlane } from './control-plane';
import type { RunEnding } from './run-ending';
import type { RunState } from './run-state';

/** What the recorder in the recorded tab reports on its own: its READY
 * handshake, a snapshot it saw invalidated or broken, and a cancelled gesture. */
export function createRecorderMessages(deps: { control: ControlPlane; runState: RunState; runEnding: RunEnding }) {
  const { control, runState } = deps;
  const { stopRunWithError } = deps.runEnding;

  interface ValidatedRecorderSender {
    tabId: number;
    state: RecordingState;
    expectedControlVersion: number;
  }

  /** 驗證錄製器來源、流程身分、tab 所有權及 handler 專屬狀態。 */
  async function validateRecorderMessageSender(
    message: { runId: string },
    sender: Browser.runtime.MessageSender,
    opts: {
      /** Snapshot-only handlers reject every other mode. */
      mode?: RecordingState['mode'];
      /** Handlers that must never act during a recapture require the operation. */
      operation?: 'recording';
      /** The startup handshake additionally verifies full sender trust. */
      requireTrustedControlSender?: boolean;
      /** Most handlers reject when control changed during the state read; the
       * invalidation handler defers that check to its atomic state mutation. */
      requireCurrentControlVersion?: boolean;
    } = {},
  ): Promise<ValidatedRecorderSender | null> {
    const tabId = sender.tab?.id;
    if (tabId == null || sender.frameId !== 0) return null;
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      (opts.requireCurrentControlVersion !== false && expectedControlVersion !== control.controlVersion) ||
      !state.isRecording ||
      (opts.operation !== undefined && state.operation !== opts.operation) ||
      state.runId !== message.runId ||
      state.tabId !== tabId ||
      (opts.mode !== undefined && state.mode !== opts.mode) ||
      (opts.requireTrustedControlSender === true && !isTrustedRecorderControlSender(sender, state.tabId))
    ) {
      return null;
    }
    return { tabId, state, expectedControlVersion };
  }

  async function handleRecorderReady(
    message: Extract<BackgroundMessage, { type: 'STEPMARK_READY' }>,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    const validated = await validateRecorderMessageSender(message, sender, {
      requireTrustedControlSender: true,
    });
    if (!validated) return false;
    const { tabId, state, expectedControlVersion } = validated;

    const identity = {
      runId: message.runId,
      tabId,
      controlVersion: expectedControlVersion,
    };
    const matchesPendingStartup = control.pendingRecorderReady?.matches(identity) === true;
    const signaled = control.pendingRecorderReady?.signal(identity);
    if (matchesPendingStartup) control.pendingSnapshotContext = message.snapshotContext;

    // Re-injections after navigation have no startup gate; the current run is
    // already accepting clicks and only needs its new listener set validated.
    return (
      matchesPendingStartup ||
      signaled === true ||
      state.phase === 'paused' ||
      state.phase === 'preparing-next' ||
      control.acceptingClicks
    );
  }

  async function handleSnapshotInvalidated(
    message: SnapshotInvalidatedMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    if (!isValidSnapshotViewportContext(message.viewport, message.devicePixelRatio)) return false;
    const validated = await validateRecorderMessageSender(message, sender, {
      mode: 'snapshot',
      requireCurrentControlVersion: false,
    });
    if (!validated) return false;
    const { state, expectedControlVersion } = validated;
    if (state.phase === 'invalidated') return true;
    return runState.invalidateSnapshotRun(
      message.runId,
      message.viewport,
      message.devicePixelRatio,
      expectedControlVersion,
    );
  }


  async function handleSnapshotRecorderFailure(
    message: SnapshotRecorderFailureMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    const validated = await validateRecorderMessageSender(message, sender, {
      mode: 'snapshot',
      operation: 'recording',
    });
    if (!validated) return false;
    const { expectedControlVersion } = validated;
    const error = t().background.shieldInterrupted;
    await stopRunWithError(message.runId, error, expectedControlVersion, {
      code: 'SNAPSHOT_SHIELD_FAILED',
      message: error,
    });
    return true;
  }

  async function handleCancelCapture(
    message: Extract<BackgroundMessage, { type: 'STEPMARK_CANCEL_CAPTURE' }>,
    sender: Browser.runtime.MessageSender,
  ): Promise<ClickCaptureResult> {
    // No version requirement: cancelling an already-doomed capture is harmless,
    // and the capture registry only ever cancels ids it still tracks.
    const validated = await validateRecorderMessageSender(message, sender, {
      operation: 'recording',
      requireCurrentControlVersion: false,
    });
    if (!validated) return { ok: false, error: 'untrusted-sender' };
    cancelCapture(message.captureId);
    return { ok: true };
  }

  return { handleRecorderReady, handleSnapshotInvalidated, handleSnapshotRecorderFailure, handleCancelCapture };
}
