import type { Size } from '@/lib/shared/geometry';

/** Zoom and fit math for the image edit workspace. The workspace lays the
 * image out at `fit * zoom` pixels inside a scrollable viewport (no CSS
 * transforms), so handles and outlines keep their on-screen size at any zoom
 * and scrolling provides panning. */

/** Zoom is relative to the fitted size: 1 shows the whole image. */
export const MIN_ZOOM = 1;
/** How far past the fit any image can be zoomed. */
export const MAX_ZOOM = 8;
/** How far past its own size an image can always be zoomed, however small the fit
 * (a long page fitted into the window can be a tiny fraction of its real size). */
export const MAX_NATIVE_ZOOM = 2;
/** One step of the zoom buttons and keys. */
export const ZOOM_STEP = 1.25;

/** The largest zoom for an image shown at `fit`: 8x the fit, or twice the image's own size, whichever is larger. */
export function maxZoomFor(fit: Size | null, image: Size | null): number {
  if (!fit || !image || fit.width <= 0 || image.width <= 0) return MAX_ZOOM;
  return Math.max(MAX_ZOOM, (MAX_NATIVE_ZOOM * image.width) / fit.width);
}

/** The zoom as a share of the image's own size, which is what a percentage readout should mean. */
export function nativeZoom(zoom: number, fit: Size | null, image: Size | null): number {
  if (!fit || !image || fit.width <= 0 || image.width <= 0) return zoom;
  return (zoom * fit.width) / image.width;
}

export function clampZoom(zoom: number, maxZoom: number = MAX_ZOOM): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), Math.max(maxZoom, MIN_ZOOM));
}

/** The largest size that shows the whole image inside the viewport, keeping its aspect ratio. */
export function fitSize(viewport: Size, image: Size, margin: number): Size {
  const availableWidth = Math.max(viewport.width - margin * 2, 1);
  const availableHeight = Math.max(viewport.height - margin * 2, 1);
  if (image.width <= 0 || image.height <= 0) return { width: availableWidth, height: availableHeight };
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_PIXELS = 400;
/** Smaller is gentler: one typical mouse notch (100px) zooms by about 1.2x. */
const WHEEL_SENSITIVITY = 0.0018;

/** Multiplier for one wheel event; scrolling up zooms in. Line and page
 * deltas (mice, some browsers) are normalised to pixels first. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * WHEEL_LINE_PIXELS : deltaMode === 2 ? deltaY * WHEEL_PAGE_PIXELS : deltaY;
  return Math.exp(-pixels * WHEEL_SENSITIVITY);
}

/** Where a point on the image sits, as a fraction of the canvas. */
export interface ZoomAnchor {
  u: number;
  v: number;
  clientX: number;
  clientY: number;
}

export function anchorAt(
  client: { x: number; y: number },
  canvas: { left: number; top: number; width: number; height: number },
): ZoomAnchor | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  return {
    u: (client.x - canvas.left) / canvas.width,
    v: (client.y - canvas.top) / canvas.height,
    clientX: client.x,
    clientY: client.y,
  };
}

/** How far to scroll after a zoom so the anchored image point is back under
 * the pointer. `canvas` is the canvas rect measured after the zoom was laid out. */
export function scrollDeltaForAnchor(
  anchor: ZoomAnchor,
  canvas: { left: number; top: number; width: number; height: number },
): { dx: number; dy: number } {
  return {
    dx: canvas.left + anchor.u * canvas.width - anchor.clientX,
    dy: canvas.top + anchor.v * canvas.height - anchor.clientY,
  };
}
