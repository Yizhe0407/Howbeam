import { browser, type Browser } from 'wxt/browser';
import { openWelcomePage, opensWelcomeOnInstall } from '@/lib/runtime/welcome';
import { syncActionIconWithRecordingState } from '@/lib/recording/background/action-icon';
import { claimPendingStart } from '@/lib/runtime/pending-start';
import { clearCrossTabRecordingDecline } from '@/lib/runtime/cross-tab-recording';
import { isTrustedExtensionPageSender, isTrustedKeepAliveSender } from '@/lib/runtime/background-message-validation';
import { contractFor, isBackgroundMessage, isExtensionPageOnlyMessage } from '@/lib/runtime/message-contract';
import { createRecorderRuntime } from '@/lib/recording/background/recorder-runtime';
import { createStepFrameRelayBroker } from '@/lib/recording/background/step-frame-relay-broker';
import { createKeepAlivePortHandler } from '@/lib/runtime/keep-alive';
import { createEditorOpen, type EditorOpen } from '@/lib/recording/background/editor-open';
import {
  editorPlacementFor,
  forgetClosedExtensionPage,
  openLibraryPage,
  registerExtensionPage,
} from '@/lib/recording/background/extension-page-tabs';
import {
  checkSourcePermission,
  isEditorSenderForSession,
  openVerifiedSourceTab,
  preflightProjectContinuation,
  resolveContinuationTab,
  sourcePermissionPreflightSuccess,
  withUncommittedSourceTab,
} from '@/lib/recording/background/source-tab';
import {
  isRecaptureSourceTabIntact,
  validateRecaptureTarget,
  wasRecaptureCommitted,
} from '@/lib/recording/background/recapture-target';
import { createBrowserPorts } from '@/lib/recording/run/browser-ports';
import { createRun } from '@/lib/recording/run';
import { toRecordingState } from '@/lib/recording/run/state';
import { liveRecording } from '@/lib/recording/run/transitions';
import { describeBrowserError } from '@/lib/runtime/browser-errors';
import { withMessageFailureFallback } from '@/lib/runtime/background-message-fallback';
import { discardPendingAnchors, replaceStepCaptureAtomically } from '@/lib/storage/step-repository';
import { getRecordingState, setRecordingState } from '@/lib/storage/storage';
import type {
  BackgroundMessageType,
  BackgroundRequest,
  BackgroundResponse,
  RecordingControlMessage,
  RecordingControlResult,
} from '@/lib/runtime/messages';
import { initLocalePreference } from '@/lib/runtime/locale-preference';
import { createRecorderConnections } from '@/lib/recording/background/recorder-connections';

const recorderConnections = createRecorderConnections();

const recorderRuntime = createRecorderRuntime({
  captureVisibleTab: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 95 }),
  executeRecorderScript: (target) =>
    browser.scripting.executeScript({
      target,
      files: ['/content-scripts/content.js'],
    }),
  // The top-frame recorder hears it over its connection (a recorder not yet
  // connected is refused when it connects); child frames still hear the broadcast.
  sendStopMessage: (tabId, message) => {
    recorderConnections.notifyIfConnected(tabId, message);
    return browser.tabs.sendMessage(tabId, message);
  },
});

// The editor opener and the run need each other: the run opens the editor
// after a finish, and the opener settles the run's editor recovery.
let editorOpen: EditorOpen | null = null;

const run = createRun({
  store: { load: getRecordingState, save: setRecordingState },
  ports: createBrowserPorts({
    runtime: recorderRuntime,
    connections: recorderConnections,
    openEditor: (target) => editorOpen!.openEditor(target),
  }),
  sources: {
    isEditorSenderForSession,
    validateTarget: validateRecaptureTarget,
    permissionPreflight: sourcePermissionPreflightSuccess,
    checkPermission: checkSourcePermission,
    openSourceTab: (sourceUrl, preferredTabId) =>
      openVerifiedSourceTab(sourceUrl, preferredTabId, 'failed to open recapture source tab'),
    withUncommittedTab: withUncommittedSourceTab,
    replaceCapture: replaceStepCaptureAtomically,
    wasCommitted: wasRecaptureCommitted,
    isSourceTabIntact: isRecaptureSourceTabIntact,
    closeTab: (tabId) => browser.tabs.remove(tabId),
  },
  extensionOrigin: browser.runtime.getURL('/'),
  resolveContinuationTab,
  discardPendingAnchorsExcept: discardPendingAnchors,
});
editorOpen = createEditorOpen({ recovery: run.editorRecovery });

