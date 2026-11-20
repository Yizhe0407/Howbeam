import { useEffect, useState } from 'react';
import { getMosaicBitmap } from '@/lib/media/mosaic-bitmap';
import { NO_CROP_ORIGIN, type CropOrigin } from '@/lib/media/crop-offset';
import { hasMosaic } from '@/lib/media/redaction-render';
import type { Redaction } from '@/lib/storage/models';
import { useObjectUrl } from './use-object-url';

export interface PreviewImageOptions {
  /** Masks in the source image's CSS coordinates. */
  redactions: readonly Redaction[];
  screenshotScale: number;
  /** Privacy metadata is unreviewed: no source pixel may be shown at all. */
  privacyReviewRequired: boolean;
  /** Where the source was cut from the stored screenshot, so mosaic cells stay on its grid.
   * Keep its identity stable while it is unchanged: a new object makes a new mosaic. */
  mosaicOrigin?: CropOrigin;
}

export interface PreviewImage {
  /** Object URL of the stored pixels, or null while none may be shown. */
  url: string | null;
  /** The source pixelated on the mosaic grid, for painting mosaic strokes over
   * the stored pixels. Null while it is being made (or not needed): strokes
   * are painted solid meanwhile. */
  liveMosaic: ImageBitmap | null;
}

/** The source pixelated on the mosaic grid, while `wanted`. */
function useMosaicBitmap(source: Blob, screenshotScale: number, origin: CropOrigin, wanted: boolean): ImageBitmap | null {
  const [made, setMade] = useState<{ source: Blob; screenshotScale: number; origin: CropOrigin; bitmap: ImageBitmap } | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let cancelled = false;
    getMosaicBitmap(source, screenshotScale, origin).then(
      (bitmap) => {
        if (!cancelled) setMade({ source, screenshotScale, origin, bitmap });
      },
      (error) => console.error('[howbeam] failed to pixelate the image', error),
    );
    return () => {
      cancelled = true;
    };
  }, [source, screenshotScale, origin, wanted]);
  return wanted && made?.source === source && made.screenshotScale === screenshotScale && made.origin === origin ? made.bitmap : null;
}

/**
 * The stored screenshot for the image editor, whose masks are painted live
 * over it because they move with every gesture and must show what they cover.
 * Everywhere else shows the finished raster with the masks burned in (see
 * useEntryPreview). While privacy review is pending no pixel is handed out.
 */
export function usePreviewImage(
  source: Blob,
  { redactions, screenshotScale, privacyReviewRequired, mosaicOrigin = NO_CROP_ORIGIN }: PreviewImageOptions,
): PreviewImage {
  const url = useObjectUrl(privacyReviewRequired ? null : source) || null;
  const liveMosaic = useMosaicBitmap(source, screenshotScale, mosaicOrigin, !privacyReviewRequired && hasMosaic(redactions));
  return { url, liveMosaic };
}
