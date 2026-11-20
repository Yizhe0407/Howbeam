import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  clampZoom,
  fitSize,
  MAX_ZOOM,
  maxZoomFor,
  MIN_ZOOM,
  scrollDeltaForAnchor,
  wheelZoomFactor,
} from '@/lib/editor/image-edit-viewport';

describe('fitSize', () => {
  it('fits the whole image inside the viewport minus the margin, keeping the aspect ratio', () => {
    expect(fitSize({ width: 1000, height: 600 }, { width: 800, height: 400 }, 20)).toEqual({ width: 960, height: 480 });
    expect(fitSize({ width: 1000, height: 600 }, { width: 400, height: 800 }, 20)).toEqual({ width: 280, height: 560 });
  });

  it('never returns a collapsed size for a tiny viewport', () => {
    const size = fitSize({ width: 10, height: 10 }, { width: 100, height: 100 }, 24);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });
});

describe('zoom', () => {
  it('clamps to the supported range', () => {
    expect(clampZoom(0.2)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(2)).toBe(2);
  });

  it('lets a long screenshot zoom to at least twice its own size, not just 8x its tiny fit', () => {
    const image = { width: 1280, height: 16_000 };
    const fit = fitSize({ width: 1400, height: 848 }, image, 24);
    const max = maxZoomFor(fit, image);
    // At the max zoom the image is laid out at twice its native width.
    expect((fit.width * max) / image.width).toBeCloseTo(2);
    expect(clampZoom(1_000, max)).toBe(max);
    expect(clampZoom(1_000, max)).toBeGreaterThan(MAX_ZOOM);
  });

  it('lets a long page fitted far below its own size zoom to twice that size', () => {
    const image = { width: 1280, height: 16_000 };
    const fit = fitSize({ width: 1400, height: 848 }, image, 24);
    expect((maxZoomFor(fit, image) * fit.width) / image.width).toBeCloseTo(2);
  });

  it('keeps 8x the fit for ordinary images and before anything is measured', () => {
    expect(maxZoomFor({ width: 960, height: 480 }, { width: 800, height: 400 })).toBe(MAX_ZOOM);
    expect(maxZoomFor(null, null)).toBe(MAX_ZOOM);
  });

  it('turns wheel deltas into zoom factors: up zooms in, down zooms out, lines count like pixels', () => {
    expect(wheelZoomFactor(-100, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, 0) * wheelZoomFactor(100, 0)).toBeCloseTo(1);
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48, 0));
  });

  it('keeps the image point under the pointer fixed after a zoom', () => {
    // Pointer at (300, 200) over a canvas spanning 100..500 x 100..300: u=0.5, v=0.5.
    const anchor = anchorAt({ x: 300, y: 200 }, { left: 100, top: 100, width: 400, height: 200 })!;
    expect(anchor).toMatchObject({ u: 0.5, v: 0.5 });

    // After zooming 2x the canvas is laid out at 800x400 starting at left=-100 (centred in a scroller).
    const { dx, dy } = scrollDeltaForAnchor(anchor, { left: -100, top: 0, width: 800, height: 400 });
    // The point is now at x=-100+0.5*800=300 and y=0+0.5*400=200, exactly under the pointer: nothing to scroll.
    expect(dx).toBe(0);
    expect(dy).toBe(0);

    // If layout put the canvas 50px further left, scrolling by -50 brings it back.
    expect(scrollDeltaForAnchor(anchor, { left: -150, top: 0, width: 800, height: 400 }).dx).toBe(-50);
  });

  it('has no anchor for an unmeasured canvas', () => {
    expect(anchorAt({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });
});
