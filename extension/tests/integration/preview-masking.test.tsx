// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redaction, ScreenshotStep, Step, StepEntry } from '@/lib/storage/models';
import { installThumbnailDomStubs, stubImageMetrics } from '../setup/thumbnail-dom';

vi.mock('@/lib/capture/raster-image-validation', () => ({
  validateRasterImageBlob: vi.fn(async (blob: Blob) => {
    const image = await decode(blob);
    return { width: image.width, height: image.height, mediaType: 'image/jpeg' };
  }),
}));

import EntryThumbnail from '@/components/editor/EntryThumbnail';

/**
 * A tiny pixel-exact stand-in for the browser's raster pipeline: an "encoded
 * image" is JSON holding its RGB pixels, createImageBitmap decodes it (with the
 * optional source rectangle a crop uses), and OffscreenCanvas implements the
 * drawImage/fillRect the compositor needs. That lets these tests run the real
 * crop and mask compositor and inspect the pixels a preview <img> would show.
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
  const value = Number.parseInt(hex[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

class PixelCanvas {
  readonly pixels: number[][];
  constructor(readonly width: number, readonly height: number) {
    this.pixels = Array.from({ length: width * height }, () => [0, 0, 0]);
  }
  getContext() {
    const { width: canvasWidth, height: canvasHeight, pixels: canvasPixels } = this;
    const canvas = { width: canvasWidth, height: canvasHeight, pixels: canvasPixels };
    return {
      fillStyle: '#000000',
      drawImage(bitmap: Raster) {
        for (let y = 0; y < Math.min(bitmap.height, canvas.height); y++) {
          for (let x = 0; x < Math.min(bitmap.width, canvas.width); x++) {
            canvas.pixels[y * canvas.width + x] = [...bitmap.pixels[y * bitmap.width + x]];
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
    };
  }
  async convertToBlob(options?: { type?: string }) {
    return encode({ width: this.width, height: this.height, pixels: this.pixels }, options?.type);
  }
}

let urls: Map<string, Blob>;

function installRasterFakes() {
  vi.stubGlobal('OffscreenCanvas', PixelCanvas);
  vi.stubGlobal('createImageBitmap', async (blob: Blob, sx?: number, sy?: number, sw?: number, sh?: number) => {
    const full = await decode(blob);
    if (sx === undefined || sy === undefined || sw === undefined || sh === undefined) return { ...full, close() {} };
    const pixels: number[][] = [];
    for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) pixels.push(full.pixels[y * full.width + x]);
    return { width: sw, height: sh, pixels, close() {} };
  });
  urls = new Map();
  let next = 0;
  vi.mocked(URL.createObjectURL).mockImplementation((blob) => {
    const url = `blob:preview-${++next}`;
    urls.set(url, blob as Blob);
    return url;
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

async function shownRaster(container: HTMLElement): Promise<{ img: HTMLImageElement; blob: Blob; raster: Raster }> {
  const img = container.querySelector('img');
  expect(img, 'a preview image is shown').not.toBeNull();
  const blob = urls.get(img!.getAttribute('src')!);
  expect(blob, 'the preview src is an object URL made here').toBeDefined();
  return { img: img!, blob: blob!, raster: await decode(blob!) };
}

const pixelAt = (raster: Raster, x: number, y: number) => raster.pixels[y * raster.width + x];

function expectNeverShown(source: Blob) {
  expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob)).not.toContain(source);
}

beforeEach(() => {
  installThumbnailDomStubs();
  installRasterFakes();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('preview masking', () => {
  it('shows a single step with its mask burned into the pixels, never the stored screenshot', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={singleEntry(source)} alt="step" fit="contain" />);

    // Nothing at all while the masked image is being made.
    expect(view.container.querySelector('img')).toBeNull();
    await settle();

    const { img, blob, raster } = await shownRaster(view.container);
    expect(blob).not.toBe(source);
    expect(img.draggable).toBe(false);
    expect([raster.width, raster.height]).toEqual([12, 8]);
    for (const [x, y] of [[2, 1], [4, 3], [7, 5]]) expect(pixelAt(raster, x, y), `masked ${x},${y}`).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 8, 3)).toEqual([18, 13, 200]);
    expect(pixelAt(raster, 0, 0)).toEqual([10, 10, 200]);
    expectNeverShown(source);
  });

  it('burns the mask into a group screenshot as well', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={groupEntry(source)} alt="group" fit="contain" />);
    await settle();

    const { raster } = await shownRaster(view.container);
    expect(pixelAt(raster, 4, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 9, 6)).toEqual([19, 16, 200]);
    expectNeverShown(source);
  });

  it('masks the cropped image with the mask shifted by the crop, and never shows the unmasked cut', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { crop: { x: 3, y: 2, width: 8, height: 5 } })} alt="cropped" fit="contain" />,
    );
    await settle();

    const { raster } = await shownRaster(view.container);
    expect([raster.width, raster.height]).toEqual([8, 5]);
    // Source (4,3) lands at (1,1) of the cut; source (9,4) at (6,2).
    expect(pixelAt(raster, 1, 1)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 4, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(raster, 6, 2)).toEqual([19, 14, 200]);
    const shownBlobs = vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => blob as Blob);
    expect(shownBlobs).toHaveLength(1);
    expectNeverShown(source);
  });

  it('shows only black pixels while privacy review is pending', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { redactions: [], redactionReviewRequired: true })} alt="review" fit="contain" />,
    );
    await settle();

    const { raster } = await shownRaster(view.container);
    expect(raster.pixels.every((pixel) => pixel.join() === '0,0,0')).toBe(true);
    expectNeverShown(source);
  });

  it('shows nothing when the masked image cannot be made', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('createImageBitmap', async () => {
      throw new Error('decode failed');
    });
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={singleEntry(source)} alt="broken" fit="contain" />);
    await settle();

    expect(view.container.querySelector('img')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows the stored screenshot as-is when it has nothing to hide', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={singleEntry(source, { redactions: [] })} alt="plain" fit="contain" />);

    const { blob } = await shownRaster(view.container);
    expect(blob).toBe(source);
  });

  it('never shows a stale image that lacks a newly added mask, but keeps one that hides more', async () => {
    const source = screenshot(12, 8);
    const second: Redaction = { id: 'mask-2', kind: 'solid', bounds: { x: 9, y: 5, width: 1, height: 1 } };
    const view = render(<EntryThumbnail entry={singleEntry(source)} alt="step" fit="contain" />);
    await settle();
    const first = (await shownRaster(view.container)).blob;

    view.rerender(<EntryThumbnail entry={singleEntry(source, { redactions: [mask, second] })} alt="step" fit="contain" />);
    expect(view.container.querySelector('img')).toBeNull();
    await settle();
    const both = await shownRaster(view.container);
    expect(both.blob).not.toBe(first);
    expect(pixelAt(both.raster, 10, 6)).toEqual([0, 0, 0]);

    // Removing a mask: the image with both masks stays up until the new one is ready.
    view.rerender(<EntryThumbnail entry={singleEntry(source, { redactions: [second] })} alt="step" fit="contain" />);
    expect((await shownRaster(view.container)).blob).toBe(both.blob);
    await settle();
    const onlySecond = await shownRaster(view.container);
    expect(pixelAt(onlySecond.raster, 4, 3)).toEqual([14, 13, 200]);
    expect(pixelAt(onlySecond.raster, 10, 6)).toEqual([0, 0, 0]);
    expectNeverShown(source);
  });

  it('composites each image once for every preview showing it', async () => {
    const source = screenshot(12, 8);
    const entry = singleEntry(source);
    const view = render(
      <>
        <EntryThumbnail entry={entry} alt="rail" fit="contain" loading="lazy" />
        <EntryThumbnail entry={entry} alt="stage" fit="contain" />
        <EntryThumbnail entry={entry} alt="lightbox" fit="contain" />
      </>,
    );
    await settle();

    const images = [...view.container.querySelectorAll('img')];
    expect(images).toHaveLength(3);
    expect(new Set(images.map((img) => img.getAttribute('src'))).size).toBe(1);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(images[0].getAttribute('loading')).toBe('lazy');
  });

  it('lets only the image editor show the stored pixels, under live masks, and not be dragged or saved from the menu', async () => {
    const source = screenshot(12, 8);
    const view = render(<EntryThumbnail entry={singleEntry(source)} crop={null} alt="editor" fit="contain" exactBox liveMasks />);

    const { img, blob } = await shownRaster(view.container);
    expect(blob).toBe(source);
    expect(img.draggable).toBe(false);
    expect(fireEvent.contextMenu(img)).toBe(false);
    stubImageMetrics(img, { naturalWidth: 12, naturalHeight: 8, rendered: { width: 120, height: 80 } });
    act(() => fireEvent.load(img));
    expect(view.container.querySelector('[data-howbeam-redaction="mask-1"]')).not.toBeNull();
  });

  it('keeps the editor fail-closed while privacy review is pending', async () => {
    const source = screenshot(12, 8);
    const view = render(
      <EntryThumbnail entry={singleEntry(source, { redactionReviewRequired: true })} crop={null} alt="editor" fit="contain" exactBox liveMasks />,
    );
    await settle();

    const { raster } = await shownRaster(view.container);
    expect(raster.pixels.every((pixel) => pixel.join() === '0,0,0')).toBe(true);
    expectNeverShown(source);
  });
});
