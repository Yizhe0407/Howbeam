// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRegionCapture,
  isRegionRectInsideViewport,
  isRegionRectLargeEnough,
  moveRegionRect,
  normalizeRegionRect,
  placeRegionActions,
  resizeRegionRect,
} from '@/lib/capture/region-capture';

const viewport = { width: 100, height: 80 };

function pointerEvent(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
  });
  return event as PointerEvent;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  document.querySelectorAll('[data-howbeam-region-capture]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('region capture geometry', () => {
  it.each([
    [{ x: 20, y: 10 }, { x: 80, y: 70 }],
    [{ x: 80, y: 10 }, { x: 20, y: 70 }],
    [{ x: 20, y: 70 }, { x: 80, y: 10 }],
    [{ x: 80, y: 70 }, { x: 20, y: 10 }],
  ])('normalizes all drag directions', (start, end) => {
    expect(normalizeRegionRect(start, end, viewport)).toEqual({ x: 20, y: 10, width: 60, height: 60 });
  });

  it('clips both endpoints to the viewport', () => {
    expect(normalizeRegionRect({ x: -20, y: 10 }, { x: 120, y: 90 }, viewport)).toEqual({
      x: 0,
      y: 10,
      width: 100,
      height: 70,
    });
  });

  it('requires finite in-viewport rectangles of the minimum size', () => {
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: 7.99, height: 8 })).toBe(false);
    expect(isRegionRectLargeEnough({ x: 0, y: 0, width: Number.NaN, height: 8 })).toBe(false);
    expect(isRegionRectInsideViewport({ x: 92, y: 72, width: 8, height: 8 }, viewport)).toBe(true);
    expect(isRegionRectInsideViewport({ x: 93, y: 72, width: 8, height: 8 }, viewport)).toBe(false);
  });
});

describe('region adjustment geometry', () => {
  const box = { x: 20, y: 20, width: 40, height: 30 };

  it('moves a region but keeps it whole inside the viewport', () => {
    expect(moveRegionRect(box, 10, 5, viewport)).toEqual({ x: 30, y: 25, width: 40, height: 30 });
    expect(moveRegionRect(box, -50, -50, viewport)).toEqual({ x: 0, y: 0, width: 40, height: 30 });
    expect(moveRegionRect(box, 500, 500, viewport)).toEqual({ x: 60, y: 50, width: 40, height: 30 });
  });

  it('resizes from any handle, clips to the viewport and keeps the minimum size', () => {
    expect(resizeRegionRect(box, 'se', 10, 10, viewport)).toEqual({ x: 20, y: 20, width: 50, height: 40 });
    expect(resizeRegionRect(box, 'nw', -10, -5, viewport)).toEqual({ x: 10, y: 15, width: 50, height: 35 });
    expect(resizeRegionRect(box, 'e', 500, 99, viewport)).toEqual({ x: 20, y: 20, width: 80, height: 30 });
    expect(resizeRegionRect(box, 'w', 500, 0, viewport, 8)).toEqual({ x: 52, y: 20, width: 8, height: 30 });
    expect(resizeRegionRect(box, 's', 0, -500, viewport, 8)).toEqual({ x: 20, y: 20, width: 40, height: 8 });
  });
});

describe('placeRegionActions', () => {
  const size = { width: 40, height: 20 };

  it('sits under the selection corner, flips above at the bottom edge, and goes inside when neither fits', () => {
    expect(placeRegionActions({ x: 10, y: 10, width: 60, height: 20 }, viewport, size)).toEqual({ x: 30, y: 38 });
    expect(placeRegionActions({ x: 10, y: 40, width: 60, height: 38 }, viewport, size)).toEqual({ x: 30, y: 12 });
    expect(placeRegionActions({ x: 10, y: 2, width: 60, height: 76 }, viewport, size)).toEqual({ x: 30, y: 50 });
  });

  it('stays whole inside the viewport horizontally', () => {
    expect(placeRegionActions({ x: 0, y: 10, width: 20, height: 10 }, viewport, size).x).toBe(8);
    expect(placeRegionActions({ x: 80, y: 10, width: 20, height: 10 }, viewport, size).x).toBe(52);
  });
});

