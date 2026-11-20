import type { Bounds, PixelateRedaction, Redaction, RedactionPoint } from '../storage/models';
import { REDACTION_COLOR, REDACTION_EXPANSION } from './annotation-contract';
import type { CropOrigin } from './crop-offset';
import { isValidImageBounds, rasterContext } from './image-utils';

/**
 * How privacy masks look, shared by the raster compositor (exports, clipboard,
 * burned-in previews) and the live SVG overlay, so a mask hides exactly the
 * same pixels everywhere.
 *
 * A mosaic stroke shows the screenshot itself pixelated: the source pixels are
 * averaged over a fixed grid of square cells anchored at the top-left of the
 * stored (uncropped) screenshot, and the stroke reveals that pixelated image.
 * Because the grid belongs to the screenshot, overlapping strokes, crops and
 * every preview agree on each cell's colour. What was drawn on top of the
 * screenshot (highlights, text, arrows) is covered, never pixelated into it.
 */

/** Side of one mosaic cell in screenshot CSS px. Fixed: it decides how much survives, so it is not a style choice. */
export const MOSAIC_CELL_SIZE = 16;

/** Side of one mosaic cell in device pixels at a capture scale. */
export function mosaicCellPixels(dpr: number): number {
  return Math.max(1, Math.round(MOSAIC_CELL_SIZE * dpr));
}

/** Where the grid starts inside an image cut out of the screenshot at `origin`, in that image's device pixels. */
export function mosaicGridOffset(origin: CropOrigin, dpr: number): { x: number; y: number } {
  return { x: Math.round(origin.x * dpr), y: Math.round(origin.y * dpr) };
}

/**
 * Replaces every grid cell of an RGBA buffer with the average of its pixels.
 * `offsetX/Y` is where the buffer sits inside the image the grid is anchored to.
 */
export function pixelateImageData(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cell: number,
  offsetX = 0,
  offsetY = 0,
): void {
  const firstLeft = -(((offsetX % cell) + cell) % cell);
  const firstTop = -(((offsetY % cell) + cell) % cell);
  for (let top = firstTop; top < height; top += cell) {
    const y0 = Math.max(top, 0);
    const y1 = Math.min(top + cell, height);
    for (let left = firstLeft; left < width; left += cell) {
      const x0 = Math.max(left, 0);
      const x1 = Math.min(left + cell, width);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
          a += data[i + 3]!;
        }
      }
      const count = (x1 - x0) * (y1 - y0);
      if (count === 0) continue;
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      a = Math.round(a / count);
      for (let y = y0; y < y1; y += 1) {
        for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
          data[i + 3] = a;
        }
      }
    }
  }
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** A pixelated copy of what `source` currently holds, on the grid of the screenshot it was cut from at `origin`. */
export function pixelatedCopy(source: OffscreenCanvas, dpr: number, origin: CropOrigin): OffscreenCanvas {
  const { width, height } = source;
  const copy = new OffscreenCanvas(width, height);
  const ctx = rasterContext(copy);
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, width, height);
  const offset = mosaicGridOffset(origin, dpr);
  pixelateImageData(image.data, width, height, mosaicCellPixels(dpr), offset.x, offset.y);
  ctx.putImageData(image, 0, 0);
  return copy;
}

/** Returns a solid mask's expanded CSS-pixel rect clipped to the screenshot.
 * `null` means the mask lies wholly outside the drawable bitmap. */
