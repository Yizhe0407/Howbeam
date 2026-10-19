import type { ClickCapture } from '../runtime/messages';
import type { RecordingMode, RecordingState } from '../storage/recording-state';
import { deepElementFromPoint, getComposedParent } from '../capture/selector/element-availability';

export type CaptureGuardFailure = 'stale-run' | 'inactive-tab' | 'changed-url' | null;
export type RecordingTabUpdateAction = 'ignore' | 'reinject' | 'stop-snapshot';

/** 原生捲軸間隙位於 layout viewport 外，不可被記錄為步驟。 */
export function isInScrollbarGutter(
  clientX: number,
  clientY: number,
  layout: { clientLeft: number; clientTop: number; clientWidth: number; clientHeight: number },
): boolean {
  const right = layout.clientLeft + layout.clientWidth;
  const bottom = layout.clientTop + layout.clientHeight;
  return clientX < layout.clientLeft || clientX >= right || clientY < layout.clientTop || clientY >= bottom;
}

/** Keys with which the browser scrolls a document by default. */
const DOCUMENT_SCROLLING_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End',
]);
/** Where a scrolling key means caret movement or text entry instead. */
const TEXT_ENTRY_SELECTOR = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';

/**
 * 偵測會透過不可捲動 shield 捲動凍結頁面的按鍵。
 * 文字輸入及以 Space 觸發的控制項保留原生行為。
 */
export function isDocumentScrollingKey(key: string, target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null;
  if (element?.closest(TEXT_ENTRY_SELECTOR)) return false;
  if (DOCUMENT_SCROLLING_KEYS.has(key)) return true;
  return key === ' ' && !element?.closest('button,a[href],summary,[role="button"]');
}

/** True when a point lands in a native scrollbar belonging to a nested
 * overflow element. The element's client box excludes its scrollbar gutter,
 * while its border box includes it; comparing the two preserves scrolling even
 * when the page itself has no root scrollbar. */
export function isInScrollableElementGutter(clientX: number, clientY: number, element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return false;
  const style = getComputedStyle(element);
  const overflowX = style.overflowX || style.overflow;
  const overflowY = style.overflowY || style.overflow;
  const scrollsX = ['auto', 'scroll', 'overlay'].includes(overflowX) && element.scrollWidth > element.clientWidth;
  const scrollsY = ['auto', 'scroll', 'overlay'].includes(overflowY) && element.scrollHeight > element.clientHeight;
  if (!scrollsX && !scrollsY) return false;

  const scaleX = rect.width / (element.offsetWidth || rect.width || 1);
  const scaleY = rect.height / (element.offsetHeight || rect.height || 1);
  const contentLeft = rect.left + element.clientLeft * scaleX;
  const contentTop = rect.top + element.clientTop * scaleY;
  const contentRight = contentLeft + element.clientWidth * scaleX;
  const contentBottom = contentTop + element.clientHeight * scaleY;
  return (
    // A vertical scrollbar consumes horizontal space and a horizontal
    // scrollbar consumes vertical space.
    (scrollsY && (clientX < contentLeft || clientX >= contentRight)) ||
    (scrollsX && (clientY < contentTop || clientY >= contentBottom))
  );
}

/** True when the point falls in the scrollbar gutter of the hit element or
 * any of its composed ancestors. Recorders must leave such pointerdowns
 * untouched so the drag scrolls and no bogus step is recorded. */
export function isPointInAnyScrollGutter(clientX: number, clientY: number): boolean {
  let ancestor = deepElementFromPoint(clientX, clientY);
  while (ancestor) {
    if (isInScrollableElementGutter(clientX, clientY, ancestor)) return true;
    ancestor = getComposedParent(ancestor);
  }
  return false;
}

/** A null-relatedTarget pointerout can be synthesized when scrolling or DOM
 * replacement moves the old target out from under a stationary cursor. It only
 * means the pointer left the page when its coordinates also left the viewport. */
export function isPointInsideViewport(
  clientX: number,
  clientY: number,
  viewport: { width: number; height: number },
): boolean {
  return clientX >= 0 && clientY >= 0 && clientX < viewport.width && clientY < viewport.height;
}

export function getRecordingTabUpdateAction(
  mode: RecordingMode,
  changeInfo: { status?: string; url?: string },
): RecordingTabUpdateAction {
  if (mode === 'snapshot') {
    return changeInfo.status === 'loading' || Boolean(changeInfo.url) ? 'stop-snapshot' : 'ignore';
  }
  return changeInfo.status === 'complete' ? 'reinject' : 'ignore';
}

export function getCaptureGuardFailure(input: {
  expectedControlVersion: number;
  currentControlVersion: number;
  runId: string;
  sessionId: string;
  tabId: number;
  expectedUrl: string;
  state: RecordingState;
  activeTab: { id?: number; url?: string } | undefined;
}): CaptureGuardFailure {
  const { state } = input;
  if (
    input.expectedControlVersion !== input.currentControlVersion ||
    !state.isRecording ||
    state.runId !== input.runId ||
    state.sessionId !== input.sessionId ||
    state.tabId !== input.tabId
  ) {
    return 'stale-run';
  }
  if (input.activeTab?.id !== input.tabId) return 'inactive-tab';
  if (input.activeTab.url && input.activeTab.url !== input.expectedUrl) return 'changed-url';
  return null;
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Trusts a HOWBEAM_CLICK sender by identity (the tab/frame), not exact
 * URL: sender.url/tab.url lag behind SPA history.pushState navigations, so
 * comparing full URLs rejected legitimate clicks. Origin is still checked to
 * reject a stale content script left on a different site; getCaptureGuardFailure's
 * changed-url guard (an exact match, checked after the capture round-trip) is
 * what catches a real same-tab navigation during the capture window. */
export function isTrustedRecordedPageSender(
  messageUrl: string,
  sender: { frameId?: number; url?: string; tab?: { id?: number; url?: string } },
  expectedTabId: number,
): boolean {
  return (
    sender.frameId === 0 &&
    sender.tab?.id === expectedTabId &&
    sender.url !== undefined &&
    isSameOrigin(sender.url, messageUrl) &&
    sender.tab.url !== undefined &&
    isSameOrigin(sender.tab.url, messageUrl)
  );
}

export function isMatchingSnapshotViewport(
  expected: ClickCapture['viewport'],
  expectedDevicePixelRatio: number,
  actual: ClickCapture['viewport'],
  actualDevicePixelRatio: number,
): boolean {
  return (
    expected.width === actual.width &&
    expected.height === actual.height &&
    Math.abs(expected.scrollX - actual.scrollX) < 1 &&
    Math.abs(expected.scrollY - actual.scrollY) < 1 &&
    expectedDevicePixelRatio === actualDevicePixelRatio
  );
}

export function isValidSnapshotViewportContext(
  viewport: unknown,
  devicePixelRatio: unknown,
): viewport is ClickCapture['viewport'] {
  if (!viewport || typeof viewport !== 'object') return false;
  const candidate = viewport as Partial<ClickCapture['viewport']>;
  return (
    Number.isFinite(candidate.width) &&
    candidate.width! > 0 &&
    Number.isFinite(candidate.height) &&
    candidate.height! > 0 &&
    Number.isFinite(candidate.scrollX) &&
    Number.isFinite(candidate.scrollY) &&
    Number.isFinite(devicePixelRatio) &&
    (devicePixelRatio as number) > 0
  );
}
