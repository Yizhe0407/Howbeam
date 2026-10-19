import { browser } from 'wxt/browser';
import { type Bounds } from '../storage/models';
import { isElementVisuallyUnavailable } from '../capture/selector/element-availability';
import { getVisibleHighlightBounds } from '../capture/selector/highlight-bounds';
import { isInteractiveElement } from '../capture/selector/interactive-element';
import { ACTIVATION_TARGETING_POLICY, resolveVisualTargetAtPoint } from '../capture/selector/visual-target';
import { intersectBounds } from '../capture/bounds-geometry';
import { createFrameCoordinateMapper } from '../capture/frame-geometry';
import {
  createFrameProbeRateLimiter,
  type FrameProbeRateLimiter,
} from '../capture/frame-probe';
import { createLateClickSuppressor } from '../capture/step-capture';
import { createStepGestureQueue, type StepGesture } from '../capture/step-gesture-queue';
import { STEP_PRESS_GATE_EVENTS, createStepPressGate, type StepPress } from '../capture/step-press-gate';
import { describeElement } from '../capture/element-description';
import {
  isInScrollbarGutter,
  isPointInAnyScrollGutter,
} from './recording-guards';
import { onRecordingStateChange } from '../storage/storage';
import {
  CAPTURE_FAILSAFE_MS,
  CLEANUP_EVENT,
  SNAPSHOT_FREEZE_EVENTS,
  STEP_LATE_CLICK_SUPPRESS_MS,
} from './content-script-constants';
import { isFiniteRect } from '../shared/validation';
import type {
  HowbeamStepFrameResultMessage,
  HowbeamStopMessage,
  StepFrameRelayAbortMessage,
  StepFrameRelayBeginMessage,
  StepFrameRelayBeginResult,
  StepFrameRelayClaimResult,
  StepFrameRelayMutationResult,
  StepFrameRelayRejectMessage,
} from '../runtime/messages';

/**
 * Child-frame step recording uses two channels with deliberately different
 * trust contracts:
 *
 * - browser.runtime authenticates the originating extension content script,
 *   binds an opaque one-time token to the active run/frame, and returns replay
 *   results directly to that frame;
 * - window.postMessage carries only the token plus hop-local geometry so each
 *   parent can map the rect through its own iframe element.
 *
 * Page scripts can observe or forge the second channel, but cannot mint the
 * first channel's authorization. The top frame consumes the token with the
 * background before it requests a screenshot, and a private replacement token
 * is used for settlement. Synthetic page events are rejected at the trusted
 * pointer boundary as an additional invariant.
 */

const STEP_FRAME_COORDINATE_LIMIT = 1_000_000;
/** Slightly above the top frame's CAPTURE_FAILSAFE_MS so a healthy capture
 * always beats this local budget; when the relay chain is broken the click is
 * replayed anyway to keep the page usable. Exported so the top frame can tell
 * whether a hop sitting in its own gesture queue has already outlasted the
 * budget the sending child armed independently — see StepFrameHopPayload's
 * originTimestamp. */
export const STEP_FRAME_CLICK_FAILSAFE_MS = CAPTURE_FAILSAFE_MS + 500;
const STEP_FRAME_RELAY_MAX_CONCURRENT = 8;
const STEP_FRAME_RELAY_MAX_REQUESTS_PER_WINDOW = 90;
const STEP_FRAME_RELAY_RATE_WINDOW_MS = 10_000;
const MAX_SHADOW_SCAN_DEPTH = 8;
const RUNTIME_ID_LIMIT = 128;
const STEP_FRAME_TEXT_LIMIT = 200;
const STEP_FRAME_TAG_LIMIT = 100;

export function stepFrameClickMessageType(runtimeId: string): string {
  return `howbeam_step_frame_click_${runtimeId}`;
}

export function snapshotFrameScrollPingType(runtimeId: string): string {
  return `howbeam_snapshot_frame_scroll_${runtimeId}`;
}

