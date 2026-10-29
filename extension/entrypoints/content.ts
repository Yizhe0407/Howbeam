import { browser } from 'wxt/browser';
import {
  collectKeyboardCandidateAnchors,
  installSnapshotFrameProbe,
  waitForNextFrame,
} from '@/lib/recording/snapshot-targeting';
import {
  installSnapshotFrameFreeze,
  installStepFrameRecorder,
} from '@/lib/recording/frame-relay';
import { installRecorderLifecycle } from '@/lib/recording/recorder-lifecycle';
import { createSnapshotShield } from '@/lib/recording/snapshot-shield';
import { createSnapshotRecorder } from '@/lib/recording/content/snapshot-recorder';
import { featureFlags } from '@/lib/shared/feature-flags';
import { getRecordingState, onRecordingStateChange } from '@/lib/storage/storage';
import { isRuntimeBoolean, requireRuntimeMessageResult } from '@/lib/runtime/runtime-message-result';
import { installRecaptureRecorder } from '@/lib/recording/recapture-recorder';
import { createCaptureSender } from '@/lib/recording/content/capture-sender';
import { createContentRecordingSession } from '@/lib/recording/content/recording-session';
import { installStepRecorder } from '@/lib/recording/content/step-recorder';
import { createToolbarChannel } from '@/lib/recording/content/toolbar-channel';
import { CLEANUP_EVENT } from '@/lib/recording/content-script-constants';
import type {
  HowbeamCaptureTakenMessage,
  HowbeamSnapshotActiveMessage,
  HowbeamSnapshotHistoryMessage,
  HowbeamStopMessage,
  SnapshotRecorderFailureMessage,
} from '@/lib/runtime/messages';
import { t } from '@/lib/shared/i18n';
import { initLocalePreference } from '@/lib/runtime/locale-preference';
import { mountRecordingToolbar } from '@/lib/recording/recording-toolbar-host';
import {
  detectUnrecordablePage,
  isChildFrameUnrecordable,
} from '@/lib/recording/content/recordable-page';

const INSTANCE_KEY = `__howbeam_instance_${browser.runtime.id}`;
/** The live recorder module of this document's extension world. */
const RECORDER_KEY = `__howbeam_recorder_${browser.runtime.id}`;

interface ResidentRecorder {
  /** Runs one recorder start in the module instance that owns this document. */
  start(): Promise<void>;
  /** False once the extension that loaded this instance was reloaded or
   * updated (an orphaned content script has no runtime left). */
  isAlive(): boolean;
}

function isRuntimeAlive(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime',
  main() {
    // The background injects this bundle on every start, resume, mode switch
    // and navigation. Each injection evaluates a fresh copy of every module —
    // React included — and React leaves document-level listeners behind that
    // nothing removes, so letting each copy run would pin every previous
    // copy (its fiber trees, toolbar host and listeners) for the life of the
    // page. Only the first copy in a document ever runs; later injections just
    // ask it to start again, and are garbage once this returns.
    const host = globalThis as unknown as Record<string, unknown>;
    const resident = host[RECORDER_KEY] as ResidentRecorder | undefined;
    if (resident && typeof resident.start === 'function' && resident.isAlive()) return resident.start();
    const recorder: ResidentRecorder = { start: startRecorder, isAlive: isRuntimeAlive };
    host[RECORDER_KEY] = recorder;
    return startRecorder();
  },
});

