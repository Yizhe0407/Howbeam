import { BRAND_DANGER } from './brand-colors';
import { OVERLAY_LAYER, releaseTopLayer, showInTopLayer } from './overlay-layers';
import { createViewportOverlayHost } from './viewport-overlay-host';
import { OVERLAY_FONT_STACK } from './overlay-font';
import { t } from '@/lib/shared/i18n';

export const REGION_CAPTURE_MIN_SIZE = 8;

export interface RegionPoint {
  x: number;
  y: number;
}

export interface RegionViewport {
  width: number;
  height: number;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type RegionCaptureCancelReason = 'user' | 'escape' | 'viewport' | 'removed';

export interface RegionCaptureOptions {
  onCapture(rect: RegionRect): void | Promise<void>;
  onCancel?(reason: RegionCaptureCancelReason): void | Promise<void>;
  onClose?(): void;
  minSize?: number;
  /** Steps mode needs two compositor frames; snapshot annotations can opt out. */
  settleFrames?: number;
  viewport?: () => RegionViewport;
}

export interface RegionCapture {
  readonly host: HTMLElement;
  isActive(): boolean;
  isCapturing(): boolean;
  /** No-op once capture starts: the session's single outcome is then owned by
   * the settling onCapture (exactly one of onCapture-settled / onCancel). */
  cancel(reason?: RegionCaptureCancelReason): void;
  remove(): void;
}

function clipRegionPoint(point: RegionPoint, viewport: RegionViewport): RegionPoint {
  const width = Number.isFinite(viewport.width) ? Math.max(0, viewport.width) : 0;
  const height = Number.isFinite(viewport.height) ? Math.max(0, viewport.height) : 0;
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  return {
    x: Math.min(Math.max(x, 0), width),
    y: Math.min(Math.max(y, 0), height),
  };
}

export function normalizeRegionRect(
  start: RegionPoint,
  end: RegionPoint,
  viewport: RegionViewport,
): RegionRect {
  const clippedStart = clipRegionPoint(start, viewport);
  const clippedEnd = clipRegionPoint(end, viewport);
  const x = Math.min(clippedStart.x, clippedEnd.x);
  const y = Math.min(clippedStart.y, clippedEnd.y);
  return {
    x,
    y,
    width: Math.max(clippedStart.x, clippedEnd.x) - x,
    height: Math.max(clippedStart.y, clippedEnd.y) - y,
  };
}

export function isRegionRectLargeEnough(
  rect: RegionRect,
  minSize = REGION_CAPTURE_MIN_SIZE,
): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    Number.isFinite(minSize) &&
    minSize > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width >= minSize &&
    rect.height >= minSize
  );
}

export function isRegionRectInsideViewport(
  rect: RegionRect,
  viewport: RegionViewport,
  minSize = REGION_CAPTURE_MIN_SIZE,
): boolean {
  return (
    isRegionRectLargeEnough(rect, minSize) &&
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width >= 0 &&
    viewport.height >= 0 &&
    rect.x + rect.width <= viewport.width &&
    rect.y + rect.height <= viewport.height
  );
}

export type RegionHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const REGION_HANDLES: readonly RegionHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Moves a region by (dx, dy), keeping it whole inside the viewport. */
export function moveRegionRect(rect: RegionRect, dx: number, dy: number, viewport: RegionViewport): RegionRect {
  const x = Math.min(Math.max(rect.x + dx, 0), Math.max(viewport.width - rect.width, 0));
  const y = Math.min(Math.max(rect.y + dy, 0), Math.max(viewport.height - rect.height, 0));
  return { x, y, width: rect.width, height: rect.height };
}

