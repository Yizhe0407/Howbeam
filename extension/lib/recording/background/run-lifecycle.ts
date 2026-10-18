import { browser, type Browser } from 'wxt/browser';
import { waitForQueuedClicks } from '../background-queues';
import { isRecordableTabUrl } from '../../shared/restricted-urls';
import { focusTab } from '../../runtime/navigation';
import { getStep } from '../../storage/step-repository';
import { getProject, resetProject } from '../../storage/project-repository';
import { t } from '@/lib/shared/i18n';
import { describeBrowserError } from '../../runtime/browser-errors';
import { getRecordingState, resetRunStateToIdle } from '../../storage/storage';
import { recordedTabClosedError } from '../recording-recovery';
import type {
  PreflightProjectContinuationSourcePermissionErrorCode,
  PreflightProjectContinuationSourcePermissionMessage,
  PreflightProjectContinuationSourcePermissionResult,
  ResetProjectMessage,
  ResetProjectResult,
  StartRecordingMessage,
  StartRecordingResult,
} from '../../runtime/messages';
import type { RecordingState } from '../../storage/recording-state';
import { snapshotAnchorMissingError, type CaptureFlow } from './capture-flow';
import { markRecordingWait, unrecordableReason, type RecordingWaitReason } from './recording-wait';
import {
  isEditorSenderForSession,
  resolveContinuationTab,
  resolveProjectContinuationAnchor,
  sourcePermissionPreflightSuccess,
} from './source-tab';
import { deleteEmptySnapshotAnchorBestEffort, reclaimAbandonedAutoCreatedProject } from './run-cleanup';
import type { ControlPlane } from './control-plane';
import type { RecaptureFlow } from './recapture-flow';
import type { RecorderRuntime } from './recorder-runtime';
import type { RunEnding } from './run-ending';
import type { RunState } from './run-state';

export interface RunLifecycleDependencies {
  control: ControlPlane;
  runtime: RecorderRuntime;
  runState: RunState;
  captureFlow: CaptureFlow;
  recaptureFlow: RecaptureFlow;
  runEnding: RunEnding;
}

/** Starting, stopping and resetting a recording, and settling one a restarted
 * worker finds interrupted. */
export function createRunLifecycle(deps: RunLifecycleDependencies) {
  const { control, runtime: recorderRuntime, runState, captureFlow, recaptureFlow } = deps;
  const { stopRunWithError, handleRecordedTabGone } = deps.runEnding;

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

  return {
    preflightProjectContinuationSourcePermission,
    recoverInterruptedRecording,
    startRecording,
    stopRecording,
    resetProjectLifecycle,
  };
}