/** A recording control, after its sender is checked against the run it names. */
async function handleRecordingControl(
  message: RecordingControlMessage,
  sender: Browser.runtime.MessageSender | null,
): Promise<RecordingControlResult> {
  await run.actor.ready();
  if (sender && !run.lifecycle.isTrustedControlSender(message.runId, sender)) {
    console.warn('[howbeam] rejected an untrusted recorder control message', message.type);
    return { ok: false, error: 'background.actionUnavailable' };
  }
  const { runId } = message;
  switch (message.type) {
    case 'PAUSE_RECORDING':
      return run.lifecycle.pause(runId);
    case 'RESUME_RECORDING':
      return run.lifecycle.resume(runId);
    case 'UNDO_LAST_CAPTURE':
      return run.undo.undo(runId);
    case 'RESTORE_LAST_CAPTURE':
      return run.undo.restore(runId, message.undoToken);
    case 'PREPARE_NEXT_SNAPSHOT':
      return run.snapshot.prepareNext(runId);
    case 'CREATE_NEXT_SNAPSHOT':
      return run.snapshot.createNext(runId, 'preparing-next');
    case 'REBUILD_INVALIDATED_SNAPSHOT':
      return run.snapshot.createNext(runId, 'invalidated');
    case 'SWITCH_TO_SNAPSHOT_MODE':
      return run.snapshot.switchToSnapshot(runId);
    case 'SWITCH_TO_STEPS_MODE':
      return run.snapshot.switchToSteps(runId);
    case 'DISCARD_CURRENT_RECORDING':
      return run.lifecycle.discard(runId);
    case 'FINISH_RECORDING':
      return run.lifecycle.finish(runId);
  }
}

/** Keyboard shortcuts carry no run id: they act on the live run. */
async function handleCommandShortcut(command: string): Promise<void> {
  await run.actor.ready();
  const recording = run.actor.state().operation;
  if (recording.kind !== 'recording') return;
  const { runId } = recording;
  switch (command) {
    case 'toggle-pause':
      // Pause is a steps-mode affordance; a snapshot has no pause.
      if (recording.mode !== 'steps') return;
      if (recording.phase === 'recording') await handleRecordingControl({ type: 'PAUSE_RECORDING', runId }, null);
      else if (recording.phase === 'paused') await handleRecordingControl({ type: 'RESUME_RECORDING', runId }, null);
      return;
    case 'undo-last-capture':
      await handleRecordingControl({ type: 'UNDO_LAST_CAPTURE', runId }, null);
      return;
    case 'finish-recording':
      await handleRecordingControl({ type: 'FINISH_RECORDING', runId }, null);
      return;
  }
}

