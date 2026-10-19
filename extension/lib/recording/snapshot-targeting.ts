import { browser } from 'wxt/browser';
import { deepElementFromPoint, isElementVisuallyUnavailable } from '../capture/selector/element-availability';
import { getVisibleHighlightBounds } from '../capture/selector/highlight-bounds';
import { INTERACTIVE_CANDIDATE_SELECTOR, isInteractiveElement } from '../capture/selector/interactive-element';
import { buildSnapshotTargetIdentity } from '../capture/selector/snapshot-identity';
import { findVisualTargetCandidatesAtPoint, selectVisualTargetCandidate } from '../capture/selector/visual-target';
import { intersectBounds } from '../capture/bounds-geometry';
import { describeElement } from '../capture/element-description';
import {
  SNAPSHOT_KEYBOARD_LABEL_LIMIT,
  SNAPSHOT_REGION_COORDINATE_LIMIT,
  type SnapshotShieldKeyboardAnchor,
  type SnapshotShieldRect,
} from './snapshot-shield-protocol';
import { orderKeyboardCandidates, type RawKeyboardCandidate } from '../capture/snapshot-candidates';
import { createFrameCoordinateMapper } from '../capture/frame-geometry';
import {
  childFrameProbeTimeout,
  classifyFrameProbeOutcome,
  closePortQuietly,
  createFrameProbeRateLimiter,
  isExplicitFrameProbeFallback,
  resolveFrameProbeTargetOrigin,
} from '../capture/frame-probe';
import { findImageForArea, resolveImageMapTargetAtPoint } from './image-map-resolver';
import { isFiniteRect } from '../shared/validation';
import { CLEANUP_EVENT } from './content-script-constants';
import type { HowbeamStopMessage } from '../runtime/messages';

const FRAME_PROBE_MESSAGE = `howbeam_snapshot_probe_${browser.runtime.id}`;
const FRAME_PROBE_TIMEOUT_MS = 120;
const FRAME_PROBE_CHILD_BUDGET_MS = 20;
const FRAME_PROBE_RETRY_DELAY_MS = 2_000;
const FRAME_PROBE_MAX_CONCURRENT_REQUESTS = 12;
const FRAME_PROBE_MAX_REQUESTS_PER_WINDOW = 720;
const FRAME_PROBE_RATE_WINDOW_MS = 10_000;
const timedOutFrameProbes = new WeakMap<HTMLIFrameElement, { runId: string; retryAt: number }>();

export function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Enumerates top-frame annotation candidates for keyboard traversal (§9.5).
 * The page is frozen while annotating, so this runs once. Ordering, dedup and
 * capping are delegated to the pure helper; cross-frame candidates are out of
 * scope for this flag-gated first pass and remain pointer-reachable.
 */
