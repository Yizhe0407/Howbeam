// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLateClickSuppressor } from '@/lib/capture/step-capture';
import {
  STEP_DRAG_THRESHOLD_PX,
  type StepPressOutcome,
  STEP_PRESS_GATE_EVENTS,
  createStepPressGate,
  type StepPressGate,
} from '@/lib/capture/step-press-gate';
import { itemAt } from '../setup/item-at';

/** Events the "browser" dispatches; everything else is page/replay-made. */
const trusted = new WeakSet<Event>();
let busy = false;
let gate: StepPressGate;
let lateClicks = createLateClickSuppressor<Element>(2_000);
let target: HTMLButtonElement;
/** What page scripts observe on the target, in order, with trust markers. */
let seen: string[];

const pageListener = (event: Event) => {
  const detail = event instanceof MouseEvent && event.detail > 1 ? `:${event.detail}` : '';
  seen.push(`${trusted.has(event) ? '' : 'synthetic '}${event.type}${detail}`);
};

function fire<T extends Event>(event: T, at: EventTarget = target): T {
  trusted.add(event);
  at.dispatchEvent(event);
  return event;
}

const pointer = (type: string, init: PointerEventInit = {}) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
    ...init,
  });
const mouse = (type: string, init: MouseEventInit = {}) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, clientX: 10, clientY: 10, detail: 1, ...init });

/** Mirrors the recorder's pointerdown listener. */
function onPointerDown(event: Event) {
  if (!trusted.has(event)) return;
  gate.onTrustedPointerDown();
  lateClicks.onTrustedPointerDown();
  const pe = event as PointerEvent;
  if (pe.button !== 0) return;
  const begun = gate.begin(pe, target);
  if (begun.kind === 'step') presses.push(begun.press);
}
let presses: Array<Parameters<StepPressGate['replay']>[0]> = [];
const onGateEvent = (event: Event) => gate.handleEvent(event);

/** A full trusted click as Chromium emits it: the browser's click count is
 * reported on mousedown/mouseup/click (pointerdown carries none). */
function click(at = { clientX: 10, clientY: 10 }, detail = 1) {
  fire(pointer('pointerdown', { ...at, buttons: 1 }));
  fire(mouse('mousedown', { ...at, buttons: 1, detail }));
  fire(pointer('pointerup', { ...at, buttons: 0, detail }));
  fire(mouse('mouseup', { ...at, detail }));
  return fire(mouse('click', { ...at, detail }));
}

beforeEach(() => {
  busy = false;
  seen = [];
  presses = [];
  target = document.createElement('button');
  document.body.append(target);
  lateClicks = createLateClickSuppressor<Element>(2_000);
  gate = createStepPressGate({
    lateClicks,
    isBusy: () => busy,
    isTrusted: (event) => trusted.has(event),
  });
  document.addEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_PRESS_GATE_EVENTS) document.addEventListener(type, onGateEvent, { capture: true });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'dragstart', 'pointercancel']) {
    target.addEventListener(type, pageListener);
  }
});

afterEach(() => {
  document.removeEventListener('pointerdown', onPointerDown, { capture: true });
  for (const type of STEP_PRESS_GATE_EVENTS) document.removeEventListener(type, onGateEvent, { capture: true });
  document.body.replaceChildren();
});