export default defineBackground(() => {
  // Error copy and step descriptions the worker produces follow the chosen
  // language. A worker woken by a click must not describe that step before the
  // stored preference is read, so startup recovery (which every click awaits)
  // waits for it too.
  const localeReady = initLocalePreference().catch((error: unknown) => {
    console.warn('[howbeam] failed to apply the language preference', error);
  });
  // Registered synchronously so the install event is never missed by a worker
  // still finishing its first run.
  browser.runtime.onInstalled.addListener((details) => {
    if (!opensWelcomeOnInstall(details)) return;
    openWelcomePage().catch((error: unknown) => {
      console.error('[howbeam] failed to open the welcome page', error);
    });
  });
  syncActionIconWithRecordingState();
  const stepFrameRelayBroker = createStepFrameRelayBroker({
    sendResult: async (tabId, frameId, message) => {
      await browser.tabs.sendMessage(tabId, message, { frameId });
    },
  });

  // A worker woken by a message from a stale persisted run (a bfcache-restored
  // recorder) must not race recovery: captures wait for it.
  const startupRecovery = (async () => {
    await localeReady;
    await run.recapture.recover();
    await run.recovery.recoverInterruptedRecording();
    await run.undo.recover();
  })().catch((error) => {
    console.error('[howbeam] failed to recover an interrupted operation', error);
  });

  const relaySender = (sender: Browser.runtime.MessageSender) => ({
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? null,
  });

  /** A child-frame relay hop from the live steps run's tab: from a child frame to begin, the top frame to claim. */
  const isActiveStepRelaySender = (
    runId: string,
    sender: Browser.runtime.MessageSender,
    expectedFrame: 'child' | 'top',
  ) => {
    const { frameId } = sender;
    if (frameId == null || (expectedFrame === 'child' ? frameId <= 0 : frameId !== 0)) return false;
    const recording = liveRecording(run.actor.state(), runId);
    return recording?.mode === 'steps' && recording.phase === 'recording' && recording.tabId === sender.tab?.id;
  };

  // After recovery: a restore must find the undo window a restarted worker rebuilds.
  const handleRecordingControlMessage = async (
    message: RecordingControlMessage,
    sender: Browser.runtime.MessageSender,
  ) => {
    await startupRecovery;
    return handleRecordingControl(message, sender);
  };

  /** One handler per message type; what each answers is fixed by BackgroundContracts. */
  const handlers: {
    [K in BackgroundMessageType]: (
      message: BackgroundRequest<K>,
      sender: Browser.runtime.MessageSender,
    ) => Promise<BackgroundResponse<K>> | BackgroundResponse<K>;
  } = {
    START_RECORDING: (message, sender) => run.lifecycle.startRecording(message, sender),
    STOP_RECORDING: async () => {
      await run.lifecycle.stopRecording();
      return undefined;
    },
    OPEN_EDITOR: (message, sender) =>
      editorOpen!.openEditorForStoredSession(message, editorPlacementFor(message, sender)),
    OPEN_LIBRARY: () => openLibraryPage(),
    REGISTER_EXTENSION_PAGE: (_message, sender) => registerExtensionPage(sender),
    PREFLIGHT_STEP_RECAPTURE_SOURCE_PERMISSION: (message, sender) => run.recapture.preflight(message, sender),
    PREFLIGHT_PROJECT_CONTINUATION_SOURCE_PERMISSION: (message, sender) =>
      preflightProjectContinuation(message, sender),
    START_STEP_RECAPTURE: (message, sender) => run.recapture.start(message, sender),
    CANCEL_STEP_RECAPTURE: (message, sender) => run.recapture.cancel(message, sender),
    ACK_STEP_RECAPTURE_RESULT: (message, sender) => run.recapture.acknowledge(message, sender),
    FOCUS_STEP_RECAPTURE_SOURCE: (message, sender) => run.recapture.focusSource(message, sender),
    PAUSE_RECORDING: handleRecordingControlMessage,
    RESUME_RECORDING: handleRecordingControlMessage,
    UNDO_LAST_CAPTURE: handleRecordingControlMessage,
    RESTORE_LAST_CAPTURE: handleRecordingControlMessage,
    PREPARE_NEXT_SNAPSHOT: handleRecordingControlMessage,
    CREATE_NEXT_SNAPSHOT: handleRecordingControlMessage,
    REBUILD_INVALIDATED_SNAPSHOT: handleRecordingControlMessage,
    SWITCH_TO_SNAPSHOT_MODE: handleRecordingControlMessage,
    SWITCH_TO_STEPS_MODE: handleRecordingControlMessage,
    DISCARD_CURRENT_RECORDING: handleRecordingControlMessage,
    FINISH_RECORDING: handleRecordingControlMessage,
    SNAPSHOT_INVALIDATED: (message, sender) => run.capture.handleSnapshotInvalidated(message, sender),
    SNAPSHOT_RECORDER_FAILED: (message, sender) => run.capture.handleSnapshotRecorderFailure(message, sender),
    HOWBEAM_RECAPTURE_TARGET: async (message, sender) => {
      await startupRecovery;
      return run.recapture.handleTarget(message, sender);
    },
    HOWBEAM_STEP_FRAME_BEGIN: async (message, sender) => {
      await startupRecovery;
      if (!isActiveStepRelaySender(message.runId, sender, 'child')) return { ok: false };
      return stepFrameRelayBroker.begin(message, relaySender(sender));
    },
    HOWBEAM_STEP_FRAME_CLAIM: async (message, sender) => {
      await startupRecovery;
      if (!isActiveStepRelaySender(message.runId, sender, 'top')) return { ok: false };
      return stepFrameRelayBroker.claim(message, relaySender(sender));
    },
    HOWBEAM_STEP_FRAME_REJECT: (message, sender) => stepFrameRelayBroker.reject(message, relaySender(sender)),
    HOWBEAM_STEP_FRAME_SETTLE: (message, sender) => stepFrameRelayBroker.settle(message, relaySender(sender)),
    HOWBEAM_STEP_FRAME_ABORT: (message, sender) => stepFrameRelayBroker.abort(message, relaySender(sender)),
    HOWBEAM_CLICK: async (message, sender) => {
      // A message that woke the worker over a stale persisted run waits for recovery to settle it.
      await startupRecovery;
      return run.capture.handleClick(message, sender);
    },
    HOWBEAM_CANCEL_CAPTURE: (message, sender) => run.capture.handleCancelCapture(message, sender),
    HOWBEAM_READY: (message, sender) => run.capture.handleRecorderReady(message, sender),
    HOWBEAM_RECAPTURE_READY: (message, sender) => run.recapture.handleReady(message, sender),
  };

  /**
   * Routes a validated background message to its handler. It always resolves,
   * with the contract's failure reply when the handler throws, so the
   * onMessage listener can always close the channel with a well-formed result.
   */
  const routeBackgroundMessage = <K extends BackgroundMessageType>(
    message: BackgroundRequest<K>,
    sender: Browser.runtime.MessageSender,
  ): Promise<BackgroundResponse<K>> => {
    const type = message.type as K;
    const handler = handlers[type] as (
      request: BackgroundRequest<K>,
      from: Browser.runtime.MessageSender,
    ) => Promise<BackgroundResponse<K>> | BackgroundResponse<K>;
    return withMessageFailureFallback(
      (async () => handler(message, sender))(),
      `${type} failed`,
      contractFor(type).failure(),
    );
  };

  // Chrome 仍無法可靠支援 onMessage 的 Promise 回覆（crbug.com/40753031）。
  // 回傳 true 並只呼叫一次 sendResponse；格式錯誤或不可信訊息刻意不回覆。
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isBackgroundMessage(message)) return undefined;
    if (isExtensionPageOnlyMessage(message) && !isTrustedExtensionPageSender(sender, browser.runtime.getURL('/'))) {
      console.warn('[howbeam] rejected an untrusted extension control message', message.type);
      return undefined;
    }
    void routeBackgroundMessage(message, sender).then(sendResponse, (error) => {
      console.error('[howbeam] background message handling failed unexpectedly:', describeBrowserError(error), error);
      sendResponse(undefined);
    });
    return true;
  });

  browser.permissions?.onAdded?.addListener((permissions) => {
    if (!permissions.origins?.includes('<all_urls>')) return;
    void run.navigation.resumeAfterSiteAccess().catch((error) => {
      console.error('[howbeam] failed to resume the recording after the permission grant', error);
    });
    void (async () => {
      // The popup parked its start behind the permission dialog, which closed it.
      const pending = await claimPendingStart();
      if (!pending) return;
      await clearCrossTabRecordingDecline();
      const tab = await browser.tabs.get(pending.tabId);
      const result = await run.lifecycle.startRecording(
        {
          type: 'START_RECORDING',
          target: pending.projectId ? { kind: 'project', projectId: pending.projectId } : { kind: 'new' },
          mode: pending.mode,
        },
        {},
        tab,
      );
      if (!result.ok) console.warn('[howbeam] resumed start failed', result.error);
    })().catch((error) => {
      console.error('[howbeam] failed to resume the start after the permission grant', error);
    });
  });

  browser.commands?.onCommand.addListener((command) => {
    void handleCommandShortcut(command).catch((error) => {
      console.error('[howbeam] failed to handle command shortcut', error);
    });
  });

  const handleKeepAlivePort = createKeepAlivePortHandler({
    getRecordingState: async () => {
      await run.actor.ready();
      return toRecordingState(run.actor.state());
    },
    isTrustedKeepAliveSender: (sender, state) =>
      isTrustedKeepAliveSender(sender ?? {}, state, run.navigation.followOriginTabId()),
    acknowledgeDisconnect: () => void browser.runtime.lastError,
    onConnected: recorderConnections.connected,
    onDisconnected: recorderConnections.disconnected,
    onReply: recorderConnections.replied,
  });
  browser.runtime.onConnect.addListener(handleKeepAlivePort);

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void (async () => {
      // A recapture's source tab is the recapture's to handle.
      if (await run.recapture.handleSourceTabUpdated(tabId, changeInfo)) return;
      await run.navigation.handleTabUpdated(tabId, changeInfo, tab);
    })().catch((error) => {
      console.error('[howbeam] failed to handle recorded tab update', error);
    });
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    run.navigation.scheduleFollow(tabId);
  });

  // Cross-window switches raise no tabs.onActivated; follow the newly focused
  // window's active tab instead. WINDOW_ID_NONE (-1) means focus left Chrome.
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId == null || windowId < 0) return;
    void browser.tabs
      .query({ active: true, windowId })
      .then(([tab]) => {
        if (tab?.id != null) run.navigation.scheduleFollow(tab.id);
      })
      .catch((error) => {
        console.warn('[howbeam] failed to inspect the focused window', error);
      });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      // Unconditionally first: a closed extension page must stop being the tab
      // that later opens reuse, whatever else this removal means.
      await forgetClosedExtensionPage(tabId);
      if (await run.recapture.handleSourceTabRemoved(tabId)) return;
      await run.lifecycle.recordedTabGone(tabId);
    })().catch((error) => {
      console.error('[howbeam] failed to handle recorded tab removal', error);
    });
  });
});