describe('createRegionCapture', () => {
  it('hides visuals, waits two frames, and keeps the blocker until capture settles', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let finishCapture!: () => void;
    const onCapture = vi.fn(() => new Promise<void>((resolve) => { finishCapture = resolve; }));
    const controller = createRegionCapture({ onCapture, viewport: () => viewport });
    const blocker = controller.host.shadowRoot!.querySelector<HTMLElement>('.ft-region-blocker')!;

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 12));
    blocker.dispatchEvent(pointerEvent('pointermove', 50, 52));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 52));

    // Releasing only draws the box: nothing is captured until it is confirmed.
    expect(controller.isCapturing()).toBe(false);
    expect(frames).toHaveLength(0);
    const confirm = controller.host.shadowRoot!.querySelector<HTMLButtonElement>('.ft-region-confirm')!;
    expect(confirm.hidden).toBe(false);
    confirm.click();

    expect(controller.isCapturing()).toBe(true);
    expect(blocker.dataset.capturing).toBe('true');
    expect(controller.host.isConnected).toBe(true);
    expect(onCapture).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()!(0);
    await flushMicrotasks();
    expect(onCapture).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    frames.shift()!(16);
    await flushMicrotasks();
    expect(onCapture).toHaveBeenCalledWith({ x: 10, y: 12, width: 40, height: 40 });
    expect(controller.host.isConnected).toBe(true);

    finishCapture();
    await flushMicrotasks();
    expect(controller.host.isConnected).toBe(false);
  });

  it('cycles Tab focus onto the cancel button through shadow retargeting', async () => {
    const controller = createRegionCapture({ onCapture: vi.fn(), viewport: () => viewport });
    const root = controller.host.shadowRoot!;
    const blocker = root.querySelector<HTMLElement>('.ft-region-blocker')!;
    const cancelButton = root.querySelector<HTMLButtonElement>('.ft-region-cancel')!;
    await flushMicrotasks(); // let the initial blocker focus land before spying
    const blockerFocus = vi.spyOn(blocker, 'focus');
    const cancelFocus = vi.spyOn(cancelButton, 'focus');
    const tab = () => new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true, cancelable: true });

    blocker.dispatchEvent(tab());
    expect(cancelFocus).toHaveBeenCalledTimes(1);
    expect(blockerFocus).not.toHaveBeenCalled();

    cancelButton.dispatchEvent(tab());
    expect(blockerFocus).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(true);
  });

  it('ignores Escape, resize, and cancel() while a capture is in flight', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    let finishCapture!: () => void;
    const onCapture = vi.fn(() => new Promise<void>((resolve) => { finishCapture = resolve; }));
    const onCancel = vi.fn();
    const controller = createRegionCapture({ onCapture, onCancel, viewport: () => viewport });
    const blocker = controller.host.shadowRoot!.querySelector<HTMLElement>('.ft-region-blocker')!;

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 12));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 52));
    controller.host.shadowRoot!.querySelector<HTMLButtonElement>('.ft-region-confirm')!.click();
    frames.shift()!(0);
    await flushMicrotasks();
    frames.shift()!(16);
    await flushMicrotasks();
    expect(onCapture).toHaveBeenCalledOnce();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    window.dispatchEvent(new Event('resize'));
    controller.cancel('user');

    // The in-flight capture owns the session outcome: no cancel, host intact.
    expect(onCancel).not.toHaveBeenCalled();
    expect(controller.host.isConnected).toBe(true);

    finishCapture();
    await flushMicrotasks();
    expect(controller.host.isConnected).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
    expect(onCapture).toHaveBeenCalledOnce();
  });

  it('lets the drawn box be moved and resized before it is confirmed with Enter', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const onCapture = vi.fn();
    const controller = createRegionCapture({ onCapture, viewport: () => viewport });
    const root = controller.host.shadowRoot!;
    const blocker = root.querySelector<HTMLElement>('.ft-region-blocker')!;
    const selection = root.querySelector<HTMLElement>('.ft-region-selection')!;
    expect(root.querySelector<HTMLButtonElement>('.ft-region-confirm')!.hidden).toBe(true);

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 40));
    expect(selection.dataset.interactive).toBe('true');

    // Drag inside the box to move it by (+20, +10).
    blocker.dispatchEvent(pointerEvent('pointerdown', 30, 25));
    blocker.dispatchEvent(pointerEvent('pointermove', 50, 35));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 35));
    // Drag the south-east handle by (+10, +10).
    const handle = root.querySelector<HTMLElement>('.ft-region-handle[data-handle="se"]')!;
    const down = pointerEvent('pointerdown', 70, 50);
    Object.defineProperty(down, 'target', { value: handle });
    blocker.dispatchEvent(down);
    blocker.dispatchEvent(pointerEvent('pointermove', 80, 60));
    blocker.dispatchEvent(pointerEvent('pointerup', 80, 60));
    expect(onCapture).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    frames.shift()!(0);
    await flushMicrotasks();
    frames.shift()!(16);
    await flushMicrotasks();
    expect(onCapture).toHaveBeenCalledWith({ x: 30, y: 20, width: 50, height: 40 });
  });

  it('does not treat a press on the panel buttons as a new box, so Cancel and the check mark work', () => {
    const onCancel = vi.fn();
    const controller = createRegionCapture({ onCapture: vi.fn(), onCancel, viewport: () => viewport });
    const root = controller.host.shadowRoot!;
    const blocker = root.querySelector<HTMLElement>('.ft-region-blocker')!;
    const selection = root.querySelector<HTMLElement>('.ft-region-selection')!;
    const confirm = root.querySelector<HTMLButtonElement>('.ft-region-confirm')!;

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 40));
    const press = pointerEvent('pointerdown', 20, 5);
    confirm.dispatchEvent(press);
    confirm.dispatchEvent(pointerEvent('pointerup', 20, 5));

    expect(selection.dataset.interactive).toBe('true');
    expect(confirm.hidden).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('starts a new box when the pointer goes down outside the adjustable one, and rejects a tiny box', () => {
    const controller = createRegionCapture({ onCapture: vi.fn(), viewport: () => viewport });
    const root = controller.host.shadowRoot!;
    const blocker = root.querySelector<HTMLElement>('.ft-region-blocker')!;
    const selection = root.querySelector<HTMLElement>('.ft-region-selection')!;

    blocker.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    blocker.dispatchEvent(pointerEvent('pointerup', 50, 40));
    blocker.dispatchEvent(pointerEvent('pointerdown', 80, 70));
    blocker.dispatchEvent(pointerEvent('pointerup', 82, 72));

    expect(selection.dataset.visible).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('.ft-region-confirm')!.hidden).toBe(true);
  });

  it('supports Escape cancellation without capturing', () => {
    const onCancel = vi.fn();
    const onCapture = vi.fn();
    const controller = createRegionCapture({ onCapture, onCancel, viewport: () => viewport });

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

    expect(onCancel).toHaveBeenCalledWith('escape');
    expect(onCapture).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });
});
