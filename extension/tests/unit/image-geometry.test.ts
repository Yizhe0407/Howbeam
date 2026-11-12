// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createImageCoordinateMapper } from '@/lib/capture/image-geometry';

function defineMetric(image: HTMLImageElement, name: string, value: number): void {
  Object.defineProperty(image, name, { configurable: true, value });
}

afterEach(() => document.body.replaceChildren());

describe('createImageCoordinateMapper', () => {
  it('maps displayed CSS coordinates through border-box scaling without intrinsic-image rescaling', () => {
    const image = document.createElement('img');
    image.style.padding = '4px';
    image.style.objectFit = 'fill';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 100);
    defineMetric(image, 'offsetHeight', 80);
    defineMetric(image, 'naturalWidth', 1_000);
    defineMetric(image, 'naturalHeight', 500);
    image.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 160 }) as DOMRect;

    const mapper = createImageCoordinateMapper(image)!;

    expect(mapper.coordinateBounds).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(mapper.imageBounds).toEqual({ x: 100, y: 50, width: 200, height: 160 });
    expect(mapper.toImagePoint(200, 130)).toEqual({ x: 50, y: 40 });
    expect(mapper.toViewportBounds({ x: 25, y: 20, width: 50, height: 40 })).toEqual({
      x: 150,
      y: 90,
      width: 100,
      height: 80,
    });
  });

  it('uses the border-box origin even when the image has border and padding', () => {
    const image = document.createElement('img');
    image.style.border = '10px solid';
    image.style.padding = '20px';
    image.style.objectFit = 'contain';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 160);
    defineMetric(image, 'offsetHeight', 140);
    defineMetric(image, 'clientLeft', 10);
    defineMetric(image, 'clientTop', 10);
    defineMetric(image, 'clientWidth', 140);
    defineMetric(image, 'clientHeight', 120);
    defineMetric(image, 'naturalWidth', 1_000);
    defineMetric(image, 'naturalHeight', 500);
    image.getBoundingClientRect = () => ({ left: 100, top: 50, width: 160, height: 140 }) as DOMRect;

    const mapper = createImageCoordinateMapper(image)!;

    expect(mapper.coordinateBounds).toEqual({ x: 0, y: 0, width: 160, height: 140 });
    expect(mapper.toImagePoint(105, 55)).toEqual({ x: 5, y: 5 });
    expect(mapper.toViewportBounds({ x: 0, y: 0, width: 20, height: 20 })).toEqual({
      x: 100,
      y: 50,
      width: 20,
      height: 20,
    });
  });

  it('preserves fractional border-box dimensions instead of integer offset metrics', () => {
    const image = document.createElement('img');
    image.style.width = '100.5px';
    image.style.height = '50.5px';
    image.style.boxSizing = 'border-box';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 101);
    defineMetric(image, 'offsetHeight', 51);
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100.5, height: 50.5 }) as DOMRect;

    const mapper = createImageCoordinateMapper(image)!;

    expect(mapper.coordinateBounds).toEqual({ x: 0, y: 0, width: 100.5, height: 50.5 });
    expect(mapper.toImagePoint(100.3, 25.25)).toEqual({ x: 100.3, y: 25.25 });
    expect(mapper.toViewportBounds({ x: 100.25, y: 0, width: 0.25, height: 50.5 })).toEqual({
      x: 100.25,
      y: 0,
      width: 0.25,
      height: 50.5,
    });
  });

  it('keeps object-fit letterboxing outside the image-map coordinate calculation', () => {
    const image = document.createElement('img');
    image.style.objectFit = 'contain';
    image.style.objectPosition = '50% 50%';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 200);
    defineMetric(image, 'offsetHeight', 200);
    defineMetric(image, 'naturalWidth', 1_000);
    defineMetric(image, 'naturalHeight', 500);
    image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 200 }) as DOMRect;

    const mapper = createImageCoordinateMapper(image)!;

    expect(mapper.toImagePoint(15, 25)).toEqual({ x: 5, y: 5 });
    expect(mapper.toViewportBounds({ x: 0, y: 0, width: 200, height: 200 })).toEqual({
      x: 10,
      y: 20,
      width: 200,
      height: 200,
    });
  });

  it('maps image areas through a rotated border-box quad', () => {
    const image = document.createElement('img') as HTMLImageElement & {
      getBoxQuads: () => Array<{
        p1: { x: number; y: number };
        p2: { x: number; y: number };
        p3: { x: number; y: number };
        p4: { x: number; y: number };
      }>;
    };
    image.style.objectFit = 'fill';
    document.body.append(image);
    defineMetric(image, 'offsetWidth', 100);
    defineMetric(image, 'offsetHeight', 100);
    image.getBoxQuads = () => [
      {
        p1: { x: 200, y: 100 },
        p2: { x: 200, y: 300 },
        p3: { x: 0, y: 300 },
        p4: { x: 0, y: 100 },
      },
    ];

    const mapper = createImageCoordinateMapper(image)!;

    expect(mapper.toImagePoint(100, 150)).toEqual({ x: 25, y: 50 });
    expect(mapper.toViewportBounds({ x: 10, y: 20, width: 30, height: 40 })).toEqual({
      x: 80,
      y: 120,
      width: 80,
      height: 60,
    });
  });
});
