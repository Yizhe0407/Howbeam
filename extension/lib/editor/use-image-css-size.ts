import { useEffect, useState } from 'react';
import { getValidScreenshotScale } from '@/lib/media/image-utils';
import type { Size } from '@/lib/shared/geometry';

/** The screenshot's size in CSS pixels (decoded pixels / capture scale): the
 * coordinate space redactions and every other image edit are stored in.
 * Resolves to null until the blob has been decoded. */
export function useImageCssSize(blob: Blob | undefined, screenshotScale: number): Size | null {
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    if (!blob || typeof createImageBitmap !== 'function') {
      setSize(null);
      return;
    }
    let cancelled = false;
    const scale = getValidScreenshotScale(screenshotScale);
    createImageBitmap(blob).then(
      (bitmap) => {
        const next = { width: bitmap.width / scale, height: bitmap.height / scale };
        bitmap.close();
        if (!cancelled) setSize(next);
      },
      () => {
        if (!cancelled) setSize(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [blob, screenshotScale]);

  return size;
}