/** Drags one handle of a region by (dx, dy): the edges it owns follow the pointer, clipped to the viewport and never closer than `minSize`. */
export function resizeRegionRect(
  rect: RegionRect,
  handle: RegionHandle,
  dx: number,
  dy: number,
  viewport: RegionViewport,
  minSize = REGION_CAPTURE_MIN_SIZE,
): RegionRect {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes('w')) left = Math.min(Math.max(left + dx, 0), right - minSize);
  if (handle.includes('e')) right = Math.max(Math.min(right + dx, viewport.width), left + minSize);
  if (handle.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - minSize);
  if (handle.includes('s')) bottom = Math.max(Math.min(bottom + dy, viewport.height), top + minSize);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Gap between the selection and the action bar attached to it, and the margin kept to the viewport edge. */
const ACTIONS_GAP = 8;

/**
 * Where the confirm/cancel bar goes: just under the selection's bottom-right corner, or above it when the
 * selection reaches the bottom of the viewport, or inside it when the selection fills the height. Always whole
 * inside the viewport, so it never covers the area being selected unless there is nowhere else to go.
 */
export function placeRegionActions(
  rect: RegionRect,
  viewport: RegionViewport,
  size: { width: number; height: number },
): RegionPoint {
  const x = Math.min(Math.max(rect.x + rect.width - size.width, ACTIONS_GAP), Math.max(viewport.width - size.width - ACTIONS_GAP, ACTIONS_GAP));
  const below = rect.y + rect.height + ACTIONS_GAP;
  if (below + size.height <= viewport.height - ACTIONS_GAP) return { x, y: below };
  const above = rect.y - size.height - ACTIONS_GAP;
  if (above >= ACTIONS_GAP) return { x, y: above };
  return { x, y: Math.max(rect.y + rect.height - size.height - ACTIONS_GAP, ACTIONS_GAP) };
}

