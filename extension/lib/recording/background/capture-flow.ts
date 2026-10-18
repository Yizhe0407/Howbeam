import { browser, type Browser } from 'wxt/browser';
import { StaleCaptureError, queueCapture } from '../background-queues';
import { generateActionDescription } from '../../capture/action-description';
import {
  CAPTURE_PRESENTATION_CSS,
  waitForCapturePresentationPaint,
  withCapturePresentation,
} from '../../capture/capture-presentation';
import { addStepsAfter, deleteStep, getSteps } from '../../storage/step-repository';
import type { Step } from '../../storage/models';
import {
  getCaptureGuardFailure,
  isMatchingSnapshotViewport,
  isTrustedRecordedPageSender,
} from '../recording-guards';
import {
  assertCaptureNotCancelled,
  markCaptureCommitting,
  releaseCapture,
} from './capture-registry';
import { t } from '@/lib/shared/i18n';
import { describeBrowserError, isMissingTabError } from '../../runtime/browser-errors';
import { UserFacingError, userFacingErrorMessage } from '../../runtime/user-facing-errors';
import { getRecordingState } from '../../storage/storage';
import type { ClickCapture, ClickCaptureResult, StepmarkSnapshotActiveMessage } from '../../runtime/messages';
import type { RecordingState, RecoverableRecordingError } from '../../storage/recording-state';
import type { ControlPlane, SnapshotCaptureContext } from './control-plane';
import type { RecorderRuntime } from './recorder-runtime';
import type { RunState } from './run-state';

/** 標示 anchor viewport 不符，讓整個快照流程失效。 */
class SnapshotViewportChangedError extends Error {}
/** 結束 anchor 已無法接受標註的快照流程。 */
export function snapshotAnchorMissingError(): RecoverableRecordingError {
  return { code: 'SNAPSHOT_ANCHOR_MISSING', message: t().background.snapshotAnchorLost };
}

/** 標示 anchor 圖片遺失，讓流程結束而非持續重試。 */
class SnapshotAnchorMissingError extends Error {}

export interface CaptureFlowDependencies {
  control: ControlPlane;
  runtime: RecorderRuntime;
  runState: RunState;
  stopRunWithError(
    runId: string,
    error: string,
    expectedControlVersion: number,
    recoverableError?: RecoverableRecordingError,
  ): Promise<void>;
  handleRecordedTabGone(tabId: number): Promise<void>;
  discardPendingUndo(): void;
}

/** Turns a recorder's click into a stored step or snapshot annotation, and
 * takes the screenshots (snapshot anchors included) behind them. */
export function createCaptureFlow(deps: CaptureFlowDependencies) {
  const { control, runtime: recorderRuntime, stopRunWithError, handleRecordedTabGone, discardPendingUndo } = deps;
  const { updateRunState, setRunError, invalidateSnapshotRun } = deps.runState;

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
      let reported = false;
      try {
        if (err instanceof SnapshotViewportChangedError) {
          reason = 'snapshot-viewport-changed';
          await invalidateSnapshotRun(
            message.runId,
            message.viewport,
            message.devicePixelRatio,
            expectedControlVersion,
          );
          reported = true;
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
          reported = true;
        } else if (isMissingTabError(err)) {
          // The page that would show a notice is gone.
          reason = 'tab-closed';
          reported = true;
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
          reported = true;
        }
      } catch (recoveryError) {
        control.acceptingClicks = false;
        console.error(
          '[stepmark] failed to persist capture failure:',
          describeBrowserError(recoveryError),
          recoveryError,
        );
      }
      return reported ? { ok: false, error: reason, reported: true } : { ok: false, error: reason };
    } finally {
      releaseCapture(message.captureId);
    }
  }

  return { captureScreenshotWithGuard, createAndActivateSnapshotAnchor, withdrawAnchorThenDelete, handleClick };
}

export type CaptureFlow = ReturnType<typeof createCaptureFlow>;
