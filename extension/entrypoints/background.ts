import { browser, type Browser } from 'wxt/browser';
import { queueClick, queueLifecycle, waitForQueuedClicks } from '@/lib/recording/background-queues';
import { isRecordableTabUrl } from '@/lib/shared/restricted-urls';
import { openWelcomePage, opensWelcomeOnInstall } from '@/lib/runtime/welcome';
import { syncActionIconWithRecordingState } from '@/lib/recording/background/action-icon';
import { focusTab } from '@/lib/runtime/navigation';
import { claimPendingStart } from '@/lib/runtime/pending-start';
import { clearCrossTabRecordingDecline } from '@/lib/runtime/cross-tab-recording';
import { claimRecordingProject } from '@/lib/project/project-actions';
import {
  isBackgroundMessage,
  isExtensionPageOnlyMessage,
  isTrustedExtensionPageSender,
  isTrustedKeepAliveSender,
  isTrustedRecorderControlSender,
} from '@/lib/runtime/background-message-validation';
import { getStep } from '@/lib/storage/step-repository';
import { getProject, resetProject } from '@/lib/storage/project-repository';
import { isValidSnapshotViewportContext } from '@/lib/recording/recording-guards';
import { createControlPlane } from '@/lib/recording/background/control-plane';
import { cancelCapture } from '@/lib/recording/background/capture-registry';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import { createStepFrameRelayBroker } from '@/lib/recording/background/step-frame-relay-broker';
import { createRecaptureFlow } from '@/lib/recording/background/recapture-flow';
import { createFollowMode } from '@/lib/recording/background/follow-mode';
import { createRunState } from '@/lib/recording/background/run-state';
import { createRunControls } from '@/lib/recording/background/run-controls';
import { createUndoWindow } from '@/lib/recording/background/undo-window';
import {
  deleteEmptySnapshotAnchorBestEffort,
  reclaimAbandonedAutoCreatedProject,
} from '@/lib/recording/background/run-cleanup';
import { createRecordedTabUpdates } from '@/lib/recording/background/recorded-tab-updates';
import { createCaptureFlow, snapshotAnchorMissingError } from '@/lib/recording/background/capture-flow';
import {
  markRecordingWait,
  unrecordableReason,
  type RecordingWaitReason,
} from '@/lib/recording/background/recording-wait';
import {
  isEditorSenderForSession,
  resolveContinuationTab,
  resolveProjectContinuationAnchor,
  sourcePermissionPreflightSuccess,
} from '@/lib/recording/background/source-tab';
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
import { getRecordingState, resetRunStateToIdle } from '@/lib/storage/storage';
import { recordedTabClosedError } from '@/lib/recording/recording-recovery';
import type {
  BackgroundMessage,
  CancelStepRecaptureResult,
  ClickCaptureResult,
  FocusStepRecaptureSourceResult,
  OpenEditorResult,
  OpenLibraryResult,
  PreflightProjectContinuationSourcePermissionErrorCode,
  PreflightProjectContinuationSourcePermissionMessage,
  PreflightProjectContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  ResetProjectMessage,
  ResetProjectResult,
  RecordingControlResult,
  SnapshotInvalidatedMessage,
  SnapshotRecorderFailureMessage,
  StartRecordingMessage,
  StartRecordingResult,
  StartStepRecaptureResult,
  StepFrameRelayBeginResult,
  StepFrameRelayClaimResult,
  StepFrameRelayMutationResult,
  StepRecaptureTargetResult,
} from '@/lib/runtime/messages';
import type { RecordingState, RecoverableRecordingError } from '@/lib/storage/recording-state';
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

const captureFlow = createCaptureFlow({
  control,
  runtime: recorderRuntime,
  runState,
  stopRunWithError,
  handleRecordedTabGone,
  discardPendingUndo: undoWindow.discard,
});

