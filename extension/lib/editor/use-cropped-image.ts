import { useEffect, useState } from 'react';
import { getCroppedImage, peekCroppedImage, type CroppedImage } from '@/lib/media/crop-image';
import { NO_CROP_ORIGIN, type CropOrigin } from '@/lib/media/crop-offset';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import type { Bounds } from '@/lib/storage/models';

export interface ImageView {
  /** The image to show: the stored screenshot, or its cropped region. */
  blob: Blob;
  /** Where that image sits inside the stored screenshot (zero when uncropped). */
  origin: CropOrigin;
}

/**
 * The image a preview should show for a crop, together with the origin its
 * coordinates are relative to. They are returned as one pair on purpose:
 * while a new crop is being cut, the previous pair stays on screen intact, so
 * masks and drawings are never placed against pixels from a different crop.
 * Returns null only while the very first cut of an image is still running; the
 * uncropped screenshot is never shown in the meantime, because it may contain
 * exactly what the crop removes.
 */
export function useCroppedImage(blob: Blob, crop: Bounds | null, screenshotScale: number): ImageView | null {
  const dpr = getValidScreenshotScale(screenshotScale);
  const [resolved, setResolved] = useState<{ source: Blob; image: CroppedImage | null; crop: Bounds } | null>(null);

  useEffect(() => {
    if (!crop) return undefined;
    if (peekCroppedImage(blob, crop, dpr)) return undefined;
    let cancelled = false;
    getCroppedImage(blob, crop, dpr).then(
      (image) => {
        if (!cancelled) setResolved({ source: blob, image, crop });
      },
      (error) => console.error('[howbeam] failed to crop the image', error),
    );
    return () => {
      cancelled = true;
    };
  }, [blob, crop, dpr]);

  if (!crop) return { blob, origin: NO_CROP_ORIGIN };
  const settled = peekCroppedImage(blob, crop, dpr);
  if (settled) return settled.value ? { blob: settled.value.blob, origin: settled.value.origin } : { blob, origin: NO_CROP_ORIGIN };
  if (resolved && resolved.source === blob) {
    return resolved.image ? { blob: resolved.image.blob, origin: resolved.image.origin } : { blob, origin: NO_CROP_ORIGIN };
  }
  return null;
}
