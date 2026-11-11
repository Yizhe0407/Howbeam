// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redaction, ScreenshotStep, Step, StepEntry } from '@/lib/storage/models';

vi.mock('@/lib/capture/raster-image-validation', () => ({
  validateRasterImageBlob: vi.fn(async (blob: Blob) => {
    const image = await decode(blob);
    return { width: image.width, height: image.height, mediaType: 'image/jpeg' };
  }),
}));

import EntryThumbnail from '@/components/editor/EntryThumbnail';
import { itemAt } from '../setup/item-at';

/**
 * A tiny pixel-exact stand-in for the browser's raster pipeline: an "encoded
 * image" is JSON holding its RGB pixels, createImageBitmap decodes it (with the
 * optional source rectangle a crop uses), and OffscreenCanvas implements the
 * drawImage/fillRect the compositor needs. That lets these tests run the real
 * crop pipeline and the preview's own drawing, and inspect the pixels the
 * preview canvas shows.
 */
interface Raster {
  width: number;
  height: number;
  pixels: number[][];
}

async function decode(blob: Blob): Promise<Raster> {
  return JSON.parse(await blob.text()) as Raster;
}

function encode(raster: Raster, type = 'image/jpeg'): Blob {
  return new Blob([JSON.stringify(raster)], { type });
}

/** Every source pixel is a distinct, non-black colour, so any leaked pixel is detectable. */
function screenshot(width: number, height: number): Blob {
  const pixels: number[][] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.push([10 + x, 10 + y, 200]);
  return encode({ width, height, pixels });
}

function parseColor(style: string): number[] {
  const hex = /^#([0-9a-f]{6})$/i.exec(style);
  if (!hex) throw new Error(`unsupported fill style ${style}`);
  const value = Number.parseInt(itemAt(hex, 1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

class PixelCanvas {
  readonly pixels: number[][];
  constructor(readonly width: number, readonly height: number) {
    this.pixels = Array.from({ length: width * height }, () => [0, 0, 0]);
  }
  getContext() {
    return pixelContext(this);
  }
  async convertToBlob(options?: { type?: string }) {
    return encode({ width: this.width, height: this.height, pixels: this.pixels }, options?.type);
  }
}

/** drawImage and fillRect paint pixels; every other drawing call (strokes, text) is ignored. */
function pixelContext(canvas: { width: number; height: number; pixels: number[][] }) {
  const painter = {
      fillStyle: '#000000' as string,
      drawImage(bitmap: Raster) {
        for (let y = 0; y < Math.min(bitmap.height, canvas.height); y++) {
          for (let x = 0; x < Math.min(bitmap.width, canvas.width); x++) {
            canvas.pixels[y * canvas.width + x] = [...itemAt(bitmap.pixels, y * bitmap.width + x)];
          }
        }
      },
      fillRect(left: number, top: number, width: number, height: number) {
        const color = parseColor(this.fillStyle);
        const x0 = Math.max(0, Math.floor(left));
        const y0 = Math.max(0, Math.floor(top));
        const x1 = Math.min(canvas.width, Math.ceil(left + width));
        const y1 = Math.min(canvas.height, Math.ceil(top + height));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) canvas.pixels[y * canvas.width + x] = [...color];
      },
      clearRect() {
        canvas.pixels.forEach((_, index) => { canvas.pixels[index] = [255, 255, 255]; });
      },
  };
  return new Proxy(painter, {
    get: (target, key) => (key in target ? target[key as keyof typeof target] : () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 })),
    set: (target, key, value) => {
      (target as Record<string | symbol, unknown>)[key] = value;
      return true;
    },
  });
}

/** The preview canvases' pixels, kept per canvas and resized with it. */
const previewPixels = new WeakMap<HTMLCanvasElement, { width: number; height: number; pixels: number[][] }>();

function installPreviewCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
    let store = previewPixels.get(this);
    if (!store || store.width !== this.width || store.height !== this.height) {
      store = { width: this.width, height: this.height, pixels: Array.from({ length: this.width * this.height }, () => [255, 255, 255]) };
      previewPixels.set(this, store);
    }
    return pixelContext(store) as unknown as CanvasRenderingContext2D;
  } as never);
}

function installRasterFakes() {
  vi.stubGlobal('OffscreenCanvas', PixelCanvas);
  vi.stubGlobal('createImageBitmap', async (blob: Blob, sx?: number, sy?: number, sw?: number, sh?: number) => {
    const full = await decode(blob);
    if (sx === undefined || sy === undefined || sw === undefined || sh === undefined) return { ...full, close() {} };
    const pixels: number[][] = [];
    for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) pixels.push(itemAt(full.pixels, y * full.width + x));
    return { width: sw, height: sh, pixels, close() {} };
  });
}

function makeStep(changes: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    sessionId: 'session-1',
    order: 0,
    bounds: { x: 1, y: 1, width: 2, height: 2 },
    devicePixelRatio: 1,
    description: '',
    url: 'https://example.test',
    timestamp: 0,
    ...changes,
  };
}

