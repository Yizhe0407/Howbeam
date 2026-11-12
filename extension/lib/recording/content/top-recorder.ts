import { sendToBackground } from '../../runtime/background-client';
import { collectKeyboardCandidateAnchors, waitForNextFrame } from '../snapshot-targeting';
import { installRecorderLifecycle } from '../recorder-lifecycle';
import { createSnapshotShield } from '../snapshot-shield';
import { createSnapshotRecorder } from './snapshot-recorder';
import { getRecordingState } from '../../storage/storage';
import type { RecordingState } from '../../storage/recording-state';
import { createCaptureSender } from './capture-sender';
import { createContentRecordingSession } from './recording-session';
import { installStepRecorder } from './step-recorder';
import { createToolbarChannel } from './toolbar-channel';
import type {
  HowbeamCaptureTakenMessage,
  HowbeamRecordingStateMessage,
  HowbeamSnapshotActiveMessage,
  HowbeamSnapshotMarksMessage,
  HowbeamStopMessage,
  RecorderReadyMessage,
  SnapshotRecorderFailureMessage,
} from '../../runtime/messages';
import { t } from '../../shared/i18n';
import { mountRecordingToolbar } from '../recording-toolbar-host';
import type { UnrecordablePageReason } from './recordable-page';
import { addRecorderCleanup, removeRecorderCleanup } from './recorder-cleanup';

type RecorderPushMessage =
  | HowbeamStopMessage
  | HowbeamSnapshotActiveMessage
  | HowbeamSnapshotMarksMessage
  | HowbeamCaptureTakenMessage
  | HowbeamRecordingStateMessage;

export interface TopRecorderOptions {
  recordingState: RecordingState;
  runId: string;
  unrecordable: UnrecordablePageReason | null;
  shouldFreezeSnapshot: boolean;
  /** False once a newer start replaced this one; a stale start backs out. */
  isCurrent: () => boolean;
}

/**
 * The run's recorder in the top frame: the step recorder, or the frozen
 * snapshot behind its shield, or (on a page that cannot be recorded) only the
 * toolbar saying so. Resolves once the background has confirmed this is the
 * run's tab, so a start never reports ready before every listener is live.
 */