/** Page-visible payload; metadata stays in the background authorization. */
export interface StepFrameHopPayload {
  type: string;
  captureId: string;
  relayToken: string;
  /** Target rect in the SENDING frame's viewport coordinates. */
  rect: Bounds;
  /** `Date.now()` when the ORIGINATING child frame armed its own
   * STEP_FRAME_CLICK_FAILSAFE_MS budget for this gesture — not touched by
   * any relay hop in between. Lets a queue anywhere along the relay chain
   * tell whether the originating child has already given up and replayed on
   * its own before spending a claim on a hop that's now pointless. */
  originTimestamp: number;
}

function isRelayRect(value: unknown): value is Bounds {
  return isFiniteRect(value, { maxMagnitude: STEP_FRAME_COORDINATE_LIMIT });
}

function isBoundedRuntimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= RUNTIME_ID_LIMIT;
}

export function isStepFrameHopPayload(value: unknown, messageType: string): value is StepFrameHopPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<StepFrameHopPayload>;
  return (
    payload.type === messageType &&
    isBoundedRuntimeId(payload.captureId) &&
    isBoundedRuntimeId(payload.relayToken) &&
    isRelayRect(payload.rect) &&
    typeof payload.originTimestamp === 'number' &&
    Number.isFinite(payload.originTimestamp)
  );
}

export function isStepFrameRelayBeginResult(value: unknown): value is StepFrameRelayBeginResult {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') return false;
  const result = value as { ok: boolean; relayToken?: unknown };
  return result.ok ? isBoundedRuntimeId(result.relayToken) : result.relayToken === undefined;
}

export function isStepFrameRelayClaimResult(value: unknown): value is StepFrameRelayClaimResult {
  if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') return false;
  const result = value as {
    ok: boolean;
    settleToken?: unknown;
    target?: { text?: unknown; tagName?: unknown; interactive?: unknown };
  };
  if (!result.ok) return result.settleToken === undefined && result.target === undefined;
  return (
    isBoundedRuntimeId(result.settleToken) &&
    Boolean(result.target) &&
    typeof result.target?.text === 'string' &&
    result.target.text.length <= STEP_FRAME_TEXT_LIMIT &&
    typeof result.target.tagName === 'string' &&
    result.target.tagName.length > 0 &&
    result.target.tagName.length <= STEP_FRAME_TAG_LIMIT &&
    typeof result.target.interactive === 'boolean'
  );
}

export function isStepFrameRelayMutationResult(value: unknown): value is StepFrameRelayMutationResult {
  return Boolean(value && typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean');
}

export function isHowbeamStepFrameResultMessage(value: unknown): value is HowbeamStepFrameResultMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<HowbeamStepFrameResultMessage>;
  return (
    message.type === 'HOWBEAM_STEP_FRAME_RESULT' &&
    isBoundedRuntimeId(message.runId) &&
    isBoundedRuntimeId(message.captureId) &&
    typeof message.replay === 'boolean'
  );
}