// 步驟擷取與補拍共用取消及提交標記。
const recaptureFlow = createRecaptureFlow({
  control,
  runtime: recorderRuntime,
  captureScreenshotWithGuard: captureFlow.captureScreenshotWithGuard,
  openEditor: editorOpen.openEditor,
});

const followMode = createFollowMode({ control, runtime: recorderRuntime });

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
  stopRunWithError,
});

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

function continuationPreflightFailure(
  code: PreflightProjectContinuationSourcePermissionErrorCode,
  message: string,
): PreflightProjectContinuationSourcePermissionResult {
  return { ok: false, code, message };
}

async function preflightProjectContinuationSourcePermission(
  message: PreflightProjectContinuationSourcePermissionMessage,
  sender: Browser.runtime.MessageSender,
): Promise<PreflightProjectContinuationSourcePermissionResult> {
  if (
    typeof message.sessionId !== 'string' ||
    message.sessionId.trim().length === 0 ||
    !isEditorSenderForSession(sender, message.sessionId)
  ) {
    return continuationPreflightFailure('INVALID_EDITOR', t().background.editorOnlyContinuation);
  }
  const anchor = await resolveProjectContinuationAnchor(message.sessionId, message.afterEntryId);
  const sourceUrl = anchor?.sourceUrl;
  if (!sourceUrl) {
    return continuationPreflightFailure('SOURCE_NOT_FOUND', t().background.noContinuationSource);
  }
  return (
    sourcePermissionPreflightSuccess(sourceUrl) ??
    continuationPreflightFailure('RESTRICTED_SOURCE', t().background.restrictedContinuationSource)
  );
}

/**
 * MV3 worker 重啟會保留流程，但瀏覽器重啟可能重用 tab id。
 * 結束無法再驗證 tab 身分的流程，同時保留已擷取內容。
 */
async function recoverInterruptedRecording(): Promise<void> {
  const state = await getRecordingState();
  if (state.operation !== 'recording' || !state.isRecording || !state.runId) return;
  const expectedControlVersion = control.controlVersion;
  const assessment = await assessInterruptedRecording(state);
  if (assessment.kind === 'intact') return;
  if (assessment.kind === 'tab-missing' && state.tabId != null) {
    // Same path as a live tabs.onRemoved (which may be the very event that woke
    // this worker): the run can still continue in another tab. Not awaited —
    // clicks wait for this recovery, and the lifecycle queue can wait for clicks.
    void handleRecordedTabGone(state.tabId).catch((error) => {
      console.error('[stepmark] failed to settle the recording whose tab is gone', error);
    });
    return;
  }
  if (assessment.kind === 'unrecordable') {
    // The worker idled out while the run waited in a page it cannot record
    // (no recorder there keeps it alive): keep waiting, never end the run.
    await runState.updateRunState(
      state.runId,
      (current) => markRecordingWait(current, assessment.reason),
      expectedControlVersion,
    );
    return;
  }
  const recoverableError = assessment.kind === 'anchor-missing'
    ? snapshotAnchorMissingError()
    : recordedTabClosedError();
  await stopRunWithError(
    state.runId,
    recoverableError.message,
    expectedControlVersion,
    recoverableError,
  );
}

type InterruptedRecordingAssessment =
  | { kind: 'intact' | 'tab-missing' | 'tab-gone' | 'anchor-missing' }
  | { kind: 'unrecordable'; reason: RecordingWaitReason };