export async function mountTopRecorder({
  recordingState,
  runId,
  unrecordable,
  shouldFreezeSnapshot,
  isCurrent,
}: TopRecorderOptions): Promise<void> {
  const isSnapshotMode = recordingState.mode === 'snapshot';
  const isStepMode = recordingState.mode === 'steps';
  // The PDF viewer and non-web documents (file://, data:) can never produce
  // a step. The toolbar says so instead of looking like it is recording.
  const snapshotViewportContract = recordingState.snapshotViewport ?? {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const snapshotDevicePixelRatioContract = recordingState.snapshotDevicePixelRatio ?? window.devicePixelRatio;

  // Navigating away freezes this document in bfcache with recorder listeners
  // intact; the shared lifecycle hands back the keep-alive port before the
  // freeze and only resumes if this run is still live.
  const recorderLifecycle = installRecorderLifecycle({
    isRunCurrent: async () => {
      const state = await getRecordingState();
      return state.operation === 'recording' && state.isRecording && state.runId === runId;
    },
    cleanup: () => cleanup(),
    onPush: (message) => onPush(message as RecorderPushMessage),
  });

  const send = recorderLifecycle.send;
  const session = createContentRecordingSession({
    runId,
    paused: recordingState.phase === 'paused',
    send,
  });
  const capture = createCaptureSender(runId, send);
  const toolbar = createToolbarChannel(runId, send);
  const snapshot = createSnapshotRecorder({
    session,
    capture,
    toolbar,
    freezePage: shouldFreezeSnapshot,
    viewportContract: snapshotViewportContract,
    devicePixelRatioContract: snapshotDevicePixelRatioContract,
    initialToolbarState: toolbar.toToolbarState(recordingState),
    invalidatedAtStart: recordingState.phase === 'invalidated',
  });

  const uninstallModeRecorder = unrecordable
    ? (() => {
        session.toolbar = mountRecordingToolbar(toolbar.toToolbarState(recordingState), {
          onCommand: toolbar.sendCommand,
        });
        session.toolbar.showNotice(
          unrecordable === 'pdf-viewer' ? t().toolbar.pageNotRecordablePdf : t().toolbar.pageNotRecordableLocal,
          { persistent: true },
        );
        // Nothing to uninstall: no page input is intercepted here.
        return () => {};
      })()
    : isStepMode
      ? installStepRecorder({
          session,
          capture,
          toolbar,
          initialToolbarState: toolbar.toToolbarState(recordingState),
        })
      : snapshot.install();

  /** The run state, as the background pushes it over the connection after every change. */
  const applyState = (state: RecordingState) => {
    if (state.runId !== runId) return;
    const wasPaused = session.paused;
    session.paused = state.phase === 'paused';
    if (isSnapshotMode) {
      snapshot.setInteractionsActive(state.phase === 'recording');
      if (state.phase === 'invalidated') snapshot.markInvalidationSent();
    }
    if (session.paused) {
      session.hoverPreview?.suspend();
      // Pending gestures haven't started capturing, so there's nothing to undo;
      // an already-active gesture is left alone and finishes normally.
      session.gestureQueue?.purgePending();
    } else if (wasPaused && isStepMode) {
      // Resume must bring the hover highlight back at the last known pointer
      // position instead of waiting for the next pointer move.
      session.hoverPreview?.schedule();
      session.hoverPreview?.armFallback();
    }
    if (state.phase !== 'recording') session.regionCapture?.cancel('removed');
    session.toolbar?.update(toolbar.toToolbarState(state));
    session.shield?.updateToolbar(toolbar.toToolbarState(state));
  };

  /** What the background pushes over the connection; only stop and snapshot activation are answered. */
  const onPush = (message: RecorderPushMessage) => {
    if (message?.type === 'HOWBEAM_STOP') {
      cleanup();
      return;
    }
    if (message?.type === 'HOWBEAM_RECORDING_STATE') {
      applyState(message.state);
      return;
    }
    if (message?.type === 'HOWBEAM_CAPTURE_TAKEN' && message.runId === runId) {
      capture.markCaptureTaken(message.captureId);
      return;
    }
    if (message?.type === 'HOWBEAM_SNAPSHOT_MARKS' && message.runId === runId) {
      if (isSnapshotMode) snapshot.applyMarks(message.marks);
      return;
    }
    if (message?.type === 'HOWBEAM_SNAPSHOT_ACTIVE' && message.runId === runId) {
      snapshot.setInteractionsActive(true);
      snapshot.notifyInvalidated();
      return true;
    }
    return undefined;
  };

  const cleanup = () => {
    uninstallModeRecorder();
    session.regionCapture?.cancel('removed');
    session.regionCapture = null;
    session.shield?.remove();
    session.shield = null;
    session.toolbar?.remove();
    session.toolbar = null;
    session.hoverPreview?.destroy();
    session.hoverPreview = null;
    removeRecorderCleanup(cleanup);
    recorderLifecycle.stop();
  };
  addRecorderCleanup(cleanup);

  if (shouldFreezeSnapshot) {
    session.shield = createSnapshotShield(
      snapshot.handlers.onPoint,
      snapshot.handlers.onHover,
      snapshot.handlers.onControl,
      snapshot.handlers.onRegion,
      async () => {
        snapshot.setInteractionsActive(false);
        // Reported before the cleanup closes the connection it travels on.
        try {
          await send({
            type: 'SNAPSHOT_RECORDER_FAILED',
            runId,
            reason: 'shield-channel',
          } satisfies SnapshotRecorderFailureMessage);
        } catch (error) {
          console.error('[howbeam] failed to report snapshot shield failure', error);
        }
        cleanup();
      },
    );
    try {
      await session.shield.ready;
      session.shield.updateToolbar(toolbar.toToolbarState(recordingState));
      // Defer enumeration off the startup path so a large page cannot stall
      // the clean-base handoff (§9.5). The frozen page keeps anchors valid.
      const shield = session.shield;
      const sendCandidates = () => {
        try {
          shield.sendKeyboardCandidates(collectKeyboardCandidateAnchors());
        } catch (error) {
          console.warn('[howbeam] failed to enumerate keyboard candidates', error);
        }
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(sendCandidates, { timeout: 500 });
      else setTimeout(sendCandidates, 0);

      await waitForNextFrame();
      await waitForNextFrame();
    } catch (err) {
      cleanup();
      if (!isCurrent()) return;
      throw err;
    }
  }

  // START_RECORDING must not resolve until every listener above is active.
  // Otherwise the popup can close while early page clicks still reach JS.
  let isCurrentRecordedTab = false;
  try {
    const readyMessage: RecorderReadyMessage = {
      type: 'HOWBEAM_READY',
      runId,
      ...(shouldFreezeSnapshot
        ? {
            snapshotContext: {
              // Must be the exact object used as the local invalidation contract;
              // re-reading the window here could give the background a baseline
              // that differs from the one this recorder validates against.
              viewport: { ...snapshotViewportContract },
              devicePixelRatio: snapshotDevicePixelRatioContract,
              url: location.href,
              timestamp: Date.now(),
            },
          }
        : {}),
    };
    isCurrentRecordedTab = await sendToBackground(readyMessage, t().runtime.recordingResponseInvalid, send);
  } catch (err) {
    console.error('[howbeam] recorder readiness check failed', err);
  }
  if (!isCurrentRecordedTab || !isCurrent()) {
    cleanup();
    return;
  }

  console.log('[howbeam] recorder ready on', location.href);
}
