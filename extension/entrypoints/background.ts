import { browser, type Browser } from 'wxt/browser';
import {
  StaleCaptureError,
  queueCapture,
  queueClick,
  queueLifecycle,
  queueStateMutation,
  waitForQueuedClicks,
} from '@/lib/recording/background-queues';
import { generateActionDescription } from '@/lib/capture/action-description';
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
  type RuntimeMessageSenderLike,
} from '@/lib/runtime/background-message-validation';
import {
  CAPTURE_PRESENTATION_CSS,
  waitForCapturePresentationPaint,
  withCapturePresentation,
} from '@/lib/capture/capture-presentation';
import { addStepsAfter, deleteStep, deleteStepsForRun, getStep, getSteps } from '@/lib/storage/step-repository';
import { getProject, resetProject } from '@/lib/storage/project-repository';
import { stepRole, type Step } from '@/lib/storage/models';
import {
  getCaptureGuardFailure,
  getRecordingTabUpdateAction,
  isMatchingSnapshotViewport,
  isTrustedRecordedPageSender,
  isValidSnapshotViewportContext,
} from '@/lib/recording/recording-guards';
import { discardPristineProject } from '@/lib/storage/project-repository';
import {
  createControlPlane,
  type SnapshotCaptureContext,
} from '@/lib/recording/background/control-plane';
import {
  assertCaptureNotCancelled,
  cancelCapture,
  markCaptureCommitting,
  releaseCapture,
} from '@/lib/recording/background/capture-registry';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import { createStepFrameRelayBroker } from '@/lib/recording/background/step-frame-relay-broker';
import { createRecaptureFlow } from '@/lib/recording/background/recapture-flow';
import { createFollowMode } from '@/lib/recording/background/follow-mode';
import {
  clearRecordingWait,
  isRecordingWaitError,
  isWaitingForSiteAccess,
  markRecordingWait,
  recordingWaitError,
  unrecordableReason,
  type RecordingWaitReason,
} from '@/lib/recording/background/recording-wait';
import {
  isEditorSenderForSession,
  resolveContinuationTab,
  resolveProjectContinuationAnchor,
  sourcePermissionPreflightSuccess,
} from '@/lib/recording/background/source-tab';
import {
  clearPendingUndoRecord,
  readPendingUndoRecord,
  savePendingUndoRecord,
  type PendingUndoRecord,
} from '@/lib/recording/background/pending-undo-store';
import { createKeepAlivePortHandler } from '@/lib/runtime/keep-alive';
import { createEditorOpen } from '@/lib/recording/background/editor-open';
import {
  editorPlacementFor,
  forgetClosedExtensionPage,
  openLibraryPage,
  registerExtensionPage,
} from '@/lib/recording/background/extension-page-tabs';
import { t } from '@/lib/shared/i18n';
import { describeBrowserError, isErrorPageError, isMissingTabError } from '@/lib/runtime/browser-errors';
import { UserFacingError, userFacingErrorMessage } from '@/lib/runtime/user-facing-errors';
import { withMessageFailureFallback } from '@/lib/runtime/background-message-fallback';
import { getRecordingState, resetRunStateToIdle, setRecordingState } from '@/lib/storage/storage';
import { markEditorOpenFailed, recordedTabClosedError } from '@/lib/recording/recording-recovery';
import type {
  BackgroundMessage,
  CancelStepRecaptureResult,
  ClickCapture,
  ClickCaptureResult,
  FinishResult,
  FocusStepRecaptureSourceResult,
  StepmarkSnapshotActiveMessage,
  OpenEditorResult,
  OpenLibraryResult,
  PreflightProjectContinuationSourcePermissionErrorCode,
  PreflightProjectContinuationSourcePermissionMessage,
  PreflightProjectContinuationSourcePermissionResult,
  PreflightStepRecaptureSourcePermissionResult,
  ResetProjectMessage,
  ResetProjectResult,
  RecordingControlMessage,
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
import { UNDO_WINDOW_MS, type RecordingState, type RecoverableRecordingError } from '@/lib/storage/recording-state';
import { initLocalePreference } from '@/lib/runtime/locale-preference';

/** 標示 anchor viewport 不符，讓整個快照流程失效。 */
class SnapshotViewportChangedError extends Error {}
/** 結束 anchor 已無法接受標註的快照流程。 */
function snapshotAnchorMissingError(): RecoverableRecordingError {
  return { code: 'SNAPSHOT_ANCHOR_MISSING', message: t().background.snapshotAnchorLost };
}

/** 標示 anchor 圖片遺失，讓流程結束而非持續重試。 */
class SnapshotAnchorMissingError extends Error {}
const recorderRuntime = createRecorderRuntime({
  captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }),
  executeRecorderScript: (target) => browser.scripting.executeScript({
    target,
    files: ['/content-scripts/content.js'],
  }),
  sendStopMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
});
let pendingUndo: PendingUndoRecord | null = null;