async function assessInterruptedRecording(state: RecordingState): Promise<InterruptedRecordingAssessment> {
  if (state.tabId == null) return { kind: 'tab-gone' };
  let tab: Browser.tabs.Tab;
  try {
    tab = await browser.tabs.get(state.tabId);
  } catch {
    return { kind: 'tab-missing' };
  }
  if (state.mode === 'steps') {
    // 步驟模式允許導頁；停在無法錄製的頁面時只是等待，回到一般網頁即繼續。
    const reason = await unrecordableReason(tab.url);
    return reason ? { kind: 'unrecordable', reason } : { kind: 'intact' };
  }
  if (!isRecordableTabUrl(tab.url)) return { kind: 'tab-gone' };
  // 恢復的快照流程必須先有持久化底圖，才能接受點擊。
  const acceptsAnnotations = state.phase === 'recording' || state.phase === 'finishing';
  if (acceptsAnnotations && !state.groupAnchorId) return { kind: 'anchor-missing' };
  if (state.groupAnchorId) {
    const anchor = await getStep(state.groupAnchorId);
    if (acceptsAnnotations && !anchor?.screenshotBlob) return { kind: 'anchor-missing' };
    // Snapshot coordinates belong to one immutable document; a restart that
    // left the tab on any other URL invalidates every further annotation.
    if (anchor && tab.url !== anchor.url) return { kind: 'tab-gone' };
  }
  return { kind: 'intact' };
}

/** 新流程預設編號；每次擷取都持久化當下的顯示設定。 */
const RUN_STARTS_NUMBERED = true;

/** 寫入不受版本影響的共用啟動失敗狀態。 */
function startFailureState(
  current: RecordingState,
  mode: StartRecordingMessage['mode'],
  code: string,
  message: string,
): RecordingState {
  return {
    ...current,
    operation: null,
    isRecording: false,
    phase: 'error',
    tabId: null,
    error: message,
    recoverableError: { code, message },
    mode,
    itemCount: 0,
    numbered: RUN_STARTS_NUMBERED,
    groupAnchorId: null,
    runId: null,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
  };
}

async function startRecording(
  message: StartRecordingMessage,
  sender: Browser.runtime.MessageSender,
  targetTab: Browser.tabs.Tab | null = null,
): Promise<StartRecordingResult> {
  const current = await getRecordingState();
  // A global capture operation remains single-owner. Never let a second start
  // invalidate another Project's recording or one-shot replacement.
  if (current.operation !== null || current.isRecording || recaptureFlow.isStartingRecapture()) {
    return { ok: false, error: t().recaptureFlow.activeOperation };
  }
  const targetProject = await getProject(message.sessionId);
  if (!targetProject) return { ok: false, error: t().background.recordTargetMissing };

  let continuationTab: Browser.tabs.Tab | null = targetTab;
  if (message.continuation) {
    const resolved = await resolveContinuationTab(message, sender);
    if (!resolved.ok) return resolved;
    continuationTab = resolved.tab;
  }

  const version = control.claimControl({
    cancelRecorderGate: true,
    clearSnapshotContext: true,
    discardUndo: true,
  });
  await handleStartRecording(message, version, continuationTab);
  const started = await getRecordingState();
  if (
    version === control.controlVersion &&
    started.operation === 'recording' &&
    started.isRecording &&
    started.sessionId === message.sessionId &&
    started.runId
  ) {
    return { ok: true, sessionId: message.sessionId, runId: started.runId };
  }
  return { ok: false, error: started.recoverableError?.message ?? started.error ?? t().background.cannotStartHere };
}