export function collectKeyboardCandidateAnchors(): SnapshotShieldKeyboardAnchor[] {
  const raw: RawKeyboardCandidate[] = [];
  const seen = new Set<Element>();
  for (const el of document.querySelectorAll(INTERACTIVE_CANDIDATE_SELECTOR)) {
    if (seen.has(el) || !isInteractiveElement(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    raw.push({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      label: (describeElement(el) || el.tagName.toLowerCase()).slice(0, SNAPSHOT_KEYBOARD_LABEL_LIMIT),
    });
  }
  return orderKeyboardCandidates(raw, window.innerWidth, window.innerHeight);
}

interface SnapshotProbeResult {
  rect: SnapshotShieldRect;
  identity: string;
  text: string;
  tagName: string;
}

export interface ResolvedSnapshotTarget extends SnapshotProbeResult {
  element?: Element;
  /**
   * Overrides live-Element duplicate detection. `undefined` keeps the default
   * `element` identity, while `null` disables it for composite targets whose
   * logical identity spans more than one live element (for example area+image).
   */
  dedupeElement?: Element | null;
}

interface SnapshotProbeRequest {
  type: typeof FRAME_PROBE_MESSAGE;
  runId: string;
  timeoutMs: number;
  clientX: number;
  clientY: number;
}

function isSnapshotProbeResult(value: unknown): value is SnapshotProbeResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<SnapshotProbeResult>;
  return (
    isFiniteRect(result.rect, { maxMagnitude: SNAPSHOT_REGION_COORDINATE_LIMIT }) &&
    typeof result.identity === 'string' &&
    result.identity.length > 0 &&
    result.identity.length <= 4_096 &&
    typeof result.text === 'string' &&
    result.text.length <= 200 &&
    typeof result.tagName === 'string' &&
    result.tagName.length > 0 &&
    result.tagName.length <= 100
  );
}

function resolvedElement(
  el: Element,
  rect: SnapshotShieldRect | null,
): ResolvedSnapshotTarget | null {
  if (!rect) return null;
  return {
    element: el,
    rect,
    identity: buildSnapshotTargetIdentity(el),
    text: describeElement(el),
    tagName: el.tagName.toLowerCase(),
  };
}

function resolvedImageMapTarget(
  area: HTMLAreaElement,
  image: HTMLImageElement,
  rect: SnapshotShieldRect,
): ResolvedSnapshotTarget {
  return {
    element: area,
    dedupeElement: null,
    rect,
    identity: `${buildSnapshotTargetIdentity(area)}::image-map::${buildSnapshotTargetIdentity(image)}`,
    text: describeElement(area),
    tagName: area.tagName.toLowerCase(),
  };
}

async function probeChildFrame(
  frame: HTMLIFrameElement,
  runId: string,
  clientX: number,
  clientY: number,
  timeoutMs: number,
): Promise<ResolvedSnapshotTarget | null> {
  if (!frame.contentWindow || isElementVisuallyUnavailable(frame)) return null;
  const visibleFrame = getVisibleHighlightBounds(frame, clientX, clientY);
  const mapper = createFrameCoordinateMapper(frame);
  if (!visibleFrame || !mapper) return null;
  if (timeoutMs <= 0) return resolvedElement(frame, visibleFrame);
  const timedOutProbe = timedOutFrameProbes.get(frame);
  if (timedOutProbe?.runId === runId && timedOutProbe.retryAt > Date.now()) {
    return resolvedElement(frame, visibleFrame);
  }

  const targetOrigin = resolveFrameProbeTargetOrigin(
    frame.getAttribute('src'),
    document.baseURI,
    {
      hasSrcdoc: frame.hasAttribute('srcdoc'),
      opaqueSandbox: frame.hasAttribute('sandbox') && !frame.sandbox.contains('allow-same-origin'),
    },
  );
  if (!targetOrigin) return resolvedElement(frame, visibleFrame);

  const channel = new MessageChannel();
  let responseTimeout: ReturnType<typeof setTimeout> | null = null;
  let settleResponse = (_result: { child: SnapshotProbeResult | null; timedOut: boolean }): void => {};
  const response = new Promise<{ child: SnapshotProbeResult | null; timedOut: boolean }>((resolve) => {
    settleResponse = resolve;
    responseTimeout = setTimeout(() => {
      channel.port1.close();
      resolve({ child: null, timedOut: true });
    }, timeoutMs);
    channel.port1.onmessage = (event) => {
      if (responseTimeout) clearTimeout(responseTimeout);
      channel.port1.close();
      resolve({
        child: isSnapshotProbeResult(event.data) ? event.data : null,
        timedOut: isExplicitFrameProbeFallback(event.data),
      });
    };
    channel.port1.start();
  });
  const childPoint = mapper.toChildPoint({ x: clientX, y: clientY });
  const request: SnapshotProbeRequest = {
    type: FRAME_PROBE_MESSAGE,
    runId,
    timeoutMs: childFrameProbeTimeout(timeoutMs, FRAME_PROBE_CHILD_BUDGET_MS),
    clientX: childPoint.x,
    clientY: childPoint.y,
  };
  try {
    frame.contentWindow.postMessage(request, targetOrigin, [channel.port2]);
  } catch {
    if (responseTimeout) clearTimeout(responseTimeout);
    channel.port1.close();
    settleResponse({ child: null, timedOut: true });
    timedOutFrameProbes.set(frame, { runId, retryAt: Date.now() + FRAME_PROBE_RETRY_DELAY_MS });
    return resolvedElement(frame, visibleFrame);
  }
  const { child: probeTarget, timedOut } = await response;
  const outcome = classifyFrameProbeOutcome(probeTarget, timedOut);
  if (outcome.kind === 'fallback') {
    timedOutFrameProbes.set(frame, { runId, retryAt: Date.now() + FRAME_PROBE_RETRY_DELAY_MS });
    return resolvedElement(frame, visibleFrame);
  }
  timedOutFrameProbes.delete(frame);
  if (outcome.kind === 'empty') return null;

  const child = outcome.target;
  const mapped = mapper.toParentBounds(child.rect);
  const rect = intersectBounds(mapped, visibleFrame);
  return rect
    ? {
        rect,
        identity: `${buildSnapshotTargetIdentity(frame)}::frame::${child.identity}`,
        text: child.text,
        tagName: child.tagName,
      }
    : null;
}

/**
 * Resolves the annotation target at one viewport point for a snapshot run.
 *
 * Every probe is independent: the point alone decides the target, so the same
 * coordinates always answer with the same box. Child frames, image-map areas
 * and ordinary elements are each dispatched from the single top hit, in that
 * order, because a frame or an area can never also be a candidate chain.
 */
export async function resolveSnapshotTargetAtPoint(
  runId: string,
  clientX: number,
  clientY: number,
  frameProbeTimeoutMs = FRAME_PROBE_TIMEOUT_MS,
): Promise<ResolvedSnapshotTarget | null> {
  if (clientX < 0 || clientY < 0 || clientX >= window.innerWidth || clientY >= window.innerHeight) {
    return null;
  }

  const hit = deepElementFromPoint(clientX, clientY);
  if (!hit) return null;
  if (hit instanceof HTMLIFrameElement) {
    return probeChildFrame(hit, runId, clientX, clientY, frameProbeTimeoutMs);
  }
  if (hit instanceof HTMLAreaElement) {
    const image = findImageForArea(hit, clientX, clientY);
    if (image) {
      const target = resolveImageMapTargetAtPoint(image, clientX, clientY);
      return target ? resolvedImageMapTarget(target.area, target.image, target.bounds) : null;
    }
  }
  if (hit instanceof HTMLImageElement && hit.useMap) {
    const target = resolveImageMapTargetAtPoint(hit, clientX, clientY);
    if (target) return resolvedImageMapTarget(target.area, target.image, target.bounds);
  }

  const selected = selectVisualTargetCandidate(
    findVisualTargetCandidatesAtPoint(hit, clientX, clientY, {
      width: window.innerWidth,
      height: window.innerHeight,
    }),
  );
  return selected ? resolvedElement(selected.element, selected.bounds) : null;
}

export function installSnapshotFrameProbe(runId: string): void {
  const admission = createFrameProbeRateLimiter({
    maxConcurrent: FRAME_PROBE_MAX_CONCURRENT_REQUESTS,
    maxRequestsPerWindow: FRAME_PROBE_MAX_REQUESTS_PER_WINDOW,
    windowMs: FRAME_PROBE_RATE_WINDOW_MS,
  });
  const onMessage = (event: MessageEvent) => {
    const request = event.data as Partial<SnapshotProbeRequest> | null;
    const port = event.ports[0];
    const { timeoutMs, clientX, clientY } = request ?? {};
    if (
      event.source !== parent ||
      !port ||
      request?.type !== FRAME_PROBE_MESSAGE ||
      request.runId !== runId ||
      timeoutMs === undefined ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > FRAME_PROBE_TIMEOUT_MS ||
      clientX === undefined ||
      !Number.isFinite(clientX) ||
      clientY === undefined ||
      !Number.isFinite(clientY)
    ) {
      closePortQuietly(port);
      return;
    }
    const release = admission.tryAcquire();
    if (!release) {
      try {
        // An explicit fallback response closes the transferred port immediately
        // instead of forcing the parent to retain it until the transport timeout.
        port.postMessage({ fallback: true });
      } catch {
        // The sender may already have abandoned the request.
      } finally {
        closePortQuietly(port);
      }
      return;
    }
    void (async () => {
      let response: SnapshotProbeResult | null = null;
      try {
        const target = await resolveSnapshotTargetAtPoint(runId, clientX, clientY, timeoutMs);
        response = target
          ? {
              rect: target.rect,
              identity: target.identity,
              text: target.text,
              tagName: target.tagName,
            }
          : null;
      } catch (error) {
        console.error('[howbeam] child frame probe failed', error);
      }
      try {
        port.postMessage(response);
      } catch (error) {
        console.warn('[howbeam] child frame probe response channel closed', error);
      } finally {
        release();
        closePortQuietly(port);
      }
    })();
  };
  const cleanup = () => {
    window.removeEventListener('message', onMessage);
    document.removeEventListener(CLEANUP_EVENT, cleanup);
    browser.runtime.onMessage.removeListener(onStop);
  };
  const onStop = (message: HowbeamStopMessage) => {
    if (message?.type === 'HOWBEAM_STOP') cleanup();
  };
  window.addEventListener('message', onMessage);
  document.addEventListener(CLEANUP_EVENT, cleanup);
  browser.runtime.onMessage.addListener(onStop);
}
