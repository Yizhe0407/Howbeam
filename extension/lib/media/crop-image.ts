import type { Bounds } from '../storage/models';
import { getValidScreenshotScale, rasterContext } from './image-utils';

/**
 * Non-destructive crop. The stored screenshot is never touched; a crop is
 * applied on the way to the screen or into an export by cutting the region out
 * and shifting every other coordinate by the region's origin (see crop-offset).
 */
export interface CroppedImage {
  blob: Blob;
  /** Top-left of the region in screenshot CSS pixels (a whole number of device pixels). */
  origin: { x: number; y: number };
}

export interface PixelRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** The crop as a whole-device-pixel rectangle inside the image, or null when it
 * covers the entire image (nothing to cut) or lies outside it. */
export function cropToPixels(crop: Bounds, dpr: number, naturalWidth: number, naturalHeight: number): PixelRect | null {
  const left = clamp(Math.round(crop.x * dpr), 0, naturalWidth - 1);
  const top = clamp(Math.round(crop.y * dpr), 0, naturalHeight - 1);
  const right = clamp(Math.round((crop.x + crop.width) * dpr), left + 1, naturalWidth);
  const bottom = clamp(Math.round((crop.y + crop.height) * dpr), top + 1, naturalHeight);
  if (!Number.isFinite(left + top + right + bottom)) return null;
  if (left === 0 && top === 0 && right === naturalWidth && bottom === naturalHeight) return null;
  return { sx: left, sy: top, sw: right - left, sh: bottom - top };
}

async function cut(blob: Blob, crop: Bounds, screenshotScale: number): Promise<CroppedImage | null> {
  const dpr = getValidScreenshotScale(screenshotScale);
  const full = await createImageBitmap(blob);
  const { width, height } = full;
  full.close();
  const rect = cropToPixels(crop, dpr, width, height);
  if (!rect) return null;
  const region = await createImageBitmap(blob, rect.sx, rect.sy, rect.sw, rect.sh);
  try {
    const canvas = new OffscreenCanvas(rect.sw, rect.sh);
    const ctx = rasterContext(canvas);
    ctx.drawImage(region, 0, 0);
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), origin: { x: rect.sx / dpr, y: rect.sy / dpr } };
  } finally {
    region.close();
  }
}

interface CacheEntry {
  key: string;
  promise: Promise<CroppedImage | null>;
}

/** One result per source image, so rendering the same entry again (another
 * preview size, a copy, an export) does not cut it again. */
const cache = new WeakMap<Blob, CacheEntry>();

const keyOf = (crop: Bounds, screenshotScale: number): string =>
  `${crop.x},${crop.y},${crop.width},${crop.height}@${screenshotScale}`;

export function getCroppedImage(blob: Blob, crop: Bounds, screenshotScale: number): Promise<CroppedImage | null> {
  const key = keyOf(crop, screenshotScale);
  const existing = cache.get(blob);
  if (existing?.key === key) return existing.promise;
  const entry: CacheEntry = { key, promise: cut(blob, crop, screenshotScale) };
  entry.promise = entry.promise.catch(
    (error: unknown) => {
      // A failed cut is not remembered, so the next request tries again.
      if (cache.get(blob) === entry) cache.delete(blob);
      throw error;
    },
  );
  cache.set(blob, entry);
  return entry.promise;
}