export function getExpandedRedactionBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
): Bounds | null {
  if (!isValidImageBounds(bounds) || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }
  const left = Math.max(0, bounds.x - REDACTION_EXPANSION);
  const top = Math.max(0, bounds.y - REDACTION_EXPANSION);
  const right = Math.min(viewportWidth, bounds.x + bounds.width + REDACTION_EXPANSION);
  const bottom = Math.min(viewportHeight, bounds.y + bounds.height + REDACTION_EXPANSION);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The painted width of a mosaic stroke in CSS px: the brush, grown by the same margin as a solid mask. */
export function mosaicStrokeWidth(redaction: Pick<PixelateRedaction, 'size'>): number {
  return redaction.size + REDACTION_EXPANSION * 2;
}

/** SVG path data of a stroke's centre line. A single point is drawn by the cap disc alone. */
export function mosaicStrokePath(points: readonly RedactionPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('');
}

/** The disc at a stroke's start: stroked lines skip zero-length paths, so a click must still cover its spot. */
export function mosaicStrokeCap(redaction: PixelateRedaction): { cx: number; cy: number; r: number } {
  const [first] = redaction.points;
  return { cx: first!.x, cy: first!.y, r: mosaicStrokeWidth(redaction) / 2 };
}

/** Traces one stretch of a stroke: the disc a brush leaves at `from`, swept to `to`. */
function traceCapsule(ctx: Canvas2D, from: RedactionPoint, to: RedactionPoint, radius: number, dpr: number): void {
  const ax = from.x * dpr;
  const ay = from.y * dpr;
  const bx = to.x * dpr;
  const by = to.y * dpr;
  const r = radius * dpr;
  ctx.beginPath();
  if (ax === bx && ay === by) {
    ctx.arc(ax, ay, r, 0, Math.PI * 2);
    return;
  }
  const angle = Math.atan2(by - ay, bx - ax);
  ctx.arc(ax, ay, r, angle + Math.PI / 2, angle + (Math.PI * 3) / 2);
  ctx.arc(bx, by, r, angle - Math.PI / 2, angle + Math.PI / 2);
  ctx.closePath();
}

/**
 * Paints a mosaic stroke from its `start`-th point on, one capsule per stretch
 * between points (the first point alone is a disc), each showing `mosaic`
 * through it. A brush paints exactly this way while the stroke is being drawn,
 * so the editor can add only the newest stretch and still match a full redraw.
 * Without a mosaic the stroke is painted solid, never left open.
 */
export function paintMosaicStroke(
  ctx: Canvas2D,
  stroke: Pick<PixelateRedaction, 'points' | 'size'>,
  mosaic: CanvasImageSource | null,
  dpr: number,
  start = 0,
): void {
  const radius = mosaicStrokeWidth(stroke) / 2;
  const { points } = stroke;
  for (let index = Math.max(start, 0); index < points.length; index += 1) {
    const to = points[index]!;
    const from = points[index - 1] ?? to;
    traceCapsule(ctx, from, to, radius, dpr);
    if (!mosaic) {
      ctx.fillStyle = REDACTION_COLOR;
      ctx.fill();
      continue;
    }
    // Only the stretch's own box is copied, not the whole mosaic under the clip.
    const left = Math.max(Math.floor((Math.min(from.x, to.x) - radius) * dpr), 0);
    const top = Math.max(Math.floor((Math.min(from.y, to.y) - radius) * dpr), 0);
    const right = Math.min(Math.ceil((Math.max(from.x, to.x) + radius) * dpr), ctx.canvas.width);
    const bottom = Math.min(Math.ceil((Math.max(from.y, to.y) + radius) * dpr), ctx.canvas.height);
    if (right <= left || bottom <= top) continue;
    ctx.save();
    ctx.clip();
    ctx.drawImage(mosaic, left, top, right - left, bottom - top, left, top, right - left, bottom - top);
    ctx.restore();
  }
}

export const hasMosaic = (redactions: readonly Redaction[]): boolean =>
  redactions.some((redaction) => redaction.kind === 'pixelate');

/** Paints every mask in order. `mosaic` is the pixelated screenshot, required when any mask is a mosaic stroke. */
export function drawRedactions(
  ctx: Canvas2D,
  redactions: readonly Redaction[],
  viewportWidth: number,
  viewportHeight: number,
  dpr: number,
  mosaic: CanvasImageSource | null,
): void {
  for (const redaction of redactions) {
    if (redaction.kind === 'pixelate') {
      paintMosaicStroke(ctx, redaction, mosaic, dpr);
      continue;
    }
    const bounds = getExpandedRedactionBounds(redaction.bounds, viewportWidth, viewportHeight);
    if (bounds) {
      ctx.fillStyle = REDACTION_COLOR;
      ctx.fillRect(bounds.x * dpr, bounds.y * dpr, bounds.width * dpr, bounds.height * dpr);
    }
  }
}

const keyCache = new WeakMap<Redaction, string>();

/** A string that differs whenever the pixels a mask hides differ. Masks are immutable, so it is computed once per mask. */
export function redactionKey(redaction: Redaction): string {
  let key = keyCache.get(redaction);
  if (key === undefined) {
    key = redaction.kind === 'solid'
      ? `s${redaction.bounds.x},${redaction.bounds.y},${redaction.bounds.width},${redaction.bounds.height}`
      : `p${redaction.size}:${redaction.points.map((point) => `${point.x},${point.y}`).join(';')}`;
    keyCache.set(redaction, key);
  }
  return key;
}