function findIframeInNode(root: ParentNode, source: unknown, depth: number): HTMLIFrameElement | null {
  for (const frame of root.querySelectorAll('iframe')) {
    if ((frame as HTMLIFrameElement).contentWindow === source) return frame as HTMLIFrameElement;
  }
  if (depth >= MAX_SHADOW_SCAN_DEPTH) return null;
  for (const host of root.querySelectorAll('*')) {
    const shadow = host.shadowRoot;
    if (!shadow) continue;
    const found = findIframeInNode(shadow, source, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Locates the direct iframe browsing context that supplied hop geometry. This
 * is a routing check only; authorization is consumed separately through the
 * extension runtime/background broker. */
export function findIframeForWindow(source: unknown): HTMLIFrameElement | null {
  if (!source || source === window) return null;
  return findIframeInNode(document, source, 0);
}

/** Maps a rect from a child frame's viewport into this frame's viewport and
 * clips it to the visible portion of the iframe. Returns null when nothing
 * remains visible (hidden, collapsed, or fully clipped frames). */
function mapChildRectIntoFrameViewport(frame: HTMLIFrameElement, rect: Bounds): Bounds | null {
  if (isElementVisuallyUnavailable(frame)) return null;
  const mapper = createFrameCoordinateMapper(frame);
  if (!mapper) return null;
  const mapped = mapper.toParentBounds(rect);
  const visibleFrame = getVisibleHighlightBounds(
    frame,
    mapped.x + mapped.width / 2,
    mapped.y + mapped.height / 2,
  );
  if (!visibleFrame) return null;
  return intersectBounds(mapped, visibleFrame);
}

export interface RelayedStepFrameHop {
  payload: StepFrameHopPayload;
  /** The direct child iframe (in this document) that supplied this hop. */
  frame: HTMLIFrameElement;
  /** Payload rect mapped into this frame's viewport; null when the sending
   * iframe is not visible here. */
  rect: Bounds | null;
}

/** Validates and maps page-visible geometry. Authorization is intentionally
 * not inferred from MessageEvent.source; the top frame separately claims the
 * opaque token through browser.runtime before capture. */
export function resolveRelayedStepFrameHop(
  event: MessageEvent,
  messageType: string,
  limiter: FrameProbeRateLimiter,
): RelayedStepFrameHop | null {
  if (!event.isTrusted || !isStepFrameHopPayload(event.data, messageType)) return null;
  const release = limiter.tryAcquire();
  if (!release) return null;
  // Admission control bounds request volume and the O(document) frame scan.
  release();
  const frame = findIframeForWindow(event.source);
  if (!frame) return null;
  return { payload: event.data, frame, rect: mapChildRectIntoFrameViewport(frame, event.data.rect) };
}

export function createStepFrameRelayLimiter(): FrameProbeRateLimiter {
  return createFrameProbeRateLimiter({
    maxConcurrent: STEP_FRAME_RELAY_MAX_CONCURRENT,
    maxRequestsPerWindow: STEP_FRAME_RELAY_MAX_REQUESTS_PER_WINDOW,
    windowMs: STEP_FRAME_RELAY_RATE_WINDOW_MS,
  });
}

/**
 * Installs the step recorder for one child frame. A trusted pointerdown is
 * swallowed locally, authenticated with the background, and then sent upward
 * as geometry-only hops. Replay arrives over browser.runtime, never over a
 * page-visible MessagePort.
 */
export function installStepFrameRecorder(runId: string, initiallyPaused: boolean): void {
  if (window.top === window) return;
  const clickType = stepFrameClickMessageType(browser.runtime.id);
  let paused = initiallyPaused;
  let removed = false;
  let activeCaptureId: string | null = null;
  let settleActiveRelay: ((replay: boolean) => void) | null = null;
  const lateClicks = createLateClickSuppressor<Element>(STEP_LATE_CLICK_SUPPRESS_MS);
  const relayLimiter = createStepFrameRelayLimiter();
  const gestureQueue = createStepGestureQueue();
  const pressGate = createStepPressGate({ lateClicks, isBusy: () => gestureQueue.isBusy() });

  const abortRelay = (captureId: string) => {
    void browser.runtime.sendMessage({
      type: 'HOWBEAM_STEP_FRAME_ABORT',
      runId,
      captureId,
    } satisfies StepFrameRelayAbortMessage).catch(() => {});
  };

  /** Runs one gesture's BEGIN -> postMessage hop -> await settlement chain.
   * Resolves once settled, by whichever of three paths gets there first: the
   * background/top-frame answering over browser.runtime, this frame's own
   * failsafe giving up, or the relay attempt failing outright. */
  const runChildGesture = async (gesture: StepGesture, press: StepPress): Promise<void> => {
    const kind = await Promise.race([press.outcome, gesture.cancelled.then(() => 'cancel' as const)]);
    if (kind !== 'click') {
      // Drags, selections and browser-taken gestures already reached the
      // page natively; nothing is relayed or replayed.
      pressGate.abandon(press);
      gesture.release();
      return;
    }
    const el = press.target;
    const rect = getVisibleHighlightBounds(el, press.clientX, press.clientY);
    if (!rect) {
      gesture.release();
      pressGate.replay(press);
      return;
    }

    return new Promise<void>((resolveGesture) => {
      const captureId = gesture.captureId;
      activeCaptureId = captureId;
      let settled = false;
      let failsafe: ReturnType<typeof setTimeout> | null = null;
      const settle = (replay: boolean) => {
        if (settled || activeCaptureId !== captureId) return;
        settled = true;
        if (failsafe !== null) clearTimeout(failsafe);
        failsafe = null;
        settleActiveRelay = null;
        activeCaptureId = null;
        gesture.release();
        if (!removed && !gesture.isCancelled() && replay) pressGate.replay(press);
        resolveGesture();
      };
      settleActiveRelay = settle;
      failsafe = setTimeout(() => {
        abortRelay(captureId);
        settle(true);
      }, STEP_FRAME_CLICK_FAILSAFE_MS);

      void (async () => {
        let result: unknown;
        try {
          result = await browser.runtime.sendMessage({
            type: 'HOWBEAM_STEP_FRAME_BEGIN',
            runId,
            captureId,
            rect,
            text: describeElement(el),
            tagName: el.tagName.toLowerCase(),
            interactive: isInteractiveElement(el),
          } satisfies StepFrameRelayBeginMessage);
        } catch {
          settle(true);
          return;
        }
        if (!isStepFrameRelayBeginResult(result) || !result.ok) {
          settle(true);
          return;
        }
        if (settled || removed || gesture.isCancelled() || activeCaptureId !== captureId) {
          abortRelay(captureId);
          settle(false);
          return;
        }
        const payload: StepFrameHopPayload = {
          type: clickType,
          captureId,
          relayToken: result.relayToken,
          rect,
          originTimestamp: Date.now(),
        };
        try {
          window.parent.postMessage(payload, '*');
        } catch {
          abortRelay(captureId);
          settle(true);
        }
      })();
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isTrusted) return;
    // Trusted events are ordered: this press ends the previous press and the
    // previous gesture's trailing-click era, so a real rapid second click
    // remains deliverable.
    pressGate.onTrustedPointerDown();
    lateClicks.onTrustedPointerDown();
    if (event.button !== 0 || !event.isPrimary) return;
    if (paused) return;
    if (isInScrollbarGutter(event.clientX, event.clientY, document.documentElement)) return;
    if (isPointInAnyScrollGutter(event.clientX, event.clientY)) return;
    const el = resolveVisualTargetAtPoint(
      event.clientX,
      event.clientY,
      ACTIVATION_TARGETING_POLICY,
    )?.element ?? null;
    if (!el) return;

    // Same contract as the top frame: page scripts stop seeing the press,
    // the browser's default actions still run, and release decides whether
    // it is a click to relay or a drag to leave alone.
    const begun = pressGate.begin(event, el);
    if (begun.kind === 'continuation') return;
    const { press } = begun;
    gestureQueue.enqueue({
      captureId: crypto.randomUUID(),
      validate: () => el.isConnected,
      onSkipped: () => pressGate.abandon(press),
      start: (gesture) => runChildGesture(gesture, press),
    });
  };

  const onFollowup = (event: Event) => pressGate.handleEvent(event);
  const onBlur = () => pressGate.handleBlur();

  const rejectRelay = (payload: StepFrameHopPayload) => {
    void browser.runtime.sendMessage({
      type: 'HOWBEAM_STEP_FRAME_REJECT',
      runId,
      captureId: payload.captureId,
      relayToken: payload.relayToken,
    } satisfies StepFrameRelayRejectMessage).catch(() => {});
  };

  const onRelayMessage = (event: MessageEvent) => {
    const relayed = resolveRelayedStepFrameHop(event, clickType, relayLimiter);
    if (!relayed) return;
    if (relayed.rect === null) {
      rejectRelay(relayed.payload);
      return;
    }
    try {
      window.parent.postMessage({ ...relayed.payload, rect: relayed.rect } satisfies StepFrameHopPayload, '*');
    } catch {
      rejectRelay(relayed.payload);
    }
  };

  const onRuntimeMessage = (message: unknown) => {
    if ((message as HowbeamStopMessage | null)?.type === 'HOWBEAM_STOP') {
      cleanup();
      return;
    }
    if (
      isHowbeamStepFrameResultMessage(message) &&
      message.runId === runId &&
      message.captureId === activeCaptureId
    ) {
      settleActiveRelay?.(message.replay);
    }
  };

  let unsubscribe = () => {};
  function cleanup() {
    if (removed) return;
    removed = true;
    lateClicks.clear();
    if (activeCaptureId) abortRelay(activeCaptureId);
    // Matches the pre-queue behavior for whatever is actively relaying: just
    // drop the raw state so its BEGIN-response/failsafe continuation becomes
    // a no-op (`activeCaptureId` no longer matches) instead of forcing an
    // early settlement. purgePending() is the actual fix here — it replays
    // every queued-but-not-started press (already preventDefault()'d at
    // pointerdown time) without recording it, instead of leaving it to hang.
    settleActiveRelay = null;
    activeCaptureId = null;
    gestureQueue.cancelActive();
    gestureQueue.purgePending();
    pressGate.clear();
    document.removeEventListener('pointerdown', onPointerDown, { capture: true });
    for (const type of STEP_PRESS_GATE_EVENTS) document.removeEventListener(type, onFollowup, { capture: true });
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('message', onRelayMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onRuntimeMessage);
    unsubscribe();
  }
  unsubscribe = onRecordingStateChange((state) => {
    if (state.operation !== 'recording' || !state.isRecording || state.runId !== runId || state.mode !== 'steps') {
      cleanup();
      return;
    }
    paused = state.phase === 'paused';
    if (paused) gestureQueue.purgePending();
  });

  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_PRESS_GATE_EVENTS) document.addEventListener(type, onFollowup, { capture: true });
  window.addEventListener('blur', onBlur);
  window.addEventListener('message', onRelayMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onRuntimeMessage);
}

/**
 * Freezes a snapshot child frame and reports pixel-shifting scrolls upward.
 * The scroll ping is an invalidation signal only: a page can already invalidate
 * a snapshot by moving pixels, so it is intentionally not part of the trusted
 * step-capture relay described above.
 */
export function installSnapshotFrameFreeze(): void {
  if (window.top === window) return;
  const pingType = snapshotFrameScrollPingType(browser.runtime.id);
  const baseline = { x: window.scrollX, y: window.scrollY };
  let pinged = false;
  let removed = false;

  const consume = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const ping = () => {
    if (pinged || removed) return;
    pinged = true;
    try {
      window.parent.postMessage({ type: pingType }, '*');
    } catch {
      // A detaching frame no longer affects the snapshot.
    }
  };
  const onScroll = (event: Event) => {
    if (event.target === document && window.scrollX === baseline.x && window.scrollY === baseline.y) return;
    ping();
  };
  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type !== pingType) return;
    if (!findIframeForWindow(event.source)) return;
    ping();
  };
  const onStop = (message: HowbeamStopMessage) => {
    if (message?.type === 'HOWBEAM_STOP') cleanup();
  };
  const cleanup = () => {
    if (removed) return;
    removed = true;
    for (const type of SNAPSHOT_FREEZE_EVENTS) window.removeEventListener(type, consume, { capture: true });
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', ping);
    window.removeEventListener('message', onMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
  };

  for (const type of SNAPSHOT_FREEZE_EVENTS) window.addEventListener(type, consume, { capture: true, passive: false });
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
  window.addEventListener('resize', ping, { passive: true });
  window.addEventListener('message', onMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);
}
