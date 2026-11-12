import type { Bounds } from '@/lib/storage/models';
import { clamp, type Size } from '@/lib/shared/geometry';

/**
 * Settles a dragged crop into what is stored: edges snapped to whole device
 * pixels (so the cut is exact and every coordinate stays aligned) and kept
 * inside the image. Returns null when the crop would cover the whole image, in
 * which case there is nothing to crop.
 */
export function snapCrop(bounds: Bounds, size: Size, dpr: number): Bounds | null {
  const snap = (value: number, max: number): number => clamp(Math.round(value * dpr) / dpr, 0, max);
  const left = snap(bounds.x, size.width);
  const top = snap(bounds.y, size.height);
  const right = snap(bounds.x + bounds.width, size.width);
  const bottom = snap(bounds.y + bounds.height, size.height);
  const unit = 1 / dpr;
  if (right - left < unit || bottom - top < unit) return null;
  if (left === 0 && top === 0 && right === size.width && bottom === size.height) return null;
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}
