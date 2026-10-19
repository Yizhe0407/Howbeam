import { browser, type Browser } from 'wxt/browser';
import { StaleCaptureError, waitForQueuedClicks } from '../background-queues';
import { getRecordingState } from '../../storage/storage';
import { replaceStepCaptureAtomically, StepRecaptureError } from '../../storage/step-repository';
import { isTrustedRecaptureSourceSender } from '../../capture/recapture-guards';
import { focusTab } from '../../runtime/navigation';
import {
  checkSourcePermission,
  isEditorSenderForSession,
  openVerifiedSourceTab,
  sourcePermissionPreflightSuccess,
  withUncommittedSourceTab,
} from './source-tab';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  isCaptureCommitting,
  markCaptureCommitting,
  releaseCapture,
} from './capture-registry';
import { createRecaptureSettlement } from './recapture-settlement';
import {
  recaptureTargetErrorMessage,
  StepRecaptureStartError,
  validateRecaptureTarget,
  type ValidatedRecaptureTarget,
} from './recapture-target';
import type { ControlPlane } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';
import type {
  AckStepRecaptureResultMessage,
  CancelStepRecaptureMessage,
  CancelStepRecaptureResult,
  ClickCapture,
  FocusStepRecaptureSourceMessage,
  FocusStepRecaptureSourceResult,
  HowbeamRecaptureReadyMessage,
  HowbeamRecaptureTargetMessage,
  PreflightStepRecaptureSourcePermissionMessage,
  PreflightStepRecaptureSourcePermissionResult,
  StartStepRecaptureMessage,
  StartStepRecaptureResult,
  StepRecaptureTargetResult,
} from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { t } from '@/lib/shared/i18n';
import { UserFacingError, userFacingErrorMessage } from '../../runtime/user-facing-errors';

function recaptureFailure(
  code: Exclude<StartStepRecaptureResult, { ok: true }>['code'],
  error: string,
): StartStepRecaptureResult {
  return { ok: false, code, error };
}

function isRecaptureSourceSender(
  sender: Browser.runtime.MessageSender,
  context: NonNullable<RecordingState['recapture']>,
): boolean {
  return isTrustedRecaptureSourceSender(sender, context);
}

function recapturePreflightFailure(
  code: Exclude<PreflightStepRecaptureSourcePermissionResult, { ok: true }>['code'],
  message: string,
): PreflightStepRecaptureSourcePermissionResult {
  return { ok: false, code, message };
}

export interface RecaptureFlowDeps {
  control: ControlPlane;
  runtime: RecorderRuntime;
  /** The serialized, presentation-aware screenshot pipeline shared with step
   * capture; the flow supplies its own recapture context assertion. The
   * cancellation/commit markers both flows share live in capture-registry. */
  captureScreenshotWithGuard(
    message: Pick<ClickCapture, 'viewport' | 'devicePixelRatio' | 'captureId'>,
    tabId: number,
    windowId: number,
    assertContext: () => Promise<void>,
  ): Promise<{ blob: Blob; scale: number }>;
  /** The single editor opener, so settling a recapture returns the user to the
   * one editor tab rather than growing a second one. */
  openEditor(target: { sessionId: string; entryId: string }): Promise<unknown>;
}

/**
 * The one-shot step/snapshot recapture flow: preflight, start, target capture
 * and cancel; how it ends lives in recapture-settlement. All persisted state
 * lives in RecordingState.recapture; this module privately owns only the start
 * mutex.
 */