// 強制控制流程在第一個 await 前同步失效。
const control = createControlPlane({ discardPendingUndo });

const editorOpen = createEditorOpen({ control });

// 步驟擷取與補拍共用取消及提交標記。
const recaptureFlow = createRecaptureFlow({
  control,
  runtime: recorderRuntime,
  captureScreenshotWithGuard,
  openEditor: editorOpen.openEditor,
});

const followMode = createFollowMode({ control, runtime: recorderRuntime });

/** 同步使復原失效，再刪除持久化的截圖副本。 */
function discardPendingUndo(): void {
  pendingUndo = null;
  void clearPendingUndoRecord().catch((error) => {
    console.warn('[stepmark] failed to clear the persisted undo record', error);
  });
}

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

async function setRunError(runId: string, error: string): Promise<void> {
  await updateRunState(runId, (current) => ({
    ...current,
    error,
    recoverableError: { code: 'CAPTURE_FAILED', message: error },
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
        message: t().background.snapshotViewportChanged,
      },
    });
    return true;
  });
}

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

async function assertCaptureContext(
  expectedControlVersion: number,
  runId: string,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedUrl: string,
): Promise<void> {
  if (expectedControlVersion !== control.controlVersion) {
    throw new StaleCaptureError('Recording control changed before the screenshot could be taken.');
  }
  const state = await getRecordingState();
  const [activeTab] = await browser.tabs.query({ active: true, windowId });
  const failure = getCaptureGuardFailure({
    expectedControlVersion,
    currentControlVersion: control.controlVersion,
    runId,
    sessionId,
    tabId,
    expectedUrl,
    state,
    activeTab,
  });
  if (failure === 'stale-run') throw new StaleCaptureError('Recording changed before the screenshot could be taken.');
  // These two surface to the user through setRunError, so they are localized.
  if (failure === 'inactive-tab') throw new UserFacingError(t().background.stepSkippedInactiveTab);
  if (failure === 'changed-url') throw new UserFacingError(t().background.stepSkippedPageChanged);
}

async function persistRecordingSteps(state: RecordingState, steps: Step[]): Promise<void> {
  if (!state.sessionId || !state.runId) throw new StaleCaptureError('Recording is no longer active.');
  await addStepsAfter(steps, state.insertAfterStepId);
}

/**
 * Removes an unusable snapshot anchor. A published id must be withdrawn from
 * run state first; if that fails, the row is kept (an orphan at worst) so
 * the state never dangles into a deleted anchor.
 */
