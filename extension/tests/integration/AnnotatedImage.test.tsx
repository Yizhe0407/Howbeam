// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnnotatedImage from '@/components/editor/AnnotatedImage';
import { BADGE_RADIUS, HIGHLIGHT_COLOR } from '@/lib/media/annotation-contract';
import type { AnnotationScene } from '@/lib/media/annotation-scene';
import { canvasOps, maskRects, setImageSize } from '../setup/canvas';

const EMPTY: AnnotationScene = {
  highlight: null,
  annotations: [],
  badges: true,
  imageEdits: [],
  redactions: [],
  privacyBlock: false,
};

/** Gives the canvas a laid-out box, as a browser would. */
function layOut(canvas: HTMLCanvasElement, box: { left?: number; top?: number; width: number; height: number }) {
  Object.defineProperties(canvas, {
    offsetLeft: { configurable: true, value: box.left ?? 0 },
    offsetTop: { configurable: true, value: box.top ?? 0 },
    clientWidth: { configurable: true, value: box.width },
    clientHeight: { configurable: true, value: box.height },
  });
}

let resize: (() => void) | null = null;

async function renderLaidOut(ui: React.ReactElement, box: { width: number; height: number }) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const view = render(ui);
  await act(async () => undefined);
  const canvas = view.container.querySelector('canvas')!;
  layOut(canvas, box);
  act(() => resize?.());
  return { view, canvas };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resize = null;
});

describe('AnnotatedImage', () => {
  it('draws the screenshot, then the highlight, then the masks, at the screenshot size for contain', async () => {
    const blob = new Blob(['shot']);
    setImageSize(blob, 1600, 1000);
    const scene: AnnotationScene = {
      ...EMPTY,
      highlight: { x: 100, y: 100, width: 200, height: 100 },
      redactions: [{ id: 'm', kind: 'solid', bounds: { x: 400, y: 300, width: 20, height: 10 } }],
    };
    const { canvas } = await renderLaidOut(
      <AnnotatedImage blob={blob} scene={scene} screenshotScale={2} alt="步驟" fit="contain" />,
      { width: 800, height: 500 },
    );

    expect([canvas.width, canvas.height]).toEqual([1600, 1000]);
    const ops = canvasOps(canvas).map((entry) => entry.op);
    const image = ops.indexOf('drawImage');
    const stroke = ops.indexOf('stroke');
    const mask = ops.lastIndexOf('fillRect');
    expect(image).toBeGreaterThan(-1);
    expect(stroke).toBeGreaterThan(image);
    expect(mask).toBeGreaterThan(stroke);
    // The mask is in screenshot pixels (CSS × 2), expanded by its 2px margin.
    expect(maskRects(canvas)).toEqual([[796, 596, 48, 28]]);
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toBe('步驟');
  });

  it('draws a cover thumbnail at its on-screen size and keeps the numbers readable there', async () => {
    const blob = new Blob(['shot']);
    setImageSize(blob, 2000, 1000);
    const scene: AnnotationScene = {
      ...EMPTY,
      annotations: [{ bounds: { x: 900, y: 400, width: 100, height: 100 }, order: 1 }],
    };
    const { canvas } = await renderLaidOut(
      <AnnotatedImage blob={blob} scene={scene} screenshotScale={1} alt="" fit="cover" />,
      { width: 100, height: 100 },
    );

    // Cover scales the 2000×1000 image by 0.1 to fill 100×100: 200×100 pixels are enough.
    expect([canvas.width, canvas.height]).toEqual([200, 100]);
    const badge = canvasOps(canvas).find(
      (entry) => entry.op === 'arc' && entry.args[2] !== undefined && (entry.args[2] as number) > BADGE_RADIUS,
    );
    // 7 on-screen pixels at 0.1 on-screen pixels per screenshot pixel.
    expect(badge?.args[2]).toBe(70);
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('lays an overlay over the image pixels, not the letterboxed box', async () => {
    const blob = new Blob(['shot']);
    setImageSize(blob, 1000, 500);
    const { view } = await renderLaidOut(
      <AnnotatedImage
        blob={blob}
        scene={EMPTY}
        screenshotScale={1}
        alt="x"
        fit="contain"
        overlay={<span>hint</span>}
      />,
      { width: 400, height: 400 },
    );

    const frame = view.container.querySelector<HTMLElement>('[data-howbeam-image-content-frame]')!;
    expect(frame.style).toMatchObject({ left: '0px', top: '100px', width: '400px', height: '200px' });
  });

  it('paints nothing of the screenshot while privacy review is pending', async () => {
    const blob = new Blob(['shot']);
    setImageSize(blob, 100, 50);
    const { canvas } = await renderLaidOut(
      <AnnotatedImage
        blob={blob}
        scene={{ ...EMPTY, privacyBlock: true, highlight: { x: 1, y: 1, width: 20, height: 20 } }}
        screenshotScale={1}
        alt="x"
        fit="contain"
      />,
      { width: 100, height: 50 },
    );

    const ops = canvasOps(canvas);
    expect(ops.some((entry) => entry.op === 'drawImage')).toBe(false);
    expect(ops.some((entry) => entry.strokeStyle === HIGHLIGHT_COLOR && entry.op === 'stroke')).toBe(false);
    expect(maskRects(canvas)).toEqual([[0, 0, 100, 50]]);
    expect(canvas.dataset.howbeamPrivacyBlock).toBe('true');
  });
});