export function createRecaptureFlow(deps: RecaptureFlowDeps) {
  const { control, runtime } = deps;
  const settlement = createRecaptureSettlement(deps);
  const { settle: settleStepRecapture, fail: failStepRecapture } = settlement;

  // A dedicated start mutex instead of queueLifecycle: the recapture start
  // holds it across a ready-gate wait of up to RECORDER_READY_TIMEOUT_MS, and
  // queueing that behind START/STOP would let one hung start delay every
  // lifecycle control. The mutex only needs to serialize concurrent recapture
  // starts — everything else is guarded by the persisted single-owner state.
  let startingRecapture = false;

  /**
   * Recapture leg of the tabs.onUpdated listener (which stays wired in the
   * background entrypoint, mirroring follow-mode's listener/logic split).
   * Returns true when the update belonged to this flow's source tab — handled
   * or deliberately ignored — so the listener skips its recording legs.
   */
  async function handleSourceTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string },
  ): Promise<boolean> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.sourceTabId !== tabId
    ) {
      return false;
    }
    const context = state.recapture;
    // Startup intentionally waits for the initial document to finish. Once
    // selection is enabled, any navigation invalidates this one-shot job.
    if (
      context.phase !== 'starting' &&
      (changeInfo.status === 'loading' || (changeInfo.url != null && changeInfo.url !== context.sourceUrl))
    ) {
      await failStepRecapture(
        context.runId,
        'SOURCE_NAVIGATED',
        t().recaptureFlow.sourceNavigated,
        expectedControlVersion,
      );
    }
    return true;
  }

  /** Recapture leg of tabs.onRemoved; same contract as handleSourceTabUpdated. */
  async function handleSourceTabRemoved(tabId: number): Promise<boolean> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.sourceTabId !== tabId
    ) {
      return false;
    }
    await failStepRecapture(
      state.recapture.runId,
      'SOURCE_TAB_CLOSED',
      t().recaptureFlow.sourceTabClosed,
      expectedControlVersion,
    );
    return true;
  }

  async function handleRecaptureReady(
    message: HowbeamRecaptureReadyMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    const context = (await getRecordingState()).recapture;
    if (
      !context ||
      context.runId !== message.runId ||
      context.phase !== 'starting' ||
      !isRecaptureSourceSender(sender, context) ||
      message.url !== context.sourceUrl
    ) {
      return false;
    }
    return control.pendingRecaptureReady?.signal({
      runId: message.runId,
      tabId: context.sourceTabId,
      controlVersion: control.controlVersion,
    }) ?? false;
  }

  async function preflightStepRecaptureSourcePermission(
    message: PreflightStepRecaptureSourcePermissionMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<PreflightStepRecaptureSourcePermissionResult> {
    // The message shape (including the target) was already validated by the
    // canonical isBackgroundMessage guard at listener entry; only the trust
    // relationship between this editor and the session remains to check here.
    if (
      typeof message.sessionId !== 'string' ||
      message.sessionId.trim().length === 0 ||
      !isEditorSenderForSession(sender, message.sessionId)
    ) {
      return recapturePreflightFailure('INVALID_EDITOR', t().recaptureFlow.editorOnlyPreflight);
    }

    let validated: ValidatedRecaptureTarget;
    try {
      validated = await validateRecaptureTarget(message.sessionId, message.target);
    } catch (error) {
      if (error instanceof StepRecaptureStartError) {
        return recapturePreflightFailure(error.code, error.message);
      }
      throw error;
    }

    return (
      sourcePermissionPreflightSuccess(validated.sourceUrl) ??
      recapturePreflightFailure('RESTRICTED_SOURCE', t().recaptureFlow.restrictedSource)
    );
  }

  async function handleStartStepRecapture(
    message: StartStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
    version: number,
  ): Promise<StartStepRecaptureResult> {
    await waitForQueuedClicks();
    if (version !== control.controlVersion) return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.operationChanged);

    if (!isEditorSenderForSession(sender, message.sessionId)) {
      return recaptureFailure('INVALID_EDITOR', t().recaptureFlow.editorOnlyStart);
    }
    const current = await getRecordingState();
    if (current.operation !== null || current.isRecording) {
      return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.activeOperation);
    }

    let validated: ValidatedRecaptureTarget;
    try {
      validated = await validateRecaptureTarget(message.sessionId, message.target);
    } catch (error) {
      if (error instanceof StepRecaptureStartError) return recaptureFailure(error.code, error.message);
      throw error;
    }
    const permission = await checkSourcePermission(validated.sourceUrl);
    if (permission === 'restricted') {
      return recaptureFailure('RESTRICTED_SOURCE', t().recaptureFlow.restrictedSource);
    }
    if (permission === 'permission-required') {
      return recaptureFailure('HOST_PERMISSION_REQUIRED', t().recaptureFlow.accessRequired);
    }

    const opened = await openVerifiedSourceTab(
      validated.sourceUrl,
      message.preferredTabId,
      'failed to open recapture source tab',
    );
    if (!opened.ok) {
      return recaptureFailure(
        'SOURCE_TAB_FAILED',
        opened.reason === 'open-failed'
          ? t().background.sourceTabOpenFailed
          : opened.reason === 'unreachable'
            ? t().recaptureFlow.sourceUnreachable
            : t().recaptureFlow.sourceRedirected,
      );
    }
    const source = opened.source;
    const sourceTab = source.tab;

    return withUncommittedSourceTab(source, async (commit) => {
      if (sourceTab.id == null || sourceTab.windowId == null) {
        return recaptureFailure('SOURCE_TAB_FAILED', t().recaptureFlow.sourceRedirected);
      }
      if (version !== control.controlVersion) {
        return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.operationChanged);
      }

      const runId = crypto.randomUUID();
      const recapture = {
        runId,
        sessionId: message.sessionId,
        target: validated.target,
        entryId: validated.entryId,
        phase: 'starting' as const,
        sourceTabId: sourceTab.id,
        sourceWindowId: sourceTab.windowId,
        sourceUrl: validated.sourceUrl,
        sourceTabCreated: !source.reused,
        startedAt: Date.now(),
      };
      const started = await control.writeStateForControl(version, (state) => ({
        ...state,
        operation: 'recapture',
        isRecording: false,
        phase: 'idle',
        sessionId: message.sessionId,
        tabId: null,
        runId: null,
        error: null,
        recoverableError: null,
        recapture,
        recaptureResult: null,
      }));
      if (!started) {
        return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.operationChanged);
      }
      // From here the persisted recapture context owns the tab; failure paths
      // settle through failStepRecapture, which closes a created tab itself.
      commit();

      try {
        return await control.withRecorderReadyGate({
          slot: 'pendingRecaptureReady',
          identity: { runId, tabId: sourceTab.id, controlVersion: version },
          inject: () => runtime.injectRecorder(sourceTab.id!, true),
          notReadyError: () => new Error('Recapture recorder did not become ready before timeout.'),
          ready: async () => {
            const activated = await control.writeStateIf(
              version,
              (state) =>
                state.operation === 'recapture' &&
                state.recapture?.runId === runId &&
                state.recapture.phase === 'starting',
              (state) => ({
                ...state,
                recapture: { ...state.recapture!, phase: 'awaiting-target' },
              }),
            );
            if (!activated) throw new StaleCaptureError('Recapture changed during startup.');
            control.acceptingClicks = true;
            await focusTab(sourceTab.id!, sourceTab.windowId);
            return { ok: true as const, runId, tabId: sourceTab.id!, reusedTab: source.reused };
          },
        });
      } catch (error) {
        console.error('[howbeam] failed to start recapture recorder', error);
        if (version === control.controlVersion) {
          await failStepRecapture(runId, 'INJECTION_FAILED', t().recaptureFlow.injectFailed, version);
        }
        return recaptureFailure('INJECTION_FAILED', t().recaptureFlow.injectFailed);
      }
    });
  }

  async function startStepRecapture(
    message: StartStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<StartStepRecaptureResult> {
    if (!isEditorSenderForSession(sender, message.sessionId)) {
      return recaptureFailure('INVALID_EDITOR', t().recaptureFlow.editorOnlyProjectStart);
    }
    if (startingRecapture) return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.alreadyStarting);
    startingRecapture = true;
    try {
      const current = await getRecordingState();
      if (current.operation !== null || current.isRecording) {
        return recaptureFailure('ACTIVE_OPERATION', t().recaptureFlow.activeOperation);
      }
      const version = control.claimControl({
        cancelRecorderGate: true,
        cancelRecaptureGate: true,
        discardUndo: true,
      });
      return await handleStartStepRecapture(message, sender, version);
    } finally {
      startingRecapture = false;
    }
  }

  async function cancelStepRecapture(
    message: CancelStepRecaptureMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<CancelStepRecaptureResult> {
    const state = await getRecordingState();
    if (state.recaptureResult?.runId === message.runId) return { ok: true, status: 'already-completed' };
    if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
      return { ok: false, error: t().recaptureFlow.alreadyEnded };
    }
    const context = state.recapture;
    if (!isEditorSenderForSession(sender, context.sessionId) && !isRecaptureSourceSender(sender, context)) {
      return { ok: false, error: t().recaptureFlow.invalidSource };
    }
    const captureId = settlement.activeCaptureId();
    if (captureId && isCaptureCommitting(captureId)) {
      await waitForQueuedClicks();
      return { ok: true, status: 'already-completed' };
    }
    if (captureId) cancelCapture(captureId);
    const version = control.claimControl({ cancelRecaptureGate: true });
    await waitForQueuedClicks();
    // 原本內容 (not 原內容) matches the editor's own recapture wording.
    const settled = await settleStepRecapture(message.runId, 'cancelled', version, 'CANCELLED', t().recaptureFlow.cancelled);
    return settled ? { ok: true, status: 'cancelled' } : { ok: true, status: 'already-completed' };
  }

  async function ackStepRecaptureResult(
    message: AckStepRecaptureResultMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<boolean> {
    if (!isEditorSenderForSession(sender, message.sessionId)) return false;
    const acknowledged = await control.writeStateIf(
      null,
      (state) =>
        state.recaptureResult?.runId === message.runId &&
        state.recaptureResult.sessionId === message.sessionId,
      (state) => ({ ...state, recaptureResult: null }),
    );
    return acknowledged !== null;
  }

  async function focusStepRecaptureSource(
    message: FocusStepRecaptureSourceMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<FocusStepRecaptureSourceResult> {
    const state = await getRecordingState();
    if (state.operation !== 'recapture' || state.recapture?.runId !== message.runId) {
      return { ok: false, error: t().recaptureFlow.alreadyEnded };
    }
    if (!isEditorSenderForSession(sender, state.recapture.sessionId)) {
      return { ok: false, error: t().recaptureFlow.invalidEditor };
    }
    try {
      await focusTab(state.recapture.sourceTabId, state.recapture.sourceWindowId);
      return { ok: true };
    } catch {
      return { ok: false, error: t().recaptureFlow.tabMissing };
    }
  }

  // Intentionally not routed through getCaptureGuardFailure: recapture identity
  // lives in state.recapture (sourceTabId/sourceWindowId/sourceUrl), which the
  // guard's recording-run fields cannot express, and this check is stricter
  // about an unreadable active-tab URL (it fails instead of passing).
  async function assertRecaptureCaptureContext(
    expectedControlVersion: number,
    runId: string,
    tabId: number,
    windowId: number,
    expectedUrl: string,
  ): Promise<void> {
    if (expectedControlVersion !== control.controlVersion) {
      throw new StaleCaptureError('Recapture control changed before the screenshot could be taken.');
    }
    const state = await getRecordingState();
    const [activeTab] = await browser.tabs.query({ active: true, windowId });
    if (
      expectedControlVersion !== control.controlVersion ||
      state.operation !== 'recapture' ||
      state.recapture?.runId !== runId ||
      state.recapture.sourceTabId !== tabId ||
      state.recapture.sourceWindowId !== windowId ||
      state.recapture.sourceUrl !== expectedUrl
    ) {
      throw new StaleCaptureError('Recapture changed before the screenshot could be taken.');
    }
    if (activeTab?.id !== tabId) throw new UserFacingError(t().recaptureFlow.sourceNotActive);
    if (activeTab.url !== expectedUrl) throw new UserFacingError(t().recaptureFlow.sourceChanged);
  }

  async function handleRecaptureTarget(
    message: HowbeamRecaptureTargetMessage,
    sender: Browser.runtime.MessageSender,
    expectedControlVersion: number,
  ): Promise<StepRecaptureTargetResult> {
    const reject = (status: 'rejected' | 'cancelled' | 'failed', error?: string): StepRecaptureTargetResult => ({
      ok: false,
      status,
      ...(error ? { error } : {}),
    });
    if (expectedControlVersion !== control.controlVersion) return reject('rejected');
    const state = await getRecordingState();
    const context = state.recapture;
    if (
      state.operation !== 'recapture' ||
      !context ||
      context.runId !== message.runId ||
      context.phase !== 'awaiting-target' ||
      !isRecaptureSourceSender(sender, context) ||
      message.url !== context.sourceUrl
    ) {
      return reject('rejected');
    }
    if (!control.acceptingClicks || settlement.activeCaptureId()) return reject('rejected');
    const claimed = await control.writeStateIf(
      expectedControlVersion,
      (current) =>
        current.operation === 'recapture' &&
        current.recapture?.runId === message.runId &&
        current.recapture.phase === 'awaiting-target',
      (current) => ({
        ...current,
        recapture: { ...current.recapture!, phase: 'capturing' },
      }),
    );
    if (!claimed) return reject('rejected');
    // Claim globals only after both sender and persisted context validation. An
    // old or forged content-script message must not consume the one-shot slot.
    control.acceptingClicks = false;
    settlement.trackCapture(message.captureId);

    try {
      const captured = await deps.captureScreenshotWithGuard(
        message,
        context.sourceTabId,
        context.sourceWindowId,
        () =>
          assertRecaptureCaptureContext(
            expectedControlVersion,
            message.runId,
            context.sourceTabId,
            context.sourceWindowId,
            context.sourceUrl,
          ),
      );
      assertCaptureNotCancelled(message.captureId);
      const current = await getRecordingState();
      if (
        expectedControlVersion !== control.controlVersion ||
        current.operation !== 'recapture' ||
        current.recapture?.runId !== message.runId ||
        current.recapture.phase !== 'capturing'
      ) {
        throw new StaleCaptureError('Recapture changed before the replacement transaction.');
      }

      // Synchronous commit marker: cancellation after this point waits for the
      // atomic IndexedDB replacement and reports the completed result.
      markCaptureCommitting(message.captureId);
      await replaceStepCaptureAtomically(
        context.sessionId,
        context.target,
        {
          screenshotBlob: captured.blob,
          bounds: message.rect,
          devicePixelRatio: message.devicePixelRatio,
          screenshotScale: captured.scale,
          url: message.url,
          timestamp: message.timestamp,
        },
        message.runId,
      );
      const version = control.bumpVersion();
      await settleStepRecapture(message.runId, 'replaced', version);
      return { ok: true, status: 'replaced' };
    } catch (error) {
      if (error instanceof StaleCaptureError) return reject('cancelled');
      const errorCode = error instanceof StepRecaptureError ? error.code : 'CAPTURE_FAILED';
      // The editor shows this text verbatim: localized copy only, never a raw
      // repository or browser diagnostic.
      const errorMessage =
        error instanceof StepRecaptureError
          ? recaptureTargetErrorMessage(error.code, context.target.kind)
          // 原本內容 (not 原內容) matches the editor's own recapture wording.
          : userFacingErrorMessage(error, t().recaptureFlow.failedUnchanged);
      console.error('[howbeam] failed to replace step capture', error);
      if (expectedControlVersion === control.controlVersion) {
        const version = control.bumpVersion();
        await settleStepRecapture(message.runId, 'failed', version, errorCode, errorMessage);
      }
      return reject('failed', errorMessage);
    } finally {
      releaseCapture(message.captureId);
      settlement.releaseCapture(message.captureId);
    }
  }

  return {
    /** Read by START_RECORDING and RESET_PROJECT: their single-owner check must
     * also cover a recapture start that has not published state yet. */
    isStartingRecapture: () => startingRecapture,
    preflightStepRecaptureSourcePermission,
    startStepRecapture,
    cancelStepRecapture,
    ackStepRecaptureResult,
    focusStepRecaptureSource,
    handleRecaptureReady,
    handleRecaptureTarget,
    handleSourceTabUpdated,
    handleSourceTabRemoved,
    failStepRecapture,
    recoverInterruptedRecapture: settlement.recoverInterrupted,
  };
}

export type RecaptureFlow = ReturnType<typeof createRecaptureFlow>;