async function withdrawAnchorThenDelete(
  runId: string,
  anchorId: string,
  version: number,
  anchorPublished: boolean,
): Promise<void> {
  const safeToDelete = !anchorPublished || await updateRunState(
    runId,
    (current) => current.groupAnchorId === anchorId
      ? { ...current, groupAnchorId: null, snapshotViewport: null, snapshotDevicePixelRatio: null }
      : current,
    version,
  ).catch(() => false);
  if (!safeToDelete) return;
  try {
    await deleteStep(anchorId);
  } catch (cleanupError) {
    console.error(
      '[stepmark] failed to remove incomplete snapshot:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}

async function createAndActivateSnapshotAnchor(
  state: RecordingState,
  tabId: number,
  windowId: number,
  context: SnapshotCaptureContext,
  version: number,
): Promise<string> {
  if (!state.sessionId || !state.runId) throw new StaleCaptureError('Snapshot recording is no longer active.');
  const { sessionId, runId } = state;
  const captureId = crypto.randomUUID();
  let anchorId: string | null = null;
  let anchorPublished = false;

  try {
    const captured = await captureScreenshot(
      { runId, captureId, ...context },
      sessionId,
      tabId,
      windowId,
      version,
    );
    anchorId = crypto.randomUUID();
    const existingSteps = await getSteps(sessionId);
    await persistRecordingSteps(state, [{
      id: anchorId,
      sessionId,
      runId,
      order: existingSteps.length,
      screenshotBlob: captured.blob,
      bounds: null,
      devicePixelRatio: context.devicePixelRatio,
      screenshotScale: captured.scale,
      description: '',
      url: context.url,
      timestamp: context.timestamp,
      groupId: anchorId,
      numbered: state.numbered,
    }]);
    const updated = await updateRunState(
      runId,
      (current) => ({
        ...current,
        groupAnchorId: anchorId,
        snapshotViewport: context.viewport,
        snapshotDevicePixelRatio: context.devicePixelRatio,
        error: null,
        recoverableError: null,
      }),
      version,
    );
    if (!updated) throw new StaleCaptureError('Recording changed while saving the snapshot.');
    anchorPublished = true;

    control.acceptingClicks = true;
    const activateMessage: StepmarkSnapshotActiveMessage = {
      type: 'STEPMARK_SNAPSHOT_ACTIVE',
      runId,
    };
    const activated = await browser.tabs.sendMessage(tabId, activateMessage, { frameId: 0 });
    if (activated !== true) {
      throw new Error('Snapshot recorder could not be activated after saving its base image.');
    }
    return anchorId;
  } catch (error) {
    control.acceptingClicks = false;
    if (anchorId) await withdrawAnchorThenDelete(runId, anchorId, version, anchorPublished);
    throw error;
  } finally {
    releaseCapture(captureId);
  }
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
    await updateRunState(
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

/** 僅在持久化流程仍相符時，重建 MV3 遺失的復原狀態。 */
async function recoverPendingUndo(): Promise<void> {
  const record = await readPendingUndoRecord();
  if (!record) return;
  const state = await getRecordingState();
  const windowStillOpen =
    state.isRecording &&
    state.operation === 'recording' &&
    state.runId === record.runId &&
    state.itemCount === record.expectedItemCount &&
    (state.phase === 'recording' || state.phase === 'paused') &&
    record.expiresAt > Date.now();
  if (!windowStillOpen) {
    await clearPendingUndoRecord();
    return;
  }
  pendingUndo ??= record;
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
          startupAnchorId = await createAndActivateSnapshotAnchor(
            startedState,
            tab.id!,
            tab.windowId,
            context,
            version,
          );
        }
        await updateRunState(
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
    if (startupAnchorId) await withdrawAnchorThenDelete(runId, startupAnchorId, version, true);
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
  return invalidateSnapshotRun(
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

/**
 * 僅回收 popup 建立且仍為空白的 Project。完成與錯誤路徑仍需該 id
 * 供編輯器導頁或復原，因此予以保留。
 */
async function reclaimAbandonedAutoCreatedProject(state: RecordingState): Promise<void> {
  if (!state.autoCreatedProjectId || state.autoCreatedProjectId !== state.sessionId) return;
  try {
    await discardPristineProject(state.autoCreatedProjectId);
  } catch (error) {
    console.error(
      '[stepmark] failed to reclaim the abandoned auto-created project:',
      describeBrowserError(error),
      error,
    );
  }
}

async function deleteEmptySnapshotAnchor(state: RecordingState): Promise<string | null> {
  if (state.mode !== 'snapshot' || !state.sessionId || !state.groupAnchorId) return null;
  const steps = await getSteps(state.sessionId);
  const hasAnnotations = steps.some(
    (step) => step.groupId === state.groupAnchorId && stepRole(step) === 'annotation' && step.bounds !== null,
  );
  if (hasAnnotations) return null;
  await deleteStep(state.groupAnchorId);
  return state.groupAnchorId;
}

/** 停止後盡力清理；失敗可能留下孤立資料，但不可讓停止操作失敗。 */
async function deleteEmptySnapshotAnchorBestEffort(state: RecordingState): Promise<void> {
  try {
    await deleteEmptySnapshotAnchor(state);
  } catch (cleanupError) {
    console.error(
      '[stepmark] failed to remove the empty snapshot anchor:',
      describeBrowserError(cleanupError),
      cleanupError,
    );
  }
}

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
    // the restore window. Best-effort — persistence failure degrades to memory-only undo.
    try {
      await savePendingUndoRecord(undoRecord);
    } catch (persistError) {
      console.warn('[stepmark] failed to persist the undo window', persistError);
    }
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
      discardPendingUndo();
      return controlFailure(t().background.undoStateChanged);
    }

    pendingUndo = undoRecord;
    return { ok: true, undoToken: undoRecord.token, removedItemNumber: state.itemCount };
  });
}

async function restoreLastCapture(message: RecordingControlMessage): Promise<RecordingControlResult> {
  return queueClick(async () => {
    const undo = pendingUndo;
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
      discardPendingUndo();
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
    discardPendingUndo();
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

async function captureScreenshotWithGuard(
  message: Pick<ClickCapture, 'viewport' | 'devicePixelRatio' | 'captureId'>,
  tabId: number,
  windowId: number,
  assertContext: () => Promise<void>,
): Promise<{ blob: Blob; scale: number }> {
  return queueCapture(async () => {
    const guard = async () => {
      assertCaptureNotCancelled(message.captureId);
      await assertContext();
      assertCaptureNotCancelled(message.captureId);
    };
    await guard();
    const dataUrl = await withCapturePresentation(
      {
        insert: () => browser.scripting.insertCSS({
          target: { tabId, frameIds: [0] },
          css: CAPTURE_PRESENTATION_CSS,
          origin: 'USER',
        }),
        settle: async () => {
          await browser.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            func: waitForCapturePresentationPaint,
          });
        },
        remove: () => browser.scripting.removeCSS({
          target: { tabId, frameIds: [0] },
          css: CAPTURE_PRESENTATION_CSS,
          origin: 'USER',
        }),
      },
      () => recorderRuntime.captureVisibleTabWithRetry(windowId, guard),
    );
    const blob = await recorderRuntime.dataUrlToBlob(dataUrl);
    const scale = await recorderRuntime.getScreenshotScale(blob, message.viewport, message.devicePixelRatio);
    // Do not persist an image after a stop/cancel/new operation arrives while
    // captureVisibleTab or image decoding is still in flight.
    await guard();
    return { blob, scale };
  });
}

async function captureScreenshot(
  message: Pick<ClickCapture, 'runId' | 'url' | 'viewport' | 'devicePixelRatio' | 'captureId'>,
  sessionId: string,
  tabId: number,
  windowId: number,
  expectedControlVersion: number,
): Promise<{ blob: Blob; scale: number }> {
  return captureScreenshotWithGuard(message, tabId, windowId, () =>
    assertCaptureContext(expectedControlVersion, message.runId, sessionId, tabId, windowId, message.url),
  );
}

async function handleSnapshotClick(
  message: ClickCapture,
  sessionId: string,
  state: RecordingState,
  expectedControlVersion: number,
): Promise<void> {
  const anchorId = state.groupAnchorId;

  if (
    state.snapshotViewport &&
    state.snapshotDevicePixelRatio != null &&
    !isMatchingSnapshotViewport(
      state.snapshotViewport,
      state.snapshotDevicePixelRatio,
      message.viewport,
      message.devicePixelRatio,
    )
  ) {
    throw new SnapshotViewportChangedError(
      'Snapshot annotation skipped because the viewport or scroll position changed.',
    );
  }

  // A missing anchor can never accept another annotation; the typed error settles
  // the whole run once instead of surfacing the same per-click error forever.
  if (!anchorId) throw new SnapshotAnchorMissingError('Snapshot anchor id is missing from the run state.');
  let existingSteps = await getSteps(sessionId);
  const anchor = existingSteps.find((step) => step.id === anchorId);

  if (!anchor?.screenshotBlob) {
    throw new SnapshotAnchorMissingError('Snapshot anchor row or its base image no longer exists.');
  }
  // This throw message surfaces to the user through setRunError, so it is localized.
  if (anchor.url !== message.url) {
    throw new UserFacingError(t().background.annotationSkippedPageChanged);
  }
  if (expectedControlVersion !== control.controlVersion) {
    throw new StaleCaptureError('Recording control changed while saving the annotation.');
  }
  const current = await getRecordingState();
  if (!current.isRecording || current.runId !== message.runId || current.sessionId !== sessionId) {
    throw new StaleCaptureError('Recording changed while saving the annotation.');
  }
  existingSteps = await getSteps(sessionId);
  await persistRecordingSteps(state, [{
    id: crypto.randomUUID(),
    sessionId,
    runId: message.runId,
    order: existingSteps.length,
    bounds: message.rect,
    devicePixelRatio: anchor.devicePixelRatio,
    screenshotScale: anchor.screenshotScale,
    description: generateActionDescription(message),
    url: message.url,
    timestamp: message.timestamp,
    groupId: anchorId,
    numbered: state.numbered,
  }]);
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

async function handleClick(
  message: ClickCapture,
  sender: Browser.runtime.MessageSender,
  expectedControlVersion: number,
): Promise<ClickCaptureResult> {
  const rejectBeforeTransaction = (reason: string): ClickCaptureResult => {
    releaseCapture(message.captureId);
    return { ok: false, error: reason };
  };
  if (expectedControlVersion !== control.controlVersion) return rejectBeforeTransaction('stale-control-version');
  const state = await getRecordingState();
  if (!state.isRecording || !state.sessionId || state.runId !== message.runId) {
    return rejectBeforeTransaction('not-recording');
  }
  if (state.phase !== 'recording' && state.phase !== 'finishing') return rejectBeforeTransaction('wrong-phase');
  if (state.tabId == null || !isTrustedRecordedPageSender(message.url, sender, state.tabId)) {
    return rejectBeforeTransaction('untrusted-sender');
  }
  const windowId = sender.tab?.windowId;
  const tabId = sender.tab?.id;
  if (windowId == null || tabId == null) return rejectBeforeTransaction('missing-tab-context');

  try {
    discardPendingUndo();
    if (state.mode === 'snapshot') {
      await handleSnapshotClick(message, state.sessionId, state, expectedControlVersion);
    } else {
      const captured = await captureScreenshot(message, state.sessionId, tabId, windowId, expectedControlVersion);
      const existingSteps = await getSteps(state.sessionId);
      const current = await getRecordingState();
      if (!current.isRecording || current.runId !== message.runId || current.sessionId !== state.sessionId) {
        throw new StaleCaptureError('Recording changed while saving the step.');
      }
      if (expectedControlVersion !== control.controlVersion) {
        throw new StaleCaptureError('Recording control changed while saving the step.');
      }
      assertCaptureNotCancelled(message.captureId);
      // No await between this commit marker and the persisting write: a later
      // cancellation must not write a step after the gesture has been replayed.
      markCaptureCommitting(message.captureId);
      await persistRecordingSteps(state, [{
        id: crypto.randomUUID(),
        sessionId: state.sessionId,
        runId: message.runId,
        order: existingSteps.length,
        screenshotBlob: captured.blob,
        bounds: message.rect,
        devicePixelRatio: message.devicePixelRatio,
        screenshotScale: captured.scale,
        description: generateActionDescription(message),
        url: message.url,
        timestamp: message.timestamp,
      }]);
    }
    await updateRunState(message.runId, (currentState) => ({
      ...currentState,
      itemCount: currentState.itemCount + 1,
      lastCommittedCaptureId: message.captureId,
      error: null,
      recoverableError: null,
    }));
    return { ok: true };
  } catch (err) {
    let reason = 'capture-failed';
    try {
      if (err instanceof SnapshotViewportChangedError) {
        reason = 'snapshot-viewport-changed';
        await invalidateSnapshotRun(
          message.runId,
          message.viewport,
          message.devicePixelRatio,
          expectedControlVersion,
        );
      } else if (err instanceof SnapshotAnchorMissingError) {
        // The run can never accept another annotation; settle it once with a
        // recoverable error instead of failing every subsequent click.
        reason = 'snapshot-anchor-missing';
        console.error('[stepmark] snapshot anchor is gone; settling the run:', err.message);
        await stopRunWithError(
          message.runId,
          snapshotAnchorMissingError().message,
          expectedControlVersion,
          snapshotAnchorMissingError(),
        );
      } else if (isMissingTabError(err)) {
        reason = 'tab-closed';
        // Not awaited: this runs inside the click queue, and the lifecycle
        // queue it enters can be waiting for queued clicks.
        void handleRecordedTabGone(tabId).catch((error) => {
          console.error('[stepmark] failed to handle the closed recording tab', error);
        });
      } else if (err instanceof StaleCaptureError) {
        reason = `stale-capture: ${err.message}`;
      } else {
        const diagnostic = describeBrowserError(err);
        reason = diagnostic;
        console.error(
          '[stepmark] failed to capture/annotate/save step:',
          diagnostic,
          err,
        );
        // The toolbar shows state.error verbatim: localized copy only, never
        // the raw browser diagnostic or its "Error: " rendering.
        await setRunError(message.runId, userFacingErrorMessage(err, t().background.captureFailed));
      }
    } catch (recoveryError) {
      control.acceptingClicks = false;
      console.error(
        '[stepmark] failed to persist capture failure:',
        describeBrowserError(recoveryError),
        recoveryError,
      );
    }
    return { ok: false, error: reason };
  } finally {
    releaseCapture(message.captureId);
  }
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
          handleRecordingControl(message, sender),
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
        if (!control.acceptingClicks) {
          return Promise.resolve({ ok: false, status: 'rejected' } satisfies StepRecaptureTargetResult);
        }
        {
          const expectedControlVersion = control.controlVersion;
          return withMessageFailureFallback(
            queueClick(async () => {
              await startupRecovery;
              return recaptureFlow.handleRecaptureTarget(message, sender, expectedControlVersion);
            }),
            'recapture target handling failed',
            { ok: false, status: 'failed' } satisfies StepRecaptureTargetResult,
          );
        }
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
        if (!control.acceptingClicks) {
          return Promise.resolve({ ok: false, error: 'not-accepting-clicks' } satisfies ClickCaptureResult);
        }
        {
          const expectedControlVersion = control.controlVersion;
          return withMessageFailureFallback(
            queueClick(async () => {
              // Version read before recovery: if this message woke the worker over a
              // stale persisted run, recovery settles it and the bumped version rejects silently.
              await startupRecovery;
              return handleClick(message, sender, expectedControlVersion);
            }),
            'capture request failed',
            { ok: false, error: 'capture-request-failed' } satisfies ClickCaptureResult,
          );
        }
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
    void resumeRunWaitingForSiteAccess().catch((error) => {
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
    void handleCommandShortcut(command).catch((error) => {
      console.error('[stepmark] failed to handle command shortcut', error);
    });
  });

  const handleKeepAlivePort = createKeepAlivePortHandler({
    getRecordingState,
    isTrustedKeepAliveSender: (sender: Browser.runtime.MessageSender | undefined, state: RecordingState) =>
      isTrustedKeepAliveSender(sender ?? {}, state),
    acknowledgeDisconnect: () => void browser.runtime.lastError,
  });
  browser.runtime.onConnect.addListener(handleKeepAlivePort);

  const activeRunInTab = (
    state: RecordingState,
    tabId: number,
  ): { state: RecordingState; runId: string } | null => {
    if (
      !state.isRecording ||
      state.operation !== 'recording' ||
      state.tabId !== tabId ||
      !state.runId
    ) {
      return null;
    }
    return { state, runId: state.runId };
  };

  /** Puts the run on hold in a page the recorder cannot run on; it resumes
   * when the tab (or a tab it follows into) shows a recordable page again. */
  const markRunWaiting = (runId: string, reason: RecordingWaitReason, expectedControlVersion: number) =>
    updateRunState(runId, (current) => markRecordingWait(current, reason), expectedControlVersion);

  /** Lifts a hold once the recorder runs again; a write only when one is set,
   * so ordinary in-run navigations cost no state churn. */
  const clearRunWaiting = (runId: string, expectedControlVersion: number) =>
    control.writeStateIf(
      expectedControlVersion,
      (current) =>
        current.isRecording &&
        current.operation === 'recording' &&
        current.runId === runId &&
        isRecordingWaitError(current.recoverableError),
      clearRecordingWait,
    );

  /** 重新注入所有可存取 frame；注入失敗的結束方式由呼叫端決定。 */
  const reinjectRecorder = async (
    tabId: number,
    failureLog: string,
  ): Promise<'injected' | 'tab-closed' | 'error-page' | 'failed'> => {
    try {
      await recorderRuntime.injectRecorder(tabId, true);
      return 'injected';
    } catch (err) {
      // Tab closure is owned by handleRecordedTabGone (fed by tabs.onRemoved),
      // which may hand the run to another tab: never end the run from here.
      if (isMissingTabError(err)) return 'tab-closed';
      console.error(failureLog, describeBrowserError(err), err);
      return isErrorPageError(err) ? 'error-page' : 'failed';
    }
  };

  /** The <all_urls> grant arrived while a run waits for site access in its
   * tab: that page may be recordable now, so the run resumes there. */
  async function resumeRunWaitingForSiteAccess(): Promise<void> {
    const expectedControlVersion = control.controlVersion;
    const state = await getRecordingState();
    if (
      !state.isRecording ||
      state.operation !== 'recording' ||
      !state.runId ||
      state.tabId == null ||
      !isWaitingForSiteAccess(state)
    ) {
      return;
    }
    const { runId, tabId } = state;
    let url: string | undefined;
    try {
      url = (await browser.tabs.get(tabId)).url;
    } catch {
      return; // Gone: tabs.onRemoved owns what happens to the run.
    }
    const waitReason = await unrecordableReason(url);
    if (waitReason) {
      await markRunWaiting(runId, waitReason, expectedControlVersion);
      return;
    }
    // Cleared before injecting so the fresh toolbar never flashes the old notice.
    await clearRunWaiting(runId, expectedControlVersion);
    const resumed = await reinjectRecorder(tabId, '[stepmark] failed to resume the recorder after the permission grant:');
    if (resumed === 'error-page') await markRunWaiting(runId, 'page-failed', expectedControlVersion);
  }

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void (async () => {
      if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete' && !changeInfo.url) return;
      // The recapture leg lives with its flow; the listener stays wired here,
      // mirroring follow-mode's listener/logic split.
      if (await recaptureFlow.handleSourceTabUpdated(tabId, changeInfo)) return;
      const expectedControlVersion = control.controlVersion;
      const current = await getRecordingState();
      if (expectedControlVersion !== control.controlVersion) return;
      const active = activeRunInTab(current, tabId);
      if (!active) {
        // Another tab finished loading a web page while the user is on it (a
        // blank tab they typed a URL into): the run may follow it now.
        if (changeInfo.status === 'complete' && tab.active && isRecordableTabUrl(tab.url)) {
          followMode.scheduleFollowForLoadedTab(tabId, current);
        }
        return;
      }
      const { state, runId } = active;

      if (state.mode === 'snapshot' && state.phase === 'preparing-next') {
        if (changeInfo.status !== 'complete') return;
        const waitReason = await unrecordableReason(tab.url);
        if (waitReason) {
          await setRunError(
            runId,
            waitReason === 'site-access' ? recordingWaitError(waitReason).message : t().background.snapshotUnavailableHere,
          );
          return;
        }
        const restored = await reinjectRecorder(
          tabId,
          '[stepmark] failed to restore snapshot preparation toolbar after navigation:',
        );
        if (restored === 'failed' || restored === 'error-page') {
          await setRunError(runId, t().background.controlsUnavailableHere);
        }
        return;
      }

      const updateAction = getRecordingTabUpdateAction(state.mode, changeInfo);
      // A snapshot's coordinates belong to one immutable document: fail closed as
      // soon as it navigates, never re-inject just because a loading page completes.
      if (updateAction === 'stop-snapshot') {
        await stopRunWithError(runId, t().background.stoppedSnapshotPageChanged, expectedControlVersion);
        return;
      }
      if (updateAction !== 'reinject') return;

      // A steps run waits out a page it cannot record (a browser page, a site
      // without access, a failed load) exactly like follow mode waits out an
      // ineligible tab: nothing is lost, and the next recordable page resumes it.
      const waitReason = await unrecordableReason(tab.url);
      if (waitReason) {
        await markRunWaiting(runId, waitReason, expectedControlVersion);
        return;
      }
      // Cleared before injecting so the fresh toolbar never flashes the old notice.
      await clearRunWaiting(runId, expectedControlVersion);
      const reinjected = await reinjectRecorder(
        tabId,
        '[stepmark] failed to re-inject recorder after navigation:',
      );
      if (reinjected === 'error-page') {
        await markRunWaiting(runId, 'page-failed', expectedControlVersion);
      } else if (reinjected === 'failed') {
        await stopRunWithError(
          runId,
          t().background.stoppedRecorderUnavailable,
          expectedControlVersion,
        );
      }
    })().catch((error) => {
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
  void queueClick(recoverPendingUndo).catch((error) => {
    console.error('[stepmark] failed to recover the undo window', error);
  });
});
