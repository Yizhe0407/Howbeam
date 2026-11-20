import { describe, expect, it } from 'vitest';
import {
  cloneRedaction,
  getEntryPrivacyState,
  isValidRedaction,
  MOSAIC_BRUSH_LIMITS,
  sanitizeStepForStorage,
  type PixelateRedaction,
  type Redaction,
  type Step,
} from '@/lib/storage/models';
import {
  mosaicCellPixels,
  mosaicGridOffset,
  pixelateImageData,
  redactionKey,
} from '@/lib/media/redaction-render';
import { entryRasterInput, entryRasterKey } from '@/lib/export/entry-render';
import { NO_CROP_ORIGIN } from '@/lib/media/crop-offset';

const stroke = (overrides: Partial<PixelateRedaction> = {}): PixelateRedaction => ({
  id: 'stroke',
  kind: 'pixelate',
  points: [{ x: 10, y: 10 }, { x: 60, y: 30 }],
  size: 32,
  ...overrides,
});

/** An image where neighbouring pixels differ. */
function ramp(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set([index % 256, (index * 7) % 256, (index * 13) % 256, 255], index * 4);
  }
  return data;
}

const pixel = (data: Uint8ClampedArray, width: number, x: number, y: number): number[] =>
  Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe('pixelateImageData', () => {
  it('gives every grid cell one colour, the average of its pixels', () => {
    const data = new Uint8ClampedArray(4 * 2 * 4);
    // Left cell: two black and two white pixels; right cell: all red.
    data.set([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255], 0);
    data.set([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255], 16);
    pixelateImageData(data, 4, 2, 2);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) expect(pixel(data, 4, x, y)).toEqual([128, 128, 128, 255]);
    for (const [x, y] of [[2, 0], [3, 0], [2, 1], [3, 1]] as const) expect(pixel(data, 4, x, y)).toEqual([255, 0, 0, 255]);
  });

  it('keeps cells on the stored image grid when the buffer was cut from it at an offset', () => {
    const width = 12;
    const height = 8;
    const original = ramp(width, height);
    const full = original.slice();
    pixelateImageData(full, width, height, 4);

    // The same pixels, cut out from (2, 1).
    const cutWidth = 8;
    const cutHeight = 7;
    const cut = new Uint8ClampedArray(cutWidth * cutHeight * 4);
    for (let y = 0; y < cutHeight; y += 1) {
      cut.set(original.slice(((y + 1) * width + 2) * 4, ((y + 1) * width + 2 + cutWidth) * 4), y * cutWidth * 4);
    }
    pixelateImageData(cut, cutWidth, cutHeight, 4, 2, 1);

    // The full image cell (4..7, 4..7) lies wholly inside the cut at (2..5, 3..6): same colour everywhere.
    for (let y = 3; y < 7; y += 1) {
      for (let x = 2; x < 6; x += 1) expect(pixel(cut, cutWidth, x, y)).toEqual(pixel(full, width, x + 2, y + 1));
    }
  });

  it('averages a cell clipped by the image edge over the pixels it has', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 100, 50, 255, 10, 20, 30, 255]);
    pixelateImageData(data, 3, 1, 2);
    expect(pixel(data, 3, 0, 0)).toEqual([100, 50, 25, 255]);
    expect(pixel(data, 3, 2, 0)).toEqual([10, 20, 30, 255]);
  });
});

describe('mosaic grid', () => {
  it('is 16 CSS px at any capture scale', () => {
    expect(mosaicCellPixels(1)).toBe(16);
    expect(mosaicCellPixels(2)).toBe(32);
    expect(mosaicCellPixels(1.25)).toBe(20);
  });

  it('starts where a crop was cut from the stored screenshot', () => {
    expect(mosaicGridOffset(NO_CROP_ORIGIN, 2)).toEqual({ x: 0, y: 0 });
    expect(mosaicGridOffset({ x: 10.5, y: 3 }, 2)).toEqual({ x: 21, y: 6 });
  });
});

