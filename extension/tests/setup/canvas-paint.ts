import { vi } from 'vitest';

/** jsdom has no 2D canvas: records the rectangles a canvas fills, with the colour each was filled in. */
export function recordCanvasFills(): Array<{ rect: number[]; fill: string }> {
  const fills: Array<{ rect: number[]; fill: string }> = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    const ctx = {
      fillStyle: '',
      clearRect: () => fills.splice(0),
      fillRect: (...rect: number[]) => fills.push({ rect, fill: ctx.fillStyle }),
    };
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  return fills;
}