/** The 2px safety margin is added around every mask, so this one hides x 2..7, y 1..5 of a 12x8 shot. */
const mask: Redaction = { id: 'mask-1', kind: 'solid', bounds: { x: 4, y: 3, width: 2, height: 1 } };

function singleEntry(source: Blob, changes: Partial<ScreenshotStep> = {}): StepEntry {
  return { kind: 'single', step: { ...makeStep({ redactions: [mask] }), screenshotBlob: source, ...changes } as ScreenshotStep };
}

function groupEntry(source: Blob): StepEntry {
  return {
    kind: 'group',
    anchor: { ...makeStep({ id: 'group-1', groupId: 'group-1', bounds: null, redactions: [mask] }), screenshotBlob: source } as ScreenshotStep,
    annotations: [makeStep({ id: 'annotation-1', groupId: 'group-1', order: 1 })],
  };
}

/** Lets the async decode/composite/encode chain settle. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function shownRaster(container: HTMLElement): Raster {
  const canvas = container.querySelector('canvas');
  expect(canvas, 'a preview canvas is shown').not.toBeNull();
  const store = previewPixels.get(canvas!);
  expect(store, 'the preview has been drawn').toBeDefined();
  return { width: store!.width, height: store!.height, pixels: store!.pixels };
}

const pixelAt = (raster: Raster, x: number, y: number) => raster.pixels[y * raster.width + x];

beforeEach(() => {
  installRasterFakes();
  installPreviewCanvas();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview masking', () => {
  it('draws a single step with its mask in the same pixels', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={singleEntry(source)} alt="step" fit="contain" />);
    await settle();

    const raster = shownRaster(view.container);
    expect([raster.width, raster.height]).toEqual([12, 8]);
    for (const [x, y] of [[2, 1], [4, 3], [7, 5]] as const) expect(pixelAt(raster, x, y), `masked ${x},${y}`).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 8, 3)).toEqual([18, 13, 200]);
    expect(pixelAt(raster, 0, 0)).toEqual([10, 10, 200]);
  });

  it('masks a group screenshot as well', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={groupEntry(source)} alt="group" fit="contain" />);
    await settle();

    const raster = shownRaster(view.container);
    expect(pixelAt(raster, 4, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 9, 6)).toEqual([19, 16, 200]);
  });

  it('masks the cropped image with the mask shifted by the crop', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { crop: { x: 3, y: 2, width: 8, height: 5 } })} alt="cropped" fit="contain" />,
    );
    await settle();

    const raster = shownRaster(view.container);
    expect([raster.width, raster.height]).toEqual([8, 5]);
    // Source (4,3) lands at (1,1) of the cut; source (9,4) at (6,2).
    expect(pixelAt(raster, 1, 1)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 4, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 6, 2)).toEqual([19, 14, 200]);
  });

  it('draws only black pixels while privacy review is pending', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { redactions: [], redactionReviewRequired: true })} alt="review" fit="contain" />,
    );
    await settle();

    const raster = shownRaster(view.container);
    expect(raster.pixels.every((pixel) => pixel.join() === '0,0,0')).toBe(true);
    expect(view.container.querySelector('canvas')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows nothing when the screenshot cannot be decoded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('decode failed');
    });
    const view = render(<EntryThumbnail entry={singleEntry(screenshot(12, 8))} alt="broken" fit="contain" />);
    await settle();

    const canvas = view.container.querySelector('canvas')!;
    expect(previewPixels.has(canvas)).toBe(false);
    expect(canvas.style.visibility).toBe('hidden');
  });

  it('applies an added or removed mask in the very next frame', async () => {
    const source = screenshot(12, 8);
    const second: Redaction = { id: 'mask-2', kind: 'solid', bounds: { x: 9, y: 5, width: 1, height: 1 } };
    const view = render(<EntryThumbnail entry={singleEntry(source)} alt="step" fit="contain" />);
    await settle();

    view.rerender(<EntryThumbnail entry={singleEntry(source, { redactions: [mask, second] })} alt="step" fit="contain" />);
    expect(pixelAt(shownRaster(view.container), 10, 6)).toEqual([0, 0, 0]);

    view.rerender(<EntryThumbnail entry={singleEntry(source, { redactions: [second] })} alt="step" fit="contain" />);
    const onlySecond = shownRaster(view.container);
    expect(pixelAt(onlySecond, 4, 3)).toEqual([14, 13, 200]);
    expect(pixelAt(onlySecond, 10, 6)).toEqual([0, 0, 0]);
  });

  it('lets the image editor show the pixels under review, with the masks still drawn', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { redactionReviewRequired: true })} crop={null} reviewing alt="editor" fit="contain" />,
    );
    await settle();

    const raster = shownRaster(view.container);
    expect(pixelAt(raster, 4, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 0, 0)).toEqual([10, 10, 200]);
  });
});