describe('mosaic strokes in storage', () => {
  it('accepts a stroke with a brush width storage allows and at least one point', () => {
    expect(isValidRedaction(stroke())).toBe(true);
    expect(isValidRedaction(stroke({ points: [{ x: 1, y: 1 }] }))).toBe(true);
    expect(isValidRedaction(stroke({ size: MOSAIC_BRUSH_LIMITS.minSize }))).toBe(true);
    expect(isValidRedaction(stroke({ size: MOSAIC_BRUSH_LIMITS.maxSize }))).toBe(true);
  });

  it('rejects strokes without points, with too many points, or with an unusable brush', () => {
    const tooMany = Array.from({ length: MOSAIC_BRUSH_LIMITS.maxPoints + 1 }, (_, x) => ({ x, y: 0 }));
    expect(isValidRedaction(stroke({ points: [] }))).toBe(false);
    expect(isValidRedaction(stroke({ points: tooMany }))).toBe(false);
    expect(isValidRedaction(stroke({ size: MOSAIC_BRUSH_LIMITS.minSize - 1 }))).toBe(false);
    expect(isValidRedaction(stroke({ size: MOSAIC_BRUSH_LIMITS.maxSize + 1 }))).toBe(false);
    expect(isValidRedaction(stroke({ size: 32.5 }))).toBe(false);
    expect(isValidRedaction(stroke({ points: [{ x: Number.NaN, y: 0 }] }))).toBe(false);
    expect(isValidRedaction({ ...stroke(), kind: 'blur' })).toBe(false);
  });

  it('copies only the fields a stroke has', () => {
    const withExtra = { ...stroke(), bounds: { x: 0, y: 0, width: 1, height: 1 }, points: [{ x: 1, y: 2, z: 3 }] } as unknown as Redaction;
    expect(cloneRedaction(withExtra)).toEqual({ id: 'stroke', kind: 'pixelate', points: [{ x: 1, y: 2 }], size: 32 });
  });

  it('keeps strokes through a storage write and fails closed on a broken one', () => {
    const step = {
      id: 'step',
      sessionId: 'project',
      order: 0,
      screenshotBlob: new Blob(['pixels'], { type: 'image/png' }),
      bounds: null,
      devicePixelRatio: 1,
      title: '',
      description: '',
      url: 'https://example.com',
      timestamp: 1,
      redactions: [stroke(), stroke({ id: 'broken', size: 4 })],
    } as Step;
    const stored = sanitizeStepForStorage(step);
    expect(stored.redactions).toEqual([stroke()]);
    expect(stored.redactionReviewRequired).toBe(true);
    expect(getEntryPrivacyState({ kind: 'single', step: step as Step & { screenshotBlob: Blob } }).reviewRequired).toBe(true);
  });
});

describe('mask identity', () => {
  it('tells strokes apart by shape and width, and solid masks by box', () => {
    expect(redactionKey(stroke())).toBe(redactionKey(stroke()));
    expect(redactionKey(stroke())).not.toBe(redactionKey(stroke({ size: 48 })));
    expect(redactionKey(stroke())).not.toBe(redactionKey(stroke({ points: [{ x: 10, y: 10 }] })));
    expect(redactionKey({ id: 'a', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 4 } }))
      .not.toBe(redactionKey({ id: 'a', kind: 'solid', bounds: { x: 1, y: 2, width: 3, height: 5 } }));
  });

  it('makes a new burned-in preview when a stroke or the mosaic grid changes', () => {
    const screenshotBlob = new Blob(['image'], { type: 'image/jpeg' });
    const key = (redactions: Redaction[], crop?: Step['crop']) => entryRasterKey(entryRasterInput({
      kind: 'single',
      step: {
        id: 'step', sessionId: 'project', order: 0, bounds: null, devicePixelRatio: 1,
        title: '', description: '', url: 'https://example.test', timestamp: 0,
        redactions, crop, screenshotBlob,
      },
    }), { format: 'image/jpeg' });
    const base = key([stroke()]);
    expect(key([stroke()])).toBe(base);
    expect(key([stroke({ size: 48 })])).not.toBe(base);
    // A crop moves where the image starts, and the mosaic grid with it.
    expect(key([stroke()], { x: 4, y: 0, width: 50, height: 50 })).not.toBe(base);
  });
});
