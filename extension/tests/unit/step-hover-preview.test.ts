// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStepHoverPreview, type StepHoverPreview } from '@/lib/recording/step-hover-preview';
import { createViewportOverlayHost } from '@/lib/capture/viewport-overlay-host';
import type { Bounds } from '@/lib/storage/models';

// The highlight lives in a closed shadow root, so the only way to assert what
// was painted is to observe the calls the preview makes into it.
const stepPreview = vi.hoisted(() => ({
  shown: [] as Bounds[],
  hidden: 0,
  removed: 0,
}));

vi.mock('@/lib/capture/step-preview', () => ({
  createStepPreview: () => ({
    show: (bounds: Bounds) => stepPreview.shown.push(bounds),
    hide: () => {
      stepPreview.hidden += 1;
    },
    prepareForCapture: () => Promise.resolve(),
    remove: () => {
      stepPreview.removed += 1;
    },
  }),
}));

function makeVisible(element: Element, rect: { x: number; y: number; width: number; height: number }): void {
  const box = {
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => rect,
  };
  Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => box });
  Object.defineProperty(element, 'getClientRects', { configurable: true, value: () => [box] });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('step hover preview', () => {
  let preview: StepHoverPreview;
  let paused: boolean;
  let gestureActive: boolean;
  let regionCaptureActive: boolean;
  let text: HTMLElement;
  let sibling: HTMLElement;

  beforeEach(() => {
    const article = document.createElement('article');
    const card = document.createElement('div');
    text = document.createElement('span');
    sibling = document.createElement('span');
    card.append(text, sibling);
    article.append(card);
    document.body.append(article);
    makeVisible(article, { x: 0, y: 0, width: 600, height: 400 });
    makeVisible(card, { x: 20, y: 20, width: 300, height: 120 });
    makeVisible(text, { x: 30, y: 30, width: 90, height: 24 });
    makeVisible(sibling, { x: 200, y: 30, width: 80, height: 24 });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: (clientX: number) => (clientX < 150 ? text : sibling),
    });

    stepPreview.shown = [];
    stepPreview.hidden = 0;
    stepPreview.removed = 0;
    paused = false;
    gestureActive = false;
    regionCaptureActive = false;
    preview = createStepHoverPreview({
      isPaused: () => paused,
      isGestureActive: () => gestureActive,
      isRegionCaptureActive: () => regionCaptureActive,
    });
  });

  afterEach(() => {
    preview.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  async function hover(clientX = 40, clientY = 40): Promise<void> {
    preview.handlers.onPointerMove({ clientX, clientY } as PointerEvent);
    await nextFrame();
  }

  it('draws the highlight on the box under the pointer and captures the same box', async () => {
    await hover();

    expect(stepPreview.shown.at(-1)).toEqual({ x: 30, y: 30, width: 90, height: 24 });
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });

  it('follows the pointer to a new box', async () => {
    await hover();
    await hover(220, 40);

    expect(stepPreview.shown.at(-1)).toEqual({ x: 200, y: 30, width: 80, height: 24 });
    expect(preview.resolveTargetAt(220, 40)).toBe(sibling);
    // Nothing is retained between points: the first box is reachable again.
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });

  it('hides the highlight when suspended', async () => {
    await hover();
    const hiddenBefore = stepPreview.hidden;

    preview.suspend();

    expect(stepPreview.hidden).toBe(hiddenBefore + 1);
  });

  it('stays hidden while a capture gesture is in flight', async () => {
    await hover();
    gestureActive = true;
    const shownBefore = stepPreview.shown.length;

    preview.schedule();
    await nextFrame();

    expect(stepPreview.shown).toHaveLength(shownBefore);
  });

  it('drops the highlight when the pointer leaves the window', async () => {
    await hover();
    const hiddenBefore = stepPreview.hidden;

    preview.handlers.onPointerLeave({ clientX: -5, clientY: -5, relatedTarget: null } as PointerEvent);

    expect(stepPreview.hidden).toBe(hiddenBefore + 1);
  });

  it('freezes on its last page target while the pointer is over recorder UI', async () => {
    await hover();
    const overlayHost = createViewportOverlayHost('data-howbeam-recording-toolbar');
    document.body.append(overlayHost);
    makeVisible(overlayHost, { x: 400, y: 400, width: 200, height: 60 });

    preview.handlers.onPointerMove({ clientX: 500, clientY: 500, target: overlayHost } as unknown as PointerEvent);
    await nextFrame();

    // Reaching undo or the crop control means travelling across the page.
    // Retargeting on the way would drop the box the user was aiming at.
    expect(stepPreview.shown.at(-1)).toEqual({ x: 30, y: 30, width: 90, height: 24 });
    expect(preview.resolveTargetAt(40, 40)).toBe(text);
  });

  it('ignores pointer moves while paused or cropping a region', async () => {
    await hover();
    const shownBefore = stepPreview.shown.length;

    paused = true;
    await hover(220, 40);
    paused = false;
    regionCaptureActive = true;
    await hover(220, 40);

    expect(stepPreview.shown).toHaveLength(shownBefore);
  });
});
