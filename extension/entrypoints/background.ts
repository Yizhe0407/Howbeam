import { browser, type Browser } from 'wxt/browser';
import { queueClick, queueLifecycle } from '@/lib/recording/background-queues';
import { openWelcomePage, opensWelcomeOnInstall } from '@/lib/runtime/welcome';
import { syncActionIconWithRecordingState } from '@/lib/recording/background/action-icon';
import { claimPendingStart } from '@/lib/runtime/pending-start';
import { clearCrossTabRecordingDecline } from '@/lib/runtime/cross-tab-recording';
import { claimRecordingProject } from '@/lib/project/project-actions';
import {
  isBackgroundMessage,
  isExtensionPageOnlyMessage,
  isTrustedExtensionPageSender,
  isTrustedKeepAliveSender,
} from '@/lib/runtime/background-message-validation';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import { createStepFrameRelayBroker } from '@/lib/recording/background/step-frame-relay-broker';
import { createRecaptureFlow } from '@/lib/recording/background/recapture-flow';
import { createFollowMode } from '@/lib/recording/background/follow-mode';
import { createRunState } from '@/lib/recording/background/run-state';
import { createRunControls } from '@/lib/recording/background/run-controls';
import { createRunEnding } from '@/lib/recording/background/run-ending';
import { createRunLifecycle } from '@/lib/recording/background/run-lifecycle';
import { createRecorderMessages } from '@/lib/recording/background/recorder-messages';
import { createUndoWindow } from '@/lib/recording/background/undo-window';
import { createRecordedTabUpdates } from '@/lib/recording/background/recorded-tab-updates';
import { createCaptureFlow } from '@/lib/recording/background/capture-flow';
import { createKeepAlivePortHandler } from '@/lib/runtime/keep-alive';
import { createEditorOpen } from '@/lib/recording/background/editor-open';
import {
  editorPlacementFor,
  forgetClosedExtensionPage,
  openLibraryPage,
  registerExtensionPage,
} from '@/lib/recording/background/extension-page-tabs';
import { t } from '@/lib/shared/i18n';
import { describeBrowserError } from '@/lib/runtime/browser-errors';
import { withMessageFailureFallback } from '@/lib/runtime/background-message-fallback';
import { getRecordingState } from '@/lib/storage/storage';
import type {
  BackgroundMessage,
  CancelStepRecaptureResult,
  ClickCaptureResult,
  FocusStepRecaptureSourceResult,
  OpenEditorResult,
  OpenLibraryResult,
  PreflightProjectContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  ResetProjectResult,
  RecordingControlResult,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepFrameRelayBeginResult,
  StepFrameRelayClaimResult,
  StepFrameRelayMutationResult,
  StepRecaptureTargetResult,
} from '@/lib/runtime/messages';
import type { RecordingState } from '@/lib/storage/recording-state';
import { initLocalePreference } from '@/lib/runtime/locale-preference';

const recorderRuntime = createRecorderRuntime({
  captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }),
  executeRecorderScript: (target) => browser.scripting.executeScript({
    target,
    files: ['/content-scripts/content.js'],
  }),
  sendStopMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
});
const undoWindow = createUndoWindow();

// 強制控制流程在第一個 await 前同步失效。
const control = createControlPlane({ discardPendingUndo: undoWindow.discard });

const editorOpen = createEditorOpen({ control });

const runState = createRunState({ control });

const followMode = createFollowMode({ control, runtime: recorderRuntime });

const runEnding = createRunEnding({ control, runtime: recorderRuntime, followMode });

const captureFlow = createCaptureFlow({
  control,
  runtime: recorderRuntime,
  runState,
  stopRunWithError: runEnding.stopRunWithError,
  handleRecordedTabGone: runEnding.handleRecordedTabGone,
  discardPendingUndo: undoWindow.discard,
});

