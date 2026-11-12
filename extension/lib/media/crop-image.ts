import type { Bounds } from '../storage/models';
import { getValidScreenshotScale } from './image-utils';
import { clamp } from '@/lib/shared/geometry';

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
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create a 2D canvas context.');
    ctx.drawImage(region, 0, 0);
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), origin: { x: rect.sx / dpr, y: rect.sy / dpr } };
  } finally {
    region.close();
  }
}

interface CacheEntry {
  key: string;
  promise: Promise<CroppedImage | null>;
  /** Set once the cut has finished, so renders can read it without waiting. */
  settled?: { value: CroppedImage | null };
}

/** One result per source image: re-cutting on every render would be wasteful,
 * and a stable Blob identity lets every consumer share one object URL. */
const cache = new WeakMap<Blob, CacheEntry>();

const keyOf = (crop: Bounds, screenshotScale: number): string =>
  `${crop.x},${crop.y},${crop.width},${crop.height}@${screenshotScale}`;

export function getCroppedImage(blob: Blob, crop: Bounds, screenshotScale: number): Promise<CroppedImage | null> {
  const key = keyOf(crop, screenshotScale);
  const existing = cache.get(blob);
  if (existing?.key === key) return existing.promise;
  const entry: CacheEntry = { key, promise: cut(blob, crop, screenshotScale) };
  entry.promise = entry.promise.then(
    (value) => {
      entry.settled = { value };
      return value;
    },
    (error) => {
      // A failed cut is not remembered, so the next request tries again.
      if (cache.get(blob) === entry) cache.delete(blob);
      throw error;
    },
  );
  cache.set(blob, entry);
  return entry.promise;
}

/** The result if it has already been computed, so a render can use it immediately. */
export function peekCroppedImage(blob: Blob, crop: Bounds, screenshotScale: number): { value: CroppedImage | null } | undefined {
  const existing = cache.get(blob);
  return existing?.key === keyOf(crop, screenshotScale) ? existing.settled : undefined;
}