async function waitForRegionCapturePaint(frames = 2): Promise<void> {
  for (let index = 0; index < Math.max(0, frames); index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

const REGION_CAPTURE_STYLES = `
  :host { color-scheme: light; }
  * { box-sizing: border-box; }
  .ft-region-blocker {
    position: fixed; inset: 0; overflow: hidden; pointer-events: auto;
    cursor: crosshair; touch-action: none; user-select: none;
    font-family: ${OVERLAY_FONT_STACK};
  }
  .ft-region-selection {
    position: absolute; display: none; border: 2px solid ${BRAND_DANGER}; border-radius: 8px;
    background: rgb(255 71 71 / .08); box-shadow: 0 0 0 99999px rgb(15 23 42 / .32);
    pointer-events: none;
  }
  .ft-region-selection[data-visible="true"] { display: block; }
  /* Once drawn, the box can be moved and resized until it is confirmed. */
  .ft-region-selection[data-interactive="true"] { pointer-events: auto; cursor: move; }
  .ft-region-handle {
    position: absolute; width: 14px; height: 14px; border: 2px solid ${BRAND_DANGER}; border-radius: 99px;
    background: #fffdf8; display: none;
  }
  .ft-region-selection[data-interactive="true"] .ft-region-handle { display: block; }
  .ft-region-handle[data-handle="nw"] { left: -8px; top: -8px; cursor: nwse-resize; }
  .ft-region-handle[data-handle="n"] { left: calc(50% - 7px); top: -8px; cursor: ns-resize; }
  .ft-region-handle[data-handle="ne"] { right: -8px; top: -8px; cursor: nesw-resize; }
  .ft-region-handle[data-handle="e"] { right: -8px; top: calc(50% - 7px); cursor: ew-resize; }
  .ft-region-handle[data-handle="se"] { right: -8px; bottom: -8px; cursor: nwse-resize; }
  .ft-region-handle[data-handle="s"] { left: calc(50% - 7px); bottom: -8px; cursor: ns-resize; }
  .ft-region-handle[data-handle="sw"] { left: -8px; bottom: -8px; cursor: nesw-resize; }
  .ft-region-handle[data-handle="w"] { left: -8px; top: calc(50% - 7px); cursor: ew-resize; }
  /* Guidance only: it never takes the pointer, so a box can be drawn right under it. */
  .ft-region-hint {
    position: fixed; top: 16px; left: 50%; max-width: calc(100vw - 32px); padding: 6px 14px;
    transform: translateX(-50%); border: 2px solid #1f1b16; border-radius: 999px;
    background: #fffdf8; color: #1f1b16; font-size: 13px; line-height: 1.4; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none;
  }
  /* Attached to the selection (see placeRegionActions) rather than a fixed corner. */
  .ft-region-actions {
    position: fixed; left: 0; top: 0; display: none; align-items: center; gap: 8px; padding: 4px;
    border: 2px solid #1f1b16; border-radius: 999px; background: #fffdf8; cursor: default; pointer-events: auto;
  }
  .ft-region-actions[data-visible="true"] { display: flex; }
  .ft-region-cancel {
    min-width: 40px; min-height: 32px; padding: 0 12px; border: 2px solid #1f1b16; border-radius: 999px;
    background: #f2e9d9; color: #1f1b16; font: inherit; font-weight: 700; cursor: pointer;
  }
  .ft-region-cancel:hover { background: #ffe27a; }
  .ft-region-confirm {
    min-width: 40px; min-height: 32px; padding: 0 14px; border: 2px solid #1f1b16; border-radius: 999px;
    background: #a8d8ff; color: #1f1b16; font: inherit; font-weight: 800; cursor: pointer;
  }
  .ft-region-confirm[hidden] { display: none; }
  .ft-region-confirm:hover { filter: brightness(.95); }
  .ft-region-cancel:focus-visible, .ft-region-confirm:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
  .ft-region-blocker[data-capturing="true"] { cursor: wait; }
  .ft-region-blocker[data-capturing="true"] .ft-region-selection,
  .ft-region-blocker[data-capturing="true"] .ft-region-hint,
  .ft-region-blocker[data-capturing="true"] .ft-region-actions { visibility: hidden; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

/**
 * Owns a full-viewport selection: drag out a box, adjust it, confirm it. During capture only the visual children
 * are hidden; the transparent host remains hit-testable until the callback
 * settles, so no page target receives a synthetic follow-up click.
 */
export function createRegionCapture(options: RegionCaptureOptions): RegionCapture {
  const readViewport = options.viewport ?? (() => ({ width: window.innerWidth, height: window.innerHeight }));
  const minSize = options.minSize ?? REGION_CAPTURE_MIN_SIZE;
  const settleFrames = options.settleFrames ?? 2;
  // Hit-testable on purpose: the transparent host swallows the drag so no page
  // target receives it.
  const host = createViewportOverlayHost('data-howbeam-region-capture', { 'pointer-events': 'auto' }, { popover: true });

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = REGION_CAPTURE_STYLES;
  const blocker = document.createElement('div');
  blocker.className = 'ft-region-blocker';
  blocker.tabIndex = 0;
  blocker.setAttribute('role', 'application');
  blocker.setAttribute('aria-label', t().regionCapture.label);
  const selection = document.createElement('div');
  selection.className = 'ft-region-selection';
  selection.dataset.visible = 'false';
  const status = document.createElement('div');
  status.className = 'ft-region-hint';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = t().regionCapture.instructions;
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'ft-region-cancel';
  cancelButton.textContent = t().common.cancel;
  cancelButton.setAttribute('aria-label', t().regionCapture.cancelLabel);
  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'ft-region-confirm';
  confirmButton.hidden = true;
  confirmButton.textContent = '✓';
  confirmButton.setAttribute('aria-label', t().regionCapture.confirmLabel);
  for (const handle of REGION_HANDLES) {
    const knob = document.createElement('div');
    knob.className = 'ft-region-handle';
    knob.dataset.handle = handle;
    selection.append(knob);
  }
  const actions = document.createElement('div');
  actions.className = 'ft-region-actions';
  actions.dataset.visible = 'false';
  actions.append(cancelButton, confirmButton);
  blocker.append(selection, status, actions);
  root.append(style, blocker);

  let closed = false;
  let capturing = false;
  /** The gesture in progress: drawing a new box, moving the current one, or dragging one of its handles. */
  let drag: { pointerId: number; mode: 'draw' | 'move' | RegionHandle; origin: RegionPoint; base: RegionRect | null } | null = null;
  /** The box waiting to be adjusted and confirmed. */
  let pending: RegionRect | null = null;
  let cancelNotified = false;

  const consume = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
  };

  /** Keeps the action bar attached to the box while it is being adjusted. */
  const placeActions = (rect: RegionRect) => {
    if (actions.dataset.visible !== 'true') return;
    const measured = actions.getBoundingClientRect();
    const size = { width: measured.width || 150, height: measured.height || 44 };
    const at = placeRegionActions(rect, readViewport(), size);
    actions.style.left = `${at.x}px`;
    actions.style.top = `${at.y}px`;
  };

  const renderRect = (rect: RegionRect | null) => {
    if (!rect || rect.width === 0 || rect.height === 0) {
      selection.dataset.visible = 'false';
      return;
    }
    selection.dataset.visible = 'true';
    selection.style.left = `${rect.x}px`;
    selection.style.top = `${rect.y}px`;
    selection.style.width = `${rect.width}px`;
    selection.style.height = `${rect.height}px`;
    placeActions(rect);
  };

  const close = (notify = true) => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onResize, true);
    releaseTopLayer(host);
    host.remove();
    if (notify) options.onClose?.();
  };

  const cancel = (reason: RegionCaptureCancelReason = 'user') => {
    // Once onCapture is in flight it owns the session's outcome; cancelling
    // now would fire onCancel AND a completed onCapture, and removing the
    // host early would break the hit-test guarantee documented above.
    if (closed || capturing) return;
    if (!cancelNotified) {
      cancelNotified = true;
      void options.onCancel?.(reason);
    }
    close();
  };

  const setPending = (rect: RegionRect | null) => {
    pending = rect;
    renderRect(rect);
    selection.dataset.interactive = rect ? 'true' : 'false';
    confirmButton.hidden = rect === null;
    actions.dataset.visible = rect ? 'true' : 'false';
    if (rect) placeActions(rect);
  };

  const commit = () => {
    const rect = pending;
    if (capturing || closed || !rect) return;
    capturing = true;
    blocker.dataset.capturing = 'true';
    status.textContent = t().regionCapture.capturing;
    void (async () => {
      try {
        await waitForRegionCapturePaint(settleFrames);
        if (closed) return;
        await options.onCapture(rect);
      } catch (error) {
        console.error('[howbeam] failed to capture selected region', error);
      } finally {
        close();
      }
    })();
  };

  const pointOf = (event: PointerEvent): RegionPoint => clipRegionPoint({ x: event.clientX, y: event.clientY }, readViewport());

  const onPointerDown = (event: PointerEvent) => {
    // The action bar's own buttons are not part of the drawing surface: pressing one must not start a box
    // (which would clear the one being adjusted and capture the pointer, so the click never arrives).
    if (event.composedPath().includes(actions)) {
      event.stopPropagation();
      return;
    }
    consume(event);
    if (capturing || event.button !== 0 || !event.isPrimary) return;
    const point = pointOf(event);
    const handle = (event.target as HTMLElement | null)?.dataset?.handle as RegionHandle | undefined;
    const inside = pending !== null
      && point.x >= pending.x && point.x <= pending.x + pending.width
      && point.y >= pending.y && point.y <= pending.y + pending.height;
    if (pending && handle) {
      drag = { pointerId: event.pointerId, mode: handle, origin: point, base: pending };
    } else if (pending && inside) {
      drag = { pointerId: event.pointerId, mode: 'move', origin: point, base: pending };
    } else {
      // Anywhere else starts a new box, replacing the one being adjusted.
      setPending(null);
      drag = { pointerId: event.pointerId, mode: 'draw', origin: point, base: null };
      renderRect(normalizeRegionRect(point, point, readViewport()));
      status.textContent = t().regionCapture.dragging;
    }
    blocker.setPointerCapture?.(event.pointerId);
  };

  const rectForDrag = (event: PointerEvent): RegionRect | null => {
    if (!drag) return null;
    const point = pointOf(event);
    const viewport = readViewport();
    if (drag.mode === 'draw') return normalizeRegionRect(drag.origin, point, viewport);
    const dx = point.x - drag.origin.x;
    const dy = point.y - drag.origin.y;
    if (drag.mode === 'move') return moveRegionRect(drag.base!, dx, dy, viewport);
    return resizeRegionRect(drag.base!, drag.mode, dx, dy, viewport, minSize);
  };

  const onPointerMove = (event: PointerEvent) => {
    consume(event);
    if (capturing || drag === null || drag.pointerId !== event.pointerId) return;
    renderRect(rectForDrag(event));
  };

  const onPointerUp = (event: PointerEvent) => {
    consume(event);
    if (capturing || drag === null || drag.pointerId !== event.pointerId) return;
    if (blocker.hasPointerCapture?.(event.pointerId)) blocker.releasePointerCapture?.(event.pointerId);
    const rect = rectForDrag(event);
    const finished = drag;
    drag = null;
    if (!rect || !isRegionRectInsideViewport(rect, readViewport(), minSize)) {
      // Only a freshly drawn box can be too small; a move or resize keeps its minimum.
      setPending(finished.mode === 'draw' ? null : finished.base);
      status.textContent = finished.mode === 'draw' ? t().regionCapture.tooSmall(minSize) : t().regionCapture.adjust;
      return;
    }
    setPending(rect);
    status.textContent = t().regionCapture.adjust;
  };

  const onPointerCancel = (event: PointerEvent) => {
    consume(event);
    cancel('user');
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      consume(event);
      cancel('escape');
      return;
    }
    if (event.key === 'Enter' && pending && !capturing) {
      consume(event);
      commit();
      return;
    }
    if (event.key === 'Tab' && !capturing) {
      // Shadow DOM retargets event.target to the host for this window-level
      // listener, so resolve the real origin via composedPath. Trap focus in
      // a short cycle so keyboard users can reach the cancel and confirm buttons.
      consume(event);
      const stops: HTMLElement[] = [blocker, cancelButton, ...(confirmButton.hidden ? [] : [confirmButton])];
      const at = stops.indexOf(event.composedPath()[0] as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      stops[(at + step + stops.length) % stops.length].focus({ preventScroll: true });
      return;
    }
    consume(event);
  };

  const onResize = () => cancel('viewport');

  blocker.addEventListener('pointerdown', onPointerDown);
  blocker.addEventListener('pointermove', onPointerMove);
  blocker.addEventListener('pointerup', onPointerUp);
  blocker.addEventListener('pointercancel', onPointerCancel);
  blocker.addEventListener('click', consume);
  blocker.addEventListener('contextmenu', consume);
  blocker.addEventListener('wheel', consume, { passive: false });
  cancelButton.addEventListener('click', (event) => {
    consume(event);
    cancel('user');
  });
  confirmButton.addEventListener('click', (event) => {
    consume(event);
    commit();
  });
  window.addEventListener('keydown', onKeyDown, { capture: true });
  window.addEventListener('resize', onResize, { capture: true });

  document.documentElement.append(host);
  showInTopLayer(host, OVERLAY_LAYER.modal);
  queueMicrotask(() => blocker.focus({ preventScroll: true }));

  return {
    host,
    isActive: () => !closed,
    isCapturing: () => capturing && !closed,
    cancel,
    remove() {
      if (!closed) cancel('removed');
    },
  };
}