// 步驟擷取與補拍共用取消及提交標記。
const recaptureFlow = createRecaptureFlow({
  control,
  runtime: recorderRuntime,
  captureScreenshotWithGuard: captureFlow.captureScreenshotWithGuard,
  openEditor: editorOpen.openEditor,
});

const runLifecycle = createRunLifecycle({
  control,
  runtime: recorderRuntime,
  runState,
  captureFlow,
  recaptureFlow,
  runEnding,
});

const recorderMessages = createRecorderMessages({ control, runState, runEnding });

const runControls = createRunControls({
  control,
  runtime: recorderRuntime,
  runState,
  undoWindow,
  captureFlow,
  editorOpen,
});

const recordedTabUpdates = createRecordedTabUpdates({
  control,
  runtime: recorderRuntime,
  runState,
  followMode,
  recaptureFlow,
  stopRunWithError: runEnding.stopRunWithError,
});

export default defineBackground(() => {
  // Error copy and step descriptions the worker produces follow the chosen
  // language. A worker woken by a click must not describe that step before the
  // stored preference is read, so startup recovery (which every click awaits)
  // waits for it too.
  const localeReady = initLocalePreference().catch((error: unknown) => {
    console.warn('[stepmark] failed to apply the language preference', error);
  });
  // Registered synchronously so the install event is never missed by a worker
  // still finishing its first run.
  browser.runtime.onInstalled.addListener((details) => {
    if (!opensWelcomeOnInstall(details)) return;
    openWelcomePage().catch((error: unknown) => {
      console.error('[stepmark] failed to open the welcome page', error);
    });
  });
  syncActionIconWithRecordingState();
  const stepFrameRelayBroker = createStepFrameRelayBroker({
    sendResult: async (tabId, frameId, message) => {
      await browser.tabs.sendMessage(tabId, message, { frameId });
    },
  });

  // A worker woken by a capture message from a stale persisted run (e.g. a
  // bfcache-restored recorder) must not race recovery: clicks queue behind it.
  const startupRecovery = (async () => {
    await localeReady;
    await recaptureFlow.recoverInterruptedRecapture();
    await runLifecycle.recoverInterruptedRecording();
  })().catch((error) => {
    console.error('[stepmark] failed to recover an interrupted operation', error);
  });

  const relaySender = (sender: Browser.runtime.MessageSender) => ({
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? null,
  });

  const isActiveStepRelaySender = async (
    runId: string,
    sender: Browser.runtime.MessageSender,
    expectedFrame: 'child' | 'top',
  ): Promise<boolean> => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId == null || frameId == null) return false;
    if (expectedFrame === 'child' ? frameId <= 0 : frameId !== 0) return false;
    if (!control.acceptingClicks) return false;
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    return (
      expectedControlVersion === control.controlVersion &&
      control.acceptingClicks &&
      state.operation === 'recording' &&
      state.isRecording &&
      state.mode === 'steps' &&
      state.phase === 'recording' &&
      state.runId === runId &&
      state.tabId === tabId
    );
  };

  /**
   * Routes a validated background message to its handler. Every case must
   * resolve (never reject) with that case's response, so the onMessage
   * listener can always close the channel with a well-formed result.
   */
  const routeBackgroundMessage = (
    message: BackgroundMessage,
    sender: Browser.runtime.MessageSender,
  ): Promise<unknown> => {
    switch (message.type) {
      case 'START_RECORDING':
        return withMessageFailureFallback(
          queueLifecycle(() => runLifecycle.startRecording(message, sender)),
          'start recording request failed',
          { ok: false, error: t().background.startServiceFailed } satisfies StartRecordingResult,
        );
      case 'PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION':
        return withMessageFailureFallback(
          recaptureFlow.preflightStepRecaptureSourcePermission(message, sender),
          'recapture source preflight failed',
          {
            ok: false,
            code: 'INVALID_EDITOR',
            message: t().background.recaptureServiceFailedReload,
          } satisfies PreflightStepRecaptureSourcePermissionResult,
        );
      case 'PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION':
        return withMessageFailureFallback(
          runLifecycle.preflightProjectContinuationSourcePermission(message, sender),
          'continuation source preflight failed',
          {
            ok: false,
            code: 'INVALID_EDITOR',
            message: t().background.continuationServiceFailed,
          } satisfies PreflightProjectContinuationSourcePermissionResult,
        );
      case 'START_STEP_RECAPTURE':
        return withMessageFailureFallback(
          recaptureFlow.startStepRecapture(message, sender),
          'start recapture request failed',
          {
            ok: false,
            code: 'INJECTION_FAILED',
            error: t().background.recaptureServiceFailed,
          } satisfies StartStepRecaptureResult,
        );
      case 'CANCEL_STEP_RECAPTURE':
        return withMessageFailureFallback(
          recaptureFlow.cancelStepRecapture(message, sender),
          'cancel recapture request failed',
          { ok: false, error: t().background.recaptureCancelFailed } satisfies CancelStepRecaptureResult,
        );
      case 'ACK_STEP_RECAPTURE_RESULT':
        return withMessageFailureFallback(
          recaptureFlow.ackStepRecaptureResult(message, sender),
          'recapture result ack failed',
          false,
        );
      case 'FOCUS_STEP_RECAPTURE_SOURCE':
        return withMessageFailureFallback(
          recaptureFlow.focusStepRecaptureSource(message, sender),
          'focus recapture source failed',
          { ok: false, error: t().background.recaptureTabSwitchFailed } satisfies FocusStepRecaptureSourceResult,
        );
      case 'STOP_RECORDING':
        // Currently exercised only by the e2e harness; product surfaces end a
        // run through FINISH_RECORDING or DISCARD_CURRENT_RECORDING.
        return withMessageFailureFallback(
          queueLifecycle(() => runLifecycle.stopRecording()),
          'stop recording request failed',
          undefined,
        );
      case 'RESET_PROJECT':
        return withMessageFailureFallback(
          queueLifecycle(() => runLifecycle.resetProjectLifecycle(message)),
          'reset project request failed',
          { ok: false, error: t().background.resetFailed } satisfies ResetProjectResult,
        );
      case 'OPEN_EDITOR':
        return withMessageFailureFallback(
          editorOpen.openEditorForStoredSession(message, editorPlacementFor(message, sender)),
          'open editor request failed',
          { ok: false, error: t().runtime.editorOpenFailed } satisfies OpenEditorResult,
        );
      case 'OPEN_LIBRARY':
        return withMessageFailureFallback(
          openLibraryPage(),
          'open library request failed',
          { ok: false, error: t().nav.libraryOpenFailed } satisfies OpenLibraryResult,
        );
      case 'REGISTER_EXTENSION_PAGE':
        return withMessageFailureFallback(
          registerExtensionPage(sender),
          'extension page registration failed',
          false,
        );
      case 'PAUSE_RECORDING':
      case 'RESUME_RECORDING':
      case 'UNDO_LAST_CAPTURE':
      case 'RESTORE_LAST_CAPTURE':
      case 'PREPARE_NEXT_SNAPSHOT':
      case 'CREATE_NEXT_SNAPSHOT':
      case 'REBUILD_INVALIDATED_SNAPSHOT':
      case 'SWITCH_TO_SNAPSHOT_MODE':
      case 'SWITCH_TO_STEPS_MODE':
      case 'DISCARD_CURRENT_RECORDING':
      case 'FINISH_RECORDING':
        return withMessageFailureFallback(
          runControls.handleRecordingControl(message, sender),
          'recording toolbar request failed',
          { ok: false, error: t().background.recordingServiceFailed } satisfies RecordingControlResult,
        );
      case 'SNAPSHOT_INVALIDATED':
        return withMessageFailureFallback(
          recorderMessages.handleSnapshotInvalidated(message, sender),
          'snapshot invalidation handling failed',
          false,
        );
      case 'SNAPSHOT_RECORDER_FAILED':
        return withMessageFailureFallback(
          recorderMessages.handleSnapshotRecorderFailure(message, sender),
          'snapshot recorder failure recovery failed',
          false,
        );
      case 'STEPMARK_RECAPTURE_TARGET':
        return withMessageFailureFallback(
          (async () => {
            // The recorder listens before its startup finishes; a click in between waits for it.
            if (control.startupSettled) await control.startupSettled;
            if (!control.acceptingClicks) return { ok: false, status: 'rejected' } satisfies StepRecaptureTargetResult;
            const expectedControlVersion = control.controlVersion;
            return queueClick(async () => {
              await startupRecovery;
              return recaptureFlow.handleRecaptureTarget(message, sender, expectedControlVersion);
            });
          })(),
          'recapture target handling failed',
          { ok: false, status: 'failed' } satisfies StepRecaptureTargetResult,
        );
      case 'STEPMARK_STEP_FRAME_BEGIN':
        return withMessageFailureFallback(
          (async () => {
            await startupRecovery;
            if (!(await isActiveStepRelaySender(message.runId, sender, 'child'))) return { ok: false };
            return stepFrameRelayBroker.begin(message, relaySender(sender));
          })(),
          'child-frame relay authorization failed',
          { ok: false } satisfies StepFrameRelayBeginResult,
        );
      case 'STEPMARK_STEP_FRAME_CLAIM':
        return withMessageFailureFallback(
          (async () => {
            await startupRecovery;
            if (!(await isActiveStepRelaySender(message.runId, sender, 'top'))) return { ok: false };
            return stepFrameRelayBroker.claim(message, relaySender(sender));
          })(),
          'child-frame relay claim failed',
          { ok: false } satisfies StepFrameRelayClaimResult,
        );
      case 'STEPMARK_STEP_FRAME_REJECT':
        return withMessageFailureFallback(
          stepFrameRelayBroker.reject(message, relaySender(sender)),
          'child-frame relay rejection failed',
          { ok: false } satisfies StepFrameRelayMutationResult,
        );
      case 'STEPMARK_STEP_FRAME_SETTLE':
        return withMessageFailureFallback(
          stepFrameRelayBroker.settle(message, relaySender(sender)),
          'child-frame relay settlement failed',
          { ok: false } satisfies StepFrameRelayMutationResult,
        );
      case 'STEPMARK_STEP_FRAME_ABORT':
        return Promise.resolve(stepFrameRelayBroker.abort(message, relaySender(sender)));
      case 'STEPMARK_CLICK':
        return withMessageFailureFallback(
          (async () => {
            if (control.startupSettled) await control.startupSettled;
            if (!control.acceptingClicks) return { ok: false, error: 'not-accepting-clicks' } satisfies ClickCaptureResult;
            const expectedControlVersion = control.controlVersion;
            return queueClick(async () => {
              // Version read before recovery: if this message woke the worker over a
              // stale persisted run, recovery settles it and the bumped version rejects silently.
              await startupRecovery;
              return captureFlow.handleClick(message, sender, expectedControlVersion);
            });
          })(),
          'capture request failed',
          { ok: false, error: 'capture-request-failed' } satisfies ClickCaptureResult,
        );
      case 'STEPMARK_CANCEL_CAPTURE':
        return withMessageFailureFallback(
          recorderMessages.handleCancelCapture(message, sender),
          'capture cancellation failed',
          { ok: false, error: 'capture-cancellation-failed' } satisfies ClickCaptureResult,
        );
      case 'STEPMARK_READY':
        return withMessageFailureFallback(
          recorderMessages.handleRecorderReady(message, sender),
          'recorder ready handling failed',
          false,
        );
      case 'STEPMARK_RECAPTURE_READY':
        return withMessageFailureFallback(
          recaptureFlow.handleRecaptureReady(message, sender),
          'recapture ready handling failed',
          false,
        );
    }
  };

  // Chrome 仍無法可靠支援 onMessage 的 Promise 回覆（crbug.com/40753031）。
  // 回傳 true 並只呼叫一次 sendResponse；格式錯誤或不可信訊息刻意不回覆。
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isBackgroundMessage(message)) return undefined;
    if (
      isExtensionPageOnlyMessage(message) &&
      !isTrustedExtensionPageSender(sender, browser.runtime.getURL('/'))
    ) {
      console.warn('[stepmark] rejected an untrusted extension control message', message.type);
      return undefined;
    }
    void routeBackgroundMessage(message, sender).then(sendResponse, (error) => {
      console.error(
        '[stepmark] background message handling failed unexpectedly:',
        describeBrowserError(error),
        error,
      );
      sendResponse(undefined);
    });
    return true;
  });

  browser.permissions?.onAdded?.addListener((permissions) => {
    if (!permissions.origins?.includes('<all_urls>')) return;
    void recordedTabUpdates.resumeRunWaitingForSiteAccess().catch((error) => {
      console.error('[stepmark] failed to resume the recording after the permission grant', error);
    });
    void (async () => {
      const pending = await claimPendingStart();
      if (!pending) return;
      await clearCrossTabRecordingDecline();
      const tab = await browser.tabs.get(pending.tabId);
      const claim = await claimRecordingProject(pending.projectId);
      const result = await queueLifecycle(() =>
        runLifecycle.startRecording(
          {
            type: 'START_RECORDING',
            sessionId: claim.project.id,
            mode: pending.mode,
            ...(claim.autoCreated ? { autoCreatedProject: true } : {}),
          },
          {},
          tab,
        ),
      );
      if (!result.ok) {
        console.warn('[stepmark] resumed start failed', result.error);
        const live = await getRecordingState();
        if (!(live.isRecording && live.sessionId === claim.project.id)) await claim.release();
      }
    })().catch((error) => {
      console.error('[stepmark] failed to resume the start after the permission grant', error);
    });
  });

  browser.commands?.onCommand.addListener((command) => {
    void runControls.handleCommandShortcut(command).catch((error) => {
      console.error('[stepmark] failed to handle command shortcut', error);
    });
  });

  const handleKeepAlivePort = createKeepAlivePortHandler({
    getRecordingState,
    isTrustedKeepAliveSender: (sender: Browser.runtime.MessageSender | undefined, state: RecordingState) =>
      isTrustedKeepAliveSender(sender ?? {}, state, control.followOriginTabId),
    acknowledgeDisconnect: () => void browser.runtime.lastError,
  });
  browser.runtime.onConnect.addListener(handleKeepAlivePort);

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void recordedTabUpdates.handleTabUpdated(tabId, changeInfo, tab).catch((error) => {
      console.error('[stepmark] failed to handle recorded tab update', error);
    });
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    followMode.scheduleRecordingFollow(tabId);
  });

  // Cross-window switches raise no tabs.onActivated; follow the newly focused
  // window's active tab instead. WINDOW_ID_NONE (-1) means focus left Chrome.
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return;
    void browser.tabs.query({ active: true, windowId }).then(([tab]) => {
      if (tab?.id != null) followMode.scheduleRecordingFollow(tab.id);
    }).catch((error) => {
      console.warn('[stepmark] failed to inspect the focused window', error);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      // Unconditionally first: a closed extension page must stop being the tab
      // that later opens reuse, whatever else this removal means.
      await forgetClosedExtensionPage(tabId);
      if (await recaptureFlow.handleSourceTabRemoved(tabId)) return;
      await runEnding.handleRecordedTabGone(tabId);
    })().catch((error) => {
      console.error('[stepmark] failed to handle recorded tab removal', error);
    });
  });

  // Through the click queue so rehydration is ordered before any queued
  // restore/undo message this startup is already receiving.
  void queueClick(undoWindow.recover).catch((error) => {
    console.error('[stepmark] failed to recover the undo window', error);
  });
});
