// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RedactionsCanvas from '@/components/editor/RedactionsCanvas';
import type { PixelateRedaction, Redaction } from '@/lib/storage/models';

/** Records the calls a canvas receives, by name. */
let calls: string[];

beforeEach(() => {
  calls = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext(this: HTMLCanvasElement) {
    return {
      canvas: this,
      fillStyle: '',
      clearRect: record('clearRect'),
      fillRect: record('fillRect'),
      beginPath: () => undefined,
      arc: () => undefined,
      closePath: () => undefined,
      save: () => undefined,
      restore: () => undefined,
      clip: record('clip'),
      fill: record('fill'),
      drawImage: record('drawImage'),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mosaic = {} as ImageBitmap;
const box: Redaction = { id: 'box', kind: 'solid', bounds: { x: 1, y: 1, width: 10, height: 10 } };
const stroke = (count: number): PixelateRedaction => ({
  id: 'stroke',
  kind: 'pixelate',
  points: Array.from({ length: count }, (_, index) => ({ x: 20 + index * 5, y: 30 })),
  size: 32,
});

function paint(redactions: Redaction[], view?: ReturnType<typeof render>) {
  const element = <RedactionsCanvas redactions={redactions} width={200} height={100} dpr={1} mosaic={mosaic} />;
  if (view) {
    view.rerender(element);
    return view;
  }
  return render(element);
}

describe('RedactionsCanvas', () => {
  it('paints a growing stroke one stretch at a time, without repainting what is there', () => {
    const view = paint([box, stroke(1)]);
    expect(calls).toEqual(['clearRect', 'fillRect', 'clip', 'drawImage']);

    calls = [];
    paint([box, stroke(4)], view);
    // Three new stretches, each the mosaic seen through one capsule.
    expect(calls).toEqual(['clip', 'drawImage', 'clip', 'drawImage', 'clip', 'drawImage']);
  });

  it('starts a new stroke without repainting the masks before it', () => {
    const view = paint([box]);
    calls = [];
    paint([box, stroke(2)], view);
    expect(calls).toEqual(['clip', 'drawImage', 'clip', 'drawImage']);
  });

  it('repaints everything when anything but the growing stroke changes', () => {
    const view = paint([box, stroke(2)]);
    calls = [];
    paint([{ ...box, bounds: { ...box.bounds, x: 5 } }, stroke(3)], view);
    expect(calls[0]).toBe('clearRect');

    calls = [];
    paint([box], view);
    expect(calls).toEqual(['clearRect', 'fillRect']);
  });

  it('paints strokes solid until the mosaic exists', () => {
    render(<RedactionsCanvas redactions={[stroke(2)]} width={200} height={100} dpr={1} mosaic={null} />);
    expect(calls).toEqual(['clearRect', 'fill', 'fill']);
  });
});