async function startRecorder(): Promise<void> {
  // Concurrent executeScript calls can both dispatch cleanup before either reaches
  // its first await; the instance token makes only the latest one install listeners.
  document.dispatchEvent(new CustomEvent(CLEANUP_EVENT));
  const instanceId = crypto.randomUUID();
  const instanceHost = globalThis as unknown as Record<string, unknown>;
  instanceHost[INSTANCE_KEY] = instanceId;
  // The in-page toolbar follows the chosen language; a reinjection's cleanup
  // event retires this instance's subscription along with everything else —
  // including when that cleanup already ran before the subscription existed.
  void initLocalePreference().then((stopFollowing) => {
    if (instanceHost[INSTANCE_KEY] !== instanceId) {
      stopFollowing();
      return;
    }
    document.addEventListener(CLEANUP_EVENT, stopFollowing, { once: true });
  });

  const recordingState = await getRecordingState();
  if (instanceHost[INSTANCE_KEY] !== instanceId) return;
  if (recordingState.operation === 'recapture' && recordingState.recapture) {
    if (window.top !== window) {
      installSnapshotFrameProbe(recordingState.recapture.runId);
      return;
    }
    await installRecaptureRecorder(recordingState.recapture);
    return;
  }
  if (recordingState.operation !== 'recording' || !recordingState.isRecording || !recordingState.runId) return;

  const runId = recordingState.runId;
  const isSnapshotMode = recordingState.mode === 'snapshot';
  const isStepMode = recordingState.mode === 'steps';
  const shouldFreezeSnapshot = isSnapshotMode && recordingState.phase !== 'preparing-next' &&
    (window.top !== window || detectUnrecordablePage() === null);
  if (isSnapshotMode && window.top !== window) {
    if (shouldFreezeSnapshot) {
      installSnapshotFrameProbe(runId);
      // The shield only covers the top viewport, so each child must freeze
      // itself and report pixel-shifting scrolls upward.
      installSnapshotFrameFreeze();
    }
    return;
  }
  if (isStepMode && window.top !== window) {
    // No recorder runs under a page that cannot be recorded; relaying would
    // only hold every click here back for the relay failsafe.
    if (isChildFrameUnrecordable()) return;
    // Child frames capture their own clicks and relay them (with rects
    // mapped hop-by-hop into the top viewport) to the top-frame recorder.
    installStepFrameRecorder(runId, recordingState.phase === 'paused');
    return;
  }
  // The PDF viewer and non-web documents (file://, data:) can never produce
  // a step. The toolbar says so instead of looking like it is recording.
  const unrecordable = detectUnrecordablePage();
  const snapshotViewportContract = recordingState.snapshotViewport ?? {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const snapshotDevicePixelRatioContract = recordingState.snapshotDevicePixelRatio ?? window.devicePixelRatio;

  const session = createContentRecordingSession({
    runId,
    paused: recordingState.phase === 'paused',
  });
  const capture = createCaptureSender(runId);
  const toolbar = createToolbarChannel(runId);
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

  const unsubscribeRecordingState = onRecordingStateChange((state) => {
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
  });

  // Navigating away freezes this document in bfcache with recorder listeners
  // intact; the shared lifecycle hands back the keep-alive port before the
  // freeze and only resumes if this run is still live.
  const recorderLifecycle = installRecorderLifecycle({
    isRunCurrent: async () => {
      const state = await getRecordingState();
      return state.operation === 'recording' && state.isRecording && state.runId === runId;
    },
    cleanup: () => cleanup(),
  });

  const onRecorderMessage = (
    message: HowbeamStopMessage | HowbeamSnapshotActiveMessage | HowbeamSnapshotHistoryMessage | HowbeamCaptureTakenMessage,
  ) => {
    if (message?.type === 'HOWBEAM_STOP') {
      cleanup();
      return;
    }
    if (message?.type === 'HOWBEAM_CAPTURE_TAKEN' && message.runId === runId) {
      capture.markCaptureTaken(message.captureId);
      return;
    }
    if (message?.type === 'HOWBEAM_SNAPSHOT_HISTORY' && message.runId === runId) {
      if (isSnapshotMode) snapshot.applyHistory(message.change);
      return;
    }
    if (message?.type === 'HOWBEAM_SNAPSHOT_ACTIVE' && message.runId === runId) {
      snapshot.setInteractionsActive(true);
      snapshot.notifyInvalidated();
      return Promise.resolve(true);
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
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onRecorderMessage);
    unsubscribeRecordingState();
    recorderLifecycle.stop();
  };
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onRecorderMessage);

  if (shouldFreezeSnapshot) {
    session.shield = createSnapshotShield(
      snapshot.handlers.onPoint,
      snapshot.handlers.onHover,
      snapshot.handlers.onControl,
      snapshot.handlers.onRegion,
      async () => {
        snapshot.setInteractionsActive(false);
        cleanup();
        try {
          await browser.runtime.sendMessage({
            type: 'SNAPSHOT_RECORDER_FAILED',
            runId,
            reason: 'shield-channel',
          } satisfies SnapshotRecorderFailureMessage);
        } catch (error) {
          console.error('[howbeam] failed to report snapshot shield failure', error);
        }
      },
    );
    try {
      await session.shield.ready;
      session.shield.updateToolbar(toolbar.toToolbarState(recordingState));
      if (featureFlags.snapshotKeyboardNav) {
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
      }
      await waitForNextFrame();
      await waitForNextFrame();
    } catch (err) {
      cleanup();
      if (instanceHost[INSTANCE_KEY] !== instanceId) return;
      throw err;
    }
  }

  // START_RECORDING must not resolve until every listener above is active.
  // Otherwise the popup can close while early page clicks still reach JS.
  let isCurrentRecordedTab = false;
  try {
    const readyMessage: import('@/lib/runtime/messages').RecorderReadyMessage = {
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
    isCurrentRecordedTab = requireRuntimeMessageResult(
      await browser.runtime.sendMessage(readyMessage),
      isRuntimeBoolean,
      t().runtime.recordingResponseInvalid,
    );
  } catch (err) {
    console.error('[howbeam] recorder readiness check failed', err);
  }
  if (!isCurrentRecordedTab || instanceHost[INSTANCE_KEY] !== instanceId) {
    cleanup();
    return;
  }

  console.log('[howbeam] recorder ready on', location.href);
}
