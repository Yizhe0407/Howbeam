import { isElementInteractionDisabled } from './selector/element-availability';

function getVisibleText(el: Element): string {
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  const lines = text?.split('\n') ?? [];
  return (lines.find((line) => line.trim().length > 0)?.trim() ?? '').slice(0, 80);
}

function getFieldLabel(el: Element): string {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
    return '';
  }
  return el.labels?.[0]?.innerText?.trim() || el.getAttribute('placeholder')?.trim() || '';
}

export function describeElement(el: Element): string {
  return (
    el.getAttribute('aria-label')?.trim() ||
    getFieldLabel(el) ||
    getVisibleText(el) ||
    el.getAttribute('title')?.trim() ||
    el.getAttribute('alt')?.trim() ||
    ''
  ).slice(0, 200);
}

/** Where and how a replayed activation is reported to page handlers. */
export interface ReplayClickOptions {
  clientX?: number;
  clientY?: number;
  /** Click count (UIEvent.detail): 2 for the second click of a double click. */
  detail?: number;
  /** False for a follow-up click of a multi-click, whose element already has focus.
   * `unless-cancelled` moves focus after the mousedown, only if the page did not cancel it. */
  focus?: boolean | 'unless-cancelled';
}

/** Moves focus the way a press on `el` does natively: to the nearest focusable
 * element at or above it, or off the current element when there is none. */
export function moveFocusAsPressed(el: Element): void {
  for (let node: Node | null = el; node; node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null)) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) continue;
    node.focus({ preventScroll: true });
    if (node.matches(':focus')) return;
  }
  (document.activeElement as HTMLElement | null)?.blur?.();
}

export function replayElementClick(el: Element, options: ReplayClickOptions = {}): void {
  if (isElementInteractionDisabled(el)) return;
  if (options.focus === undefined || options.focus === true) {
    const focus = (el as Element & { focus?: (options?: FocusOptions) => void }).focus;
    focus?.call(el, { preventScroll: true });
  }

  const detail = options.detail ?? 1;
  const coordinates = {
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
  };
  const mouseInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    detail,
    ...coordinates,
  };
  const pointerInit: PointerEventInit = {
    ...mouseInit,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 1,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
  const mouseDown = new MouseEvent('mousedown', { ...mouseInit, buttons: 1 });
  el.dispatchEvent(mouseDown);
  if (options.focus === 'unless-cancelled' && !mouseDown.defaultPrevented) moveFocusAsPressed(el);
  el.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { ...mouseInit, buttons: 0 }));

  // click() preserves control/default behavior (it is the canonical
  // activation), but always reports a single click. The follow-up click of a
  // multi-click is dispatched with its click count instead; an untrusted click
  // event still runs the element's activation behavior.
  const click = (el as Element & { click?: () => void }).click;
  if (typeof click === 'function' && detail === 1) {
    click.call(el);
    return;
  }
  el.dispatchEvent(new MouseEvent('click', mouseInit));
}

/** Fires the dblclick that follows the second click of a replayed double click. */
export function replayElementDoubleClick(el: Element, options: Pick<ReplayClickOptions, 'clientX' | 'clientY'> = {}): void {
  if (isElementInteractionDisabled(el)) return;
  el.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    detail: 2,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
  }));
}
