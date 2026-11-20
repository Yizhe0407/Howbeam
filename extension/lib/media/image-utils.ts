/** Returns a finite, positive screenshot-pixel-to-CSS-pixel scale. Corrupt or
 * invalid metadata must never create infinite/zero viewport geometry. */
export function getValidScreenshotScale(value: number | null | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}

export interface ImageBounds { x: number; y: number; width: number; height: number }

export function isValidImageBounds(bounds: ImageBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

/**
 * A 2D context for raster work: drawing a screenshot, reading its pixels back,
 * encoding it. It is kept in CPU memory, because on a GPU-backed canvas every
 * pixel read and encode is a synchronous readback through the GPU process,
 * stalling the frames the page is drawing at the same time.
 */
export function rasterContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Unable to create a 2D canvas context.');
  return ctx;
}