async function handleStartRecording(
  message: StartRecordingMessage,
  version: number,
  continuationTab: Browser.tabs.Tab | null = null,
): Promise<void> {
  // Reset waits for all writes from the old run through STOP. START uses the
  // same barrier so an old capture cannot append to the reused session later.
  await waitForQueuedClicks();
  if (version !== control.controlVersion) return;

  const prevState = await getRecordingState();
  const tab = continuationTab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (version !== control.controlVersion) return;

  await recorderRuntime.stopRecorderInTab(prevState.tabId);
  if (version !== control.controlVersion) return;
  if (!tab?.id) {
    await control.writeStateForControl(version, (current) =>
      startFailureState(current, message.mode, 'NO_ACTIVE_TAB', t().background.noActiveTab));
    return;
  }

  if (!isRecordableTabUrl(tab.url)) {
    await control.writeStateForControl(version, (current) =>
      startFailureState(current, message.mode, 'RESTRICTED_PAGE', t().background.restrictedBrowserPage));
    return;
  }

  // Captures read the visible viewport, so a resumed source tab must reach the
  // foreground before the recorder is injected, not after the run is live.
  if (continuationTab) {
    try {
      await focusTab(tab.id!, tab.windowId);
    } catch (error) {
      console.error('[stepmark] failed to focus the continuation source tab', error);
      await control.writeStateForControl(version, (current) =>
        startFailureState(current, message.mode, 'SOURCE_TAB_FAILED', t().background.sourceTabSwitchFailed));
      return;
    }
    if (version !== control.controlVersion) return;
  }

  const runId = crypto.randomUUID();
  // Shown in the in-page toolbar only when the run appends to an existing Project.
  const targetProject = message.autoCreatedProject === true ? null : await getProject(message.sessionId);
  if (version !== control.controlVersion) return;
  const targetProjectTitle = targetProject
    ? (targetProject.title.trim() || t().common.untitledProject).slice(0, 120)
    : null;
  const insertAfterStepId = message.insertAfterEntryId === undefined
    ? null
    : (await resolveProjectContinuationAnchor(message.sessionId, message.insertAfterEntryId))?.afterStepId ?? null;
  if (version !== control.controlVersion) return;
  const startedState = await control.writeStateForControl(version, (current) => ({
    operation: 'recording',
    isRecording: true,
    phase: 'starting',
    sessionId: message.sessionId,
    tabId: tab.id!,
    error: null,
    recoverableError: null,
    mode: message.mode,
    itemCount: 0,
    lastCommittedCaptureId: null,
    numbered: RUN_STARTS_NUMBERED,
    groupAnchorId: null,
    runId,
    // Durable (not module state): a MV3 service-worker restart mid-run must
    // not forget that this run's Project is reclaimable when it ends empty.
    autoCreatedProjectId: message.autoCreatedProject === true ? message.sessionId : null,
    targetProjectTitle,
    insertAfterStepId,
    snapshotViewport: null,
    snapshotDevicePixelRatio: null,
    recapture: null,
    recaptureResult: current.recaptureResult,
  }));
  if (!startedState) return;
  if (startedState.sessionId !== message.sessionId) return;
  if (version !== control.controlVersion) return;

  let startupAnchorId: string | null = null;
  try {
    await control.withRecorderReadyGate({
      slot: 'pendingRecorderReady',
      identity: { runId, tabId: tab.id, controlVersion: version },
      // Both modes instrument every accessible frame: snapshot for its child-frame
      // probes, steps so iframe clicks are relayed instead of silently lost.
      inject: () => recorderRuntime.injectRecorder(tab.id!, true),
      notReadyError: () => new Error('Recorder did not become ready before the startup timeout.'),
      ready: async () => {
        if (version !== control.controlVersion) return;
        if (message.mode === 'snapshot') {
          const context = control.pendingSnapshotContext;
          if (!context) throw new Error('Snapshot recorder did not provide its capture context.');
          if (!startedState.sessionId || tab.windowId == null) throw new Error('Snapshot capture context is incomplete.');
          startupAnchorId = await captureFlow.createAndActivateSnapshotAnchor(
            startedState,
            tab.id!,
            tab.windowId,
            context,
            version,
          );
        }
        await runState.updateRunState(
          runId,
          (current) => ({ ...current, phase: 'recording', error: null, recoverableError: null }),
          version,
        );
        const current = await getRecordingState();
        control.acceptingClicks = current.isRecording && current.runId === runId;
        startupAnchorId = null;
      },
    });
  } catch (err) {
    console.error('[stepmark] failed to inject recorder:', describeBrowserError(err), err);
    // The anchor was already published to the run state, so it must be
    // withdrawn before its row can go.
    if (startupAnchorId) await captureFlow.withdrawAnchorThenDelete(runId, startupAnchorId, version, true);
    if (version !== control.controlVersion) return;
    try {
      await stopRunWithError(runId, t().background.injectFailed, version);
    } catch (recoveryError) {
      control.acceptingClicks = false;
      console.error(
        '[stepmark] failed to persist recording startup failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
  }
}

async function stopRecording(): Promise<void> {
  const current = await getRecordingState();
  if (current.operation !== 'recording' || !current.isRecording) return;
  const version = control.claimControl({
    cancelRecorderGate: true,
    clearSnapshotContext: true,
    discardUndo: true,
  });
  return handleStopRecording(version);
}

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

async function handleStopRecording(version: number): Promise<void> {
  await waitForQueuedClicks();
  if (version !== control.controlVersion) return;
  const current = await getRecordingState();
  if (version !== control.controlVersion) return;
  // Unlike FINISH, STOP keeps any already-surfaced error text visible.
  const state = await control.writeStateForControl(version, (latest) => ({
    ...resetRunStateToIdle(latest),
    error: latest.error,
    recoverableError: latest.recoverableError,
  }));
  if (!state) return;
  // Only after the stop won: deleting first left a live run pointing at a
  // deleted anchor whenever the state write lost to a concurrent control.
  await deleteEmptySnapshotAnchorBestEffort(current);
  await recorderRuntime.stopRecorderInTab(current.tabId);
  // After the anchor cleanup so a zero-annotation snapshot run counts as empty.
  await reclaimAbandonedAutoCreatedProject(current);
}

async function resetProjectLifecycle(message: ResetProjectMessage): Promise<ResetProjectResult> {
  const initial = await getRecordingState();
  if (initial.operation !== null || initial.isRecording || recaptureFlow.isStartingRecapture()) {
    return { ok: false, error: t().background.resetDuringOperation };
  }
  const project = await getProject(message.sessionId);
  if (!project) return { ok: false, error: t().runtime.resetTargetMissing };

  // Invalidate any in-memory work first, then wait for all already-queued DB
  // writes. Persisted run/session guards remain authoritative after restarts.
  const version = control.claimControl({ cancelRecorderGate: true, discardUndo: true });
  await waitForQueuedClicks();
  const current = await getRecordingState();
  if (version !== control.controlVersion || current.operation !== null || current.isRecording) {
    return { ok: false, error: t().background.resetStateChanged };
  }
  try {
    const updated = await resetProject(message.sessionId);
    if (current.sessionId === message.sessionId) {
      // resetRunStateToIdle also nulls autoCreatedProjectId; with operation already
      // null, the field reads as null through state normalization either way.
      await control.writeStateForControl(version, (latest) => latest.sessionId === message.sessionId
        ? resetRunStateToIdle(latest)
        : latest);
    }
    return { ok: true, contentRevision: updated.contentRevision };
  } catch (error) {
    console.error('[stepmark] failed to reset Project', error);
    return { ok: false, error: t().background.resetFailedReload };
  }
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
    await recoverInterruptedRecording();
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
          queueLifecycle(() => startRecording(message, sender)),
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
          preflightProjectContinuationSourcePermission(message, sender),
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
          queueLifecycle(() => stopRecording()),
          'stop recording request failed',
          undefined,
        );
      case 'RESET_PROJECT':
        return withMessageFailureFallback(
          queueLifecycle(() => resetProjectLifecycle(message)),
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
          handleSnapshotInvalidated(message, sender),
          'snapshot invalidation handling failed',
          false,
        );
      case 'SNAPSHOT_RECORDER_FAILED':
        return withMessageFailureFallback(
          handleSnapshotRecorderFailure(message, sender),
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
          handleCancelCapture(message, sender),
          'capture cancellation failed',
          { ok: false, error: 'capture-cancellation-failed' } satisfies ClickCaptureResult,
        );
      case 'STEPMARK_READY':
        return withMessageFailureFallback(
          handleRecorderReady(message, sender),
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
        startRecording(
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
      await handleRecordedTabGone(tabId);
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
