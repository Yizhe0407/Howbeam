import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { createRegionCapture, type RegionCapture } from '@/lib/capture/region-capture';
import RecordingToolbar from '@/lib/recording/recording-toolbar';
import {
  buildShieldTokenStorageKey,
  isSnapshotShieldTokenRecord,
  isSnapshotShieldFrameMessage,
  isSnapshotShieldInitMessage,
  SNAPSHOT_SHIELD_CANDIDATES,
  SNAPSHOT_SHIELD_CAPTURE_COMPLETE,
  SNAPSHOT_SHIELD_COMMIT,
  SNAPSHOT_SHIELD_CONTROL,
  SNAPSHOT_SHIELD_CONTROL_RESULT,
  SNAPSHOT_SHIELD_POINTER_DOWN,
  SNAPSHOT_SHIELD_POINTER_MOVE,
  SNAPSHOT_SHIELD_PREVIEW,
  SNAPSHOT_SHIELD_READY,
  SNAPSHOT_SHIELD_REGION_CAPTURE,
  SNAPSHOT_SHIELD_TOOLBAR_STATE,
  SNAPSHOT_SHIELD_UNDO,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldRect,
  type SnapshotShieldPortMessage,
  type WithoutToken,
} from '@/lib/recording/snapshot-shield-protocol';
import {
  RECORDING_CONTROL_TIMEOUT_MS,
  SNAPSHOT_FREEZE_EVENTS,
} from '@/lib/recording/content-script-constants';
import type { RecordingControlMessage, RecordingControlResult } from '@/lib/runtime/messages';
import { featureFlags } from '@/lib/shared/feature-flags';
import { nextCandidateIndex } from '@/lib/capture/snapshot-candidates';
import { isDocumentScrollingKey } from '@/lib/recording/recording-guards';
import { createOverlay } from './overlay';
import { createHoverScheduler } from './hover-scheduler';
import { localizeDocument, onLocaleChange, t } from '@/lib/shared/i18n';
import { initLocalePreference } from '@/lib/runtime/locale-preference';

const SHIELD_HOVER_TIMEOUT_MS = 4_000;
const SHIELD_CAPTURE_TIMEOUT_MS = 30_000;
/** Clicks held while the shield is not ready to annotate yet (before its first
 * recording state) or busy with the previous annotation. */
const MAX_QUEUED_POINTS = 16;
function shieldChannelFailure(): RecordingControlResult {
  return { ok: false, error: t().runtime.recordingChannelLost };
}

localizeDocument(t().page.snapshotShield);
onLocaleChange(() => localizeDocument(t().page.snapshotShield));
void initLocalePreference();

// Same freeze list as the frozen page, except pointerdown (its own handler
// consumes selectively) and submit (nothing here can host a form submission).
const FREEZE_EVENTS = SNAPSHOT_FREEZE_EVENTS.filter(
  (type) => type !== 'pointerdown' && type !== 'submit',
);

// The frame URL only carries a public frame key; the secret init token is fetched
// from extension storage (frame URLs leak via resource timing, so a URL-borne
// token would let page scripts race the handshake and hijack the channel).
const frameKey = new URL(location.href).searchParams.get('frame');
let expectedToken: string | null = null;
let initialized = false;
const MAX_PENDING_INIT_EVENTS = 8;
let pendingInitEvents: MessageEvent[] | null = [];

