// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HIGHLIGHT_LINE_WIDTH, HIGHLIGHT_PADDING } from '@/lib/media/annotation-contract';
import { createStepPreview } from '@/lib/capture/step-preview';

afterEach(() => {
  document.documentElement.querySelectorAll('[data-howbeam-step-preview]').forEach((element) => element.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createStepPreview', () => {
  it('renders, hides, remounts, and removes a click-through preview frame', async () => {
    let shadowRoot: ShadowRoot | null = null;
    const originalAttachShadow = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init) {
      shadowRoot = originalAttachShadow.call(this, { ...init, mode: 'open' });
      return shadowRoot;
    });
    const preview = createStepPreview();
    const host = document.querySelector<HTMLElement>('[data-howbeam-step-preview]')!;
    const box = shadowRoot!.querySelector<HTMLElement>('.preview')!;

    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
    expect(box.style.borderStyle).toBe('solid');
    expect(box.style.borderWidth).toBe(`${HIGHLIGHT_LINE_WIDTH}px`);
    expect(box.style.getPropertyPriority('border')).toBe('important');
    expect(box.style.boxShadow).toBe('none');
    expect(box.hidden).toBe(true);
    expect(box.style.display).toBe('none');
    preview.show({ x: 20, y: 30, width: 100, height: 40 });
    expect(box.hidden).toBe(false);
    expect(box.style.display).toBe('block');
    expect(box.style.left).toBe(`${20 - HIGHLIGHT_PADDING}px`);
    expect(box.style.top).toBe(`${30 - HIGHLIGHT_PADDING}px`);

    preview.hide();
    expect(box.hidden).toBe(true);
    expect(box.style.display).toBe('none');

    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    preview.show({ x: 20, y: 30, width: 100, height: 40 });
    await preview.prepareForCapture();
    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(box.style.display).toBe('none');

    host.remove();
    await vi.waitFor(() => expect(host.isConnected).toBe(true));

    preview.remove();
    expect(host.isConnected).toBe(false);
  });
});