describe('createStepPressGate', () => {
  it('withholds a click from the page without cancelling its native defaults, then replays it once', async () => {
    const down = pointer('pointerdown', { buttons: 1 });
    fire(down);
    // Defaults (caret placement, selection, focus) must still run natively.
    expect(down.defaultPrevented).toBe(false);
    const mouseDown = fire(mouse('mousedown', { buttons: 1 }));
    expect(mouseDown.defaultPrevented).toBe(false);
    fire(pointer('pointerup'));
    fire(mouse('mouseup'));
    const nativeClick = fire(mouse('click'));

    // The activation (navigation, toggling) waits for the screenshot.
    expect(nativeClick.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    await expect(itemAt(presses, 0).outcome).resolves.toBe('click');

    gate.replay(itemAt(presses, 0));
    gate.replay(itemAt(presses, 0));
    expect(seen).toEqual([
      'synthetic pointerdown',
      'synthetic mousedown',
      'synthetic pointerup',
      'synthetic mouseup',
      'synthetic click',
    ]);
  });

  it('settles a press on a dropdown select as a click at once, since its native popup takes the release', async () => {
    const select = document.createElement('select');
    select.append(new Option('一'), new Option('二'));
    document.body.append(select);
    target = select as unknown as HTMLButtonElement;
    fire(pointer('pointerdown', { buttons: 1 }), select);
    fire(mouse('mousedown', { buttons: 1 }), select);
    // No pointerup, mouseup or click ever reaches the document.
    await expect(itemAt(presses, 0).outcome).resolves.toBe('click');
  });

  it('keeps a list-box select (drawn in the page) held until it is released', async () => {
    const select = document.createElement('select');
    select.size = 4;
    document.body.append(select);
    target = select as unknown as HTMLButtonElement;
    fire(pointer('pointerdown', { buttons: 1 }), select);
    fire(pointer('pointermove', { buttons: 1, clientX: 40 }), select);
    await expect(itemAt(presses, 0).outcome).resolves.toBe('drag');
  });

  it('hands a drag back to the page and lets the rest of the gesture through untouched', async () => {
    fire(pointer('pointerdown', { buttons: 1 }));
    fire(mouse('mousedown', { buttons: 1 }));
    // Below the threshold it is still a (jittery) click.
    fire(pointer('pointermove', { buttons: 1, clientX: 10 + STEP_DRAG_THRESHOLD_PX - 1 }));
    expect(seen).toEqual([]);
    fire(pointer('pointermove', { buttons: 1, clientX: 40 }));
    expect(seen).toEqual(['synthetic pointerdown', 'synthetic mousedown']);
    await expect(itemAt(presses, 0).outcome).resolves.toBe('drag');

    busy = true; // an earlier capture in flight must not eat the drag's tail
    const up = fire(pointer('pointerup', { clientX: 40 }));
    fire(mouse('mouseup', { clientX: 40 }));
    const tailClick = fire(mouse('click', { clientX: 40 }));
    expect(up.defaultPrevented).toBe(false);
    expect(tailClick.defaultPrevented).toBe(false);
    expect(seen.slice(2)).toEqual(['pointerup', 'mouseup', 'click']);
  });

  it('classifies a native drag start as a drag before the page sees dragstart', async () => {
    fire(pointer('pointerdown', { buttons: 1 }));
    fire(mouse('mousedown', { buttons: 1 }));
    const dragStart = fire(new MouseEvent('dragstart', { bubbles: true, cancelable: true }));
    expect(dragStart.defaultPrevented).toBe(false);
    expect(seen).toEqual(['synthetic pointerdown', 'synthetic mousedown', 'dragstart']);
    await expect(itemAt(presses, 0).outcome).resolves.toBe('drag');
  });

  it('cancels the native drag when the page cancelled the press it was handed', () => {
    target.addEventListener('mousedown', (event) => event.preventDefault());
    fire(pointer('pointerdown', { buttons: 1 }));
    fire(pointer('pointermove', { buttons: 1, clientX: 60 }));
    const dragStart = fire(new MouseEvent('dragstart', { bubbles: true, cancelable: true }));
    expect(dragStart.defaultPrevented).toBe(true);
    expect(seen).not.toContain('dragstart');
  });

  it('gives the page its press before a browser pointercancel and records nothing', async () => {
    fire(pointer('pointerdown', { buttons: 1, pointerType: 'touch' }));
    fire(pointer('pointercancel', { pointerType: 'touch' }));
    await expect(itemAt(presses, 0).outcome).resolves.toBe('cancel');
    // Touch presses get no compatibility mousedown.
    expect(seen).toEqual(['synthetic pointerdown', 'pointercancel']);
  });

  /** Steps the recorder would actually record. */
  const recordedSteps = async () => {
    const outcomes: StepPressOutcome[] = await Promise.all(presses.map((press) => press.outcome));
    return outcomes.filter((outcome) => outcome === 'click').length;
  };

  it('folds a double click into one step and replays both clicks plus dblclick in order', async () => {
    click();
    const second = click(undefined, 2);
    const dblclick = fire(mouse('dblclick', { detail: 2 }));
    expect(await recordedSteps()).toBe(1);
    await expect(itemAt(presses, 1).outcome).resolves.toBe('merged');
    expect(second.defaultPrevented).toBe(true);
    expect(dblclick.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);

    gate.replay(itemAt(presses, 0));
    expect(seen).toEqual([
      'synthetic pointerdown',
      'synthetic mousedown',
      'synthetic pointerup',
      'synthetic mouseup',
      'synthetic click',
      'synthetic pointerdown:2',
      'synthetic mousedown:2',
      'synthetic pointerup:2',
      'synthetic mouseup:2',
      'synthetic click:2',
      'synthetic dblclick:2',
    ]);
  });

  it('lets the second press of a double click through natively once the first was replayed', async () => {
    click();
    gate.replay(itemAt(presses, 0));
    seen = [];
    busy = true;
    click(undefined, 2);
    fire(mouse('dblclick', { detail: 2 }));
    expect(await recordedSteps()).toBe(1);
    // The withheld pointerdown is handed over with the browser's count.
    expect(seen).toEqual(['synthetic pointerdown:2', 'mousedown:2', 'pointerup:2', 'mouseup:2', 'click:2', 'dblclick:2']);
  });

  it('folds at pointerdown when the engine already reports the click count there', async () => {
    click();
    fire(pointer('pointerdown', { buttons: 1, detail: 2 }));
    expect(presses).toHaveLength(1);
    fire(mouse('mousedown', { buttons: 1, detail: 2 }));
    fire(pointer('pointerup'));
    fire(mouse('mouseup', { detail: 2 }));
    fire(mouse('click', { detail: 2 }));
    gate.replay(itemAt(presses, 0));
    expect(seen.filter((entry) => entry.startsWith('synthetic click'))).toEqual(['synthetic click', 'synthetic click:2']);
  });

  it('keeps two separate clicks on the same spot as two steps, however close together', async () => {
    // The browser did not count them as one gesture (detail stays 1), so
    // neither may our recorder — no home-grown double-click timer.
    click();
    gate.replay(itemAt(presses, 0));
    click();
    expect(await recordedSteps()).toBe(2);
  });

  it('does not fold a counted click into a step on another element', async () => {
    click();
    const other = target;
    target = document.createElement('button');
    document.body.append(target);
    click(undefined, 2);
    expect(await recordedSteps()).toBe(2);
    target = other;
  });

  it('never swallows input aimed at Howbeam overlays, even mid-capture', () => {
    const toolbarHost = document.createElement('div');
    toolbarHost.setAttribute('data-howbeam-overlay', '');
    toolbarHost.setAttribute('data-howbeam-recording-toolbar', '');
    document.body.append(toolbarHost);
    click();
    busy = true;
    fire(pointer('pointerdown', { buttons: 1 }), toolbarHost);
    const up = fire(pointer('pointerup'), toolbarHost);
    const toolbarClick = fire(mouse('click'), toolbarHost);
    expect(up.defaultPrevented).toBe(false);
    expect(toolbarClick.defaultPrevented).toBe(false);
  });

  it('leaves keyboard activations to the legacy busy guard instead of the last press', () => {
    click();
    const keyboardClick = fire(mouse('click', { detail: 0 }));
    expect(keyboardClick.defaultPrevented).toBe(false);
    expect(seen).toEqual(['click']);
  });

  it('treats a press whose pointerup never arrived as released by the next press', async () => {
    fire(pointer('pointerdown', { buttons: 1 }));
    gate.onTrustedPointerDown();
    await expect(itemAt(presses, 0).outcome).resolves.toBe('click');
  });

  it('releases on a hover move without buttons (pointerup swallowed by a native popup)', async () => {
    fire(pointer('pointerdown', { buttons: 1 }));
    fire(pointer('pointermove', { buttons: 0, clientX: 80 }));
    await expect(itemAt(presses, 0).outcome).resolves.toBe('click');
  });

  it('abandon replays an uncaptured click and hands a held press back to the page', () => {
    click();
    gate.abandon(itemAt(presses, 0));
    expect(seen.filter((entry) => entry === 'synthetic click')).toHaveLength(1);

    seen = [];
    fire(pointer('pointerdown', { buttons: 1, clientX: 300 }));
    gate.clear();
    expect(seen).toEqual(['synthetic pointerdown', 'synthetic mousedown']);
  });

  describe('a press while a text field has focus', () => {
    let field: HTMLInputElement;

    /** A full trusted click whose mousedown is returned, so its default can be checked. */
    function clickReturningMouseDown(): MouseEvent {
      fire(pointer('pointerdown', { buttons: 1 }));
      const down = fire(mouse('mousedown', { buttons: 1 }));
      fire(pointer('pointerup', { buttons: 0 }));
      fire(mouse('mouseup'));
      fire(mouse('click'));
      return down;
    }

    beforeEach(() => {
      field = document.createElement('input');
      document.body.prepend(field);
      field.focus();
    });

    it('keeps the field focused until the replayed mousedown, which an autocomplete menu cancels', async () => {
      // Autocomplete menus keep focus in the field by cancelling mousedown on their items.
      target.addEventListener('mousedown', (event) => event.preventDefault());
      expect(clickReturningMouseDown().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(field);
      await expect(itemAt(presses, 0).outcome).resolves.toBe('click');

      gate.replay(itemAt(presses, 0));
      expect(document.activeElement).toBe(field);
      expect(seen).toContain('synthetic click');
    });

    it('moves focus on replay when the page does not cancel the mousedown, as the browser would', () => {
      clickReturningMouseDown();
      expect(document.activeElement).toBe(field);
      gate.replay(itemAt(presses, 0));
      expect(document.activeElement).toBe(target);
    });

    it('takes focus off the field on replay when the pressed content cannot hold focus', () => {
      const text = document.createElement('span');
      document.body.append(text);
      target = text as unknown as HTMLButtonElement;
      clickReturningMouseDown();
      gate.replay(itemAt(presses, 0));
      expect(document.activeElement).toBe(document.body);
    });

    it('leaves a press on another text field to the browser, so its caret lands natively', () => {
      const other = document.createElement('input');
      document.body.append(other);
      target = other as unknown as HTMLButtonElement;
      expect(clickReturningMouseDown().defaultPrevented).toBe(false);
    });

    it('gives a drag back with focus decided by the handed-over mousedown', () => {
      fire(pointer('pointerdown', { buttons: 1 }));
      fire(mouse('mousedown', { buttons: 1 }));
      expect(document.activeElement).toBe(field);
      fire(pointer('pointermove', { buttons: 1, clientX: 10 + STEP_DRAG_THRESHOLD_PX + 1 }));
      expect(document.activeElement).toBe(target);
    });
  });
});