function consume(event: Event): void {
  if (
    event.target instanceof Element &&
    event.target.closest('[data-howbeam-shield-toolbar],[data-howbeam-region-capture]')
  ) {
    return;
  }
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function ensureKeyboardFocus(): void {
  if (!document.hasFocus()) window.focus();
}

function tryInitialize(event: MessageEvent): void {
  const token = expectedToken;
  if (initialized || !token || event.source !== parent || !isSnapshotShieldInitMessage(event.data, token)) return;
  const port = event.ports[0];
  if (!port) return;
  initialized = true;
  const theme = event.data.theme;
  const overlay = createOverlay();
  const toolbarContainer = document.createElement('div');
  toolbarContainer.setAttribute('data-howbeam-shield-toolbar', '');
  document.body.append(toolbarContainer);
  const toolbarRoot = createRoot(toolbarContainer);
  interface PendingControl {
    resolve: (result: RecordingControlResult) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
  const pendingControls = new Map<number, PendingControl>();
  let channelFailed = false;
  let controlSequence = 0;
  let capturing = false;
  // Monotonic capture generation: completions and timeouts only settle the
  // capture they were armed for, never a newer one started after a timeout.
  let captureSequence = 0;
  let activeCaptureId = 0;
  let interactionsEnabled = false;
  let lastPreviewRect: SnapshotShieldRect | null = null;
  let lastCommitViaKeyboard = false;
  let keyboardAnchors: SnapshotShieldKeyboardAnchor[] = [];
  let keyboardIndex = -1;
  let focusInitialized = false;
  let regionCapture: RegionCapture | null = null;
  let pendingRegionCompletion: (() => void) | null = null;
  let lastCommitWasRegion = false;
  let captureTimeout: ReturnType<typeof setTimeout> | null = null;
  let toolbarState: import('@/lib/recording/recording-toolbar').RecordingToolbarState | null = null;
  // A click is never dropped for arriving too early or too fast: it waits
  // here until the recording state arrives or the previous annotation is done,
  // then commits at the point the user actually clicked.
  const queuedPoints: Array<{ clientX: number; clientY: number }> = [];

  const safePostToParent = (message: SnapshotShieldPortMessage): boolean => {
    if (channelFailed) return false;
    try {
      port.postMessage(message);
      return true;
    } catch (error) {
      console.error('[howbeam] snapshot shield channel failed', error);
      failShieldChannel();
      return false;
    }
  };
  /** Injects this page's channel token so call sites only spell out the
   * message-specific fields. */
  const post = (message: WithoutToken<SnapshotShieldPortMessage>): boolean =>
    safePostToParent({ ...message, token } as SnapshotShieldPortMessage);

  const hover = createHoverScheduler({
    isEnabled: () => interactionsEnabled,
    isCapturing: () => capturing,
    post: (request) => {
      post({ type: SNAPSHOT_SHIELD_POINTER_MOVE, ...request });
    },
    hoverTimeoutMs: SHIELD_HOVER_TIMEOUT_MS,
  });

  const clearCaptureTimeout = () => {
    if (captureTimeout !== null) clearTimeout(captureTimeout);
    captureTimeout = null;
  };

  const armCaptureTimeout = (captureId: number) => {
    clearCaptureTimeout();
    captureTimeout = setTimeout(() => {
      captureTimeout = null;
      if (captureId !== activeCaptureId) return;
      capturing = false;
      lastCommitViaKeyboard = false;
      lastCommitWasRegion = false;
      pendingRegionCompletion?.();
      pendingRegionCompletion = null;
      hover.invalidateSentRevision();
      announce(t().shield.captureTimedOut);
      if (interactionsEnabled && !regionCapture?.isActive()) hover.schedule();
      drainQueuedPoints();
    }, SHIELD_CAPTURE_TIMEOUT_MS);
  };

  const settlePendingControl = (requestId: number, result: RecordingControlResult) => {
    const pending = pendingControls.get(requestId);
    if (!pending) return;
    pendingControls.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  };

  const failShieldChannel = () => {
    if (channelFailed) return;
    channelFailed = true;
    queuedPoints.length = 0;
    for (const requestId of pendingControls.keys()) settlePendingControl(requestId, shieldChannelFailure());
    pendingRegionCompletion?.();
    pendingRegionCompletion = null;
    clearCaptureTimeout();
    regionCapture?.cancel('removed');
    regionCapture = null;
    capturing = false;
    interactionsEnabled = false;
    clearHover();
    resetKeyboard();
    toolbarState = null;
    renderToolbar();
  };

  const clearHover = () => {
    hover.clear();
    overlay.preview(null);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (regionCapture?.isActive()) return;
    if (!interactionsEnabled) {
      clearHover();
      return;
    }
    // Over the toolbar the highlight freezes on its last target instead of clearing,
    // since reaching undo/crop crosses the frozen page and would drop the aimed box.
    if (event.target instanceof Element && event.target.closest('[data-howbeam-shield-toolbar]')) return;
    ensureKeyboardFocus();
    hover.pointerMove(event.clientX, event.clientY);
  };

  const commitAt = (clientX: number, clientY: number, viaKeyboard: boolean) => {
    if (!interactionsEnabled || capturing) return;
    capturing = true;
    activeCaptureId = ++captureSequence;
    lastCommitViaKeyboard = viaKeyboard;
    hover.beginCapture(clientX, clientY);
    overlay.preview(null);
    lastPreviewRect = null;
    armCaptureTimeout(activeCaptureId);
    const posted = post({
      type: SNAPSHOT_SHIELD_POINTER_DOWN,
      captureId: activeCaptureId,
      clientX,
      clientY,
    });
    if (!posted) clearCaptureTimeout();
  };

  /** Whether a click arriving now can still become an annotation later: the
   * shield has not heard its first recording state yet (phase unknown or still
   * starting), or an annotation is in flight. */
  const canQueuePoint = () =>
    !channelFailed &&
    (toolbarState === null || toolbarState.phase === 'starting' || (interactionsEnabled && capturing));

  const drainQueuedPoints = () => {
    if (!interactionsEnabled || capturing || regionCapture?.isActive()) return;
    const next = queuedPoints.shift();
    if (next) commitAt(next.clientX, next.clientY, false);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (regionCapture?.isActive()) return;
    if (
      event.target instanceof Element &&
      event.target.closest('[data-howbeam-shield-toolbar],[data-howbeam-region-capture]')
    ) {
      return;
    }
    consume(event);
    ensureKeyboardFocus();
    if (event.button !== 0 || !event.isPrimary) return;
    if (interactionsEnabled && !capturing) {
      commitAt(event.clientX, event.clientY, false);
      return;
    }
    if (canQueuePoint() && queuedPoints.length < MAX_QUEUED_POINTS) {
      queuedPoints.push({ clientX: event.clientX, clientY: event.clientY });
    }
  };

  const onScrollKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isDocumentScrollingKey(event.key, event.target)) return;
    // Only the browser's scroll is cancelled; the event still reaches the
    // toolbar and the traversal handler below.
    event.preventDefault();
  };

  // Keyboard-only annotation traversal (§9.5). Roving over the parent-supplied
  // candidate anchors reuses the same probe/preview/commit engine as pointing.
  let liveRegion: HTMLElement | null = null;

  const announce = (message: string) => {
    if (liveRegion) liveRegion.textContent = message;
  };

  const focusToolbar = () => {
    const control = toolbarContainer.querySelector<HTMLElement>('button, [tabindex]');
    control?.focus();
  };

  const sendShieldControl = (
    action: RecordingControlMessage['type'],
    undoToken?: string,
  ): Promise<RecordingControlResult> => {
    const requestId = ++controlSequence;
    return new Promise<RecordingControlResult>((resolve) => {
      const timeout = setTimeout(
        () => settlePendingControl(requestId, shieldChannelFailure()),
        RECORDING_CONTROL_TIMEOUT_MS,
      );
      pendingControls.set(requestId, { resolve, timeout });
      const posted = post({
        type: SNAPSHOT_SHIELD_CONTROL,
        requestId,
        action,
        ...(undoToken ? { undoToken } : {}),
      });
      if (!posted) settlePendingControl(requestId, shieldChannelFailure());
    });
  };

  const renderToolbar = () => {
    const state = toolbarState;
    toolbarRoot.render(
      state && (state.phase === 'recording' || state.phase === 'invalidated' || state.phase === 'finishing') ? (
        <RecordingToolbar
          state={state}
          onCommand={(action: RecordingControlMessage['type'], undoToken?: string) =>
            sendShieldControl(action, undoToken)
          }
          onStartRegionCapture={() => startRegionCapture()}
          regionCaptureActive={regionCapture?.isActive() ?? false}
          theme={theme}
        />
      ) : null,
    );
  };

  const startRegionCapture = () => {
    if (!interactionsEnabled || capturing || regionCapture?.isActive()) return;
    clearHover();
    resetKeyboard();
    document.body.classList.add('has-region-capture');
    const controller = createRegionCapture({
      settleFrames: 0,
      onCapture: async (rect) => {
        if (!interactionsEnabled || capturing) return;
        capturing = true;
        activeCaptureId = ++captureSequence;
        lastCommitWasRegion = true;
        await new Promise<void>((resolve) => {
          pendingRegionCompletion = resolve;
          armCaptureTimeout(activeCaptureId);
          const posted = post({
            type: SNAPSHOT_SHIELD_REGION_CAPTURE,
            captureId: activeCaptureId,
            rect,
          });
          if (!posted) clearCaptureTimeout();
        });
      },
      onCancel: () => {
        pendingRegionCompletion?.();
        pendingRegionCompletion = null;
        clearCaptureTimeout();
        lastCommitWasRegion = false;
        capturing = false;
      },
      onClose: () => {
        if (regionCapture === controller) regionCapture = null;
        document.body.classList.remove('has-region-capture');
        renderToolbar();
        if (interactionsEnabled && !capturing) hover.schedule();
        drainQueuedPoints();
      },
    });
    regionCapture = controller;
    renderToolbar();
  };

  const roveTo = (delta: number) => {
    if (!keyboardAnchors.length) {
      announce(t().shield.noKeyboardTargets);
      return;
    }
    // Leave any focused control so Enter commits the candidate instead of activating it;
    // the iframe keeps document focus.
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    keyboardIndex = nextCandidateIndex(keyboardIndex, keyboardAnchors.length, delta);
    const anchor = keyboardAnchors[keyboardIndex];
    if (!anchor) return;
    hover.setAnchor(anchor.x, anchor.y);
    announce(t().shield.candidate(keyboardIndex + 1, keyboardAnchors.length, anchor.label || t().shield.unnamedElement));
  };

  const commitCurrent = () => {
    const anchor = keyboardAnchors[keyboardIndex];
    if (!anchor) return;
    if (lastPreviewRect === null) {
      announce(t().shield.cannotAnnotate);
      return;
    }
    commitAt(anchor.x, anchor.y, true);
  };

  const resetKeyboard = () => {
    keyboardIndex = -1;
  };

  // Unlike consume(), always prevents default: these keys are fully owned by the traversal,
  // so a focused control (exempt from consume) must not also fire natively.
  const stopEvent = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onShieldKeyDown = (event: KeyboardEvent) => {
    // The region controller is registered later on the same capture target; do
    // not let keyboard traversal consume Escape before the controller sees it.
    if (regionCapture?.isActive()) return;
    if (!featureFlags.snapshotKeyboardNav) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-howbeam-shield-toolbar]')) return;
    if (event.key === 'Escape') {
      if (!liveRegion) return;
      // Escape leaves candidate traversal and hands the keyboard to the recording controls.
      stopEvent(event);
      resetKeyboard();
      overlay.preview(null);
      focusToolbar();
      return;
    }
    if (!interactionsEnabled || capturing) return;
    switch (event.key) {
      case 'Tab':
        stopEvent(event);
        roveTo(event.shiftKey ? -1 : 1);
        return;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        stopEvent(event);
        commitCurrent();
        return;
      case 'Delete':
      case 'Backspace':
        stopEvent(event);
        void sendShieldControl('UNDO_LAST_CAPTURE');
        return;
    }
  };

  if (featureFlags.snapshotKeyboardNav) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'snapshot-live-region';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.append(liveRegion);
  }

  port.onmessage = (event) => {
    if (!isSnapshotShieldFrameMessage(event.data, token)) return;
    if (event.data.type === SNAPSHOT_SHIELD_PREVIEW) {
      const outcome = hover.resolvePreview({ requestId: event.data.requestId });
      if (outcome === 'ignored') return;
      if (outcome === 'accepted') {
        lastPreviewRect = event.data.rect;
        overlay.preview(event.data.rect);
      }
      hover.schedule();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CANDIDATES) {
      keyboardAnchors = event.data.anchors;
      keyboardIndex = -1;
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_COMMIT) {
      overlay.commit(event.data.selection);
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_UNDO) {
      overlay.undo();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_TOOLBAR_STATE) {
      const state = event.data.state;
      toolbarState = state;
      interactionsEnabled = state.phase === 'recording';
      // Clicks queued before the run could take annotations only survive a
      // run that is still starting up; any other non-recording phase means
      // they were made on a snapshot that will never accept them.
      if (!interactionsEnabled && state.phase !== 'starting') queuedPoints.length = 0;
      if (!interactionsEnabled) {
        regionCapture?.cancel(state.phase === 'invalidated' ? 'viewport' : 'removed');
        capturing = false;
        clearCaptureTimeout();
        clearHover();
        resetKeyboard();
      }
      renderToolbar();
      // Give the shield document keyboard focus once, so the first Tab enters the
      // candidate list rather than being swallowed by the frozen page.
      if (interactionsEnabled && !focusInitialized) {
        focusInitialized = true;
        ensureKeyboardFocus();
      }
      drainQueuedPoints();
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CONTROL_RESULT) {
      settlePendingControl(event.data.requestId, event.data.result);
      return;
    }
    if (event.data.type === SNAPSHOT_SHIELD_CAPTURE_COMPLETE) {
      if (event.data.captureId !== activeCaptureId || !capturing) {
        // A stale completion (its timeout already fired, or a newer capture owns the
        // flow): its annotation may still commit to the overlay, but it must not
        // settle the current capture or run a pendingRegionCompletion it doesn't own.
        if (event.data.selection) overlay.commit(event.data.selection);
        return;
      }
      if (event.data.selection) {
        overlay.commit(event.data.selection);
        if (lastCommitWasRegion) {
          const label = event.data.selection.label;
          announce(t().shield.regionAdded(label));
        } else if (lastCommitViaKeyboard) {
          const label = event.data.selection.label;
          announce(t().shield.annotationAdded(label));
        }
      } else if (lastCommitWasRegion) {
        announce(t().shield.regionNotCreated);
      } else if (lastCommitViaKeyboard) {
        announce(t().shield.annotationNotCreated);
      }
      lastCommitViaKeyboard = false;
      lastCommitWasRegion = false;
      capturing = false;
      clearCaptureTimeout();
      pendingRegionCompletion?.();
      pendingRegionCompletion = null;
      hover.invalidateSentRevision();
      if (interactionsEnabled && !regionCapture?.isActive()) hover.schedule();
      drainQueuedPoints();
    }
  };

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('pointerout', (event) => {
    if (!event.relatedTarget) clearHover();
  }, { capture: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  // Registered ahead of every other key handler, blind to the toolbar exemption
  // below: a scrolling key that reaches the browser scrolls the frozen page
  // under this frame, which invalidates the whole run.
  window.addEventListener('keydown', onScrollKeyDown, { capture: true, passive: false });
  window.addEventListener('keydown', onShieldKeyDown, { capture: true, passive: false });
  for (const type of FREEZE_EVENTS) {
    window.addEventListener(type, consume, { capture: true, passive: false });
  }
  window.addEventListener('resize', () => {
    // A resize invalidates both hit targets and the collision layout.
    regionCapture?.cancel('viewport');
    clearHover();
    overlay.relayout();
  });
  port.onmessageerror = failShieldChannel;
  port.start();

  post({ type: SNAPSHOT_SHIELD_READY });
}

window.addEventListener('message', (event) => {
  if (initialized) return;
  if (expectedToken === null) {
    // Init can arrive before the token read resolves; keep a bounded buffer
    // of parent-sourced candidates and replay them once the token is known.
    if (pendingInitEvents && event.source === parent && pendingInitEvents.length < MAX_PENDING_INIT_EVENTS) {
      pendingInitEvents.push(event);
    }
    return;
  }
  tryInitialize(event);
});

void (async () => {
  if (!frameKey) return;
  const storageKey = buildShieldTokenStorageKey(frameKey);
  try {
    const stored = await browser.storage.local.get(storageKey);
    const record = stored[storageKey];
    // Single use: consume the record immediately so it cannot be replayed.
    void browser.storage.local.remove(storageKey).catch(() => undefined);
    if (!isSnapshotShieldTokenRecord(record)) return;
    expectedToken = record.token;
  } catch (error) {
    console.error('[howbeam] failed to load the snapshot shield init token', error);
    return;
  }
  const queued = pendingInitEvents ?? [];
  pendingInitEvents = null;
  for (const event of queued) {
    if (initialized) break;
    tryInitialize(event);
  }
})();
