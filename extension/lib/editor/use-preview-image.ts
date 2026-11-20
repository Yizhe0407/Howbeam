import { useEffect, useState } from 'react';
import { getMaskedImage, getMosaicBitmap, maskedImageKey, peekMaskedImage } from '@/lib/media/masked-image';
import { NO_CROP_ORIGIN, type CropOrigin } from '@/lib/media/crop-offset';
import { hasMosaic, redactionKey } from '@/lib/media/redaction-render';
import type { Redaction } from '@/lib/storage/models';
import { useObjectUrl } from './use-object-url';

export interface PreviewImageOptions {
  /** Masks in the source image's CSS coordinates. */
  redactions: readonly Redaction[];
  screenshotScale: number;
  /** Privacy metadata is unreviewed: no source pixel may be shown at all. */
  privacyReviewRequired: boolean;
  /**
   * Show the stored pixels with the masks drawn live on top, instead of burned
   * in. Only for the image editor, whose masks move with every gesture and must
   * show what they cover; everywhere else the masks are burned in.
   */
  liveMasks?: boolean;
  /** Where the source was cut from the stored screenshot, so mosaic cells stay on its grid.
   * Keep its identity stable while it is unchanged: a new object makes a new mosaic. */
  mosaicOrigin?: CropOrigin;
}

export interface PreviewImage {
  /** Object URL for the image element, or null while nothing safe to show exists yet. */
  url: string | null;
  /** True when the pixels behind `url` already have every mask applied, so
   * overlay masks are decoration rather than the only thing hiding them. */
  masksBurnedIn: boolean;
  /** With masks burned in: the same image, whose pixels under every mosaic
   * stroke are the mosaic, for the overlay that keeps drawings beneath a
   * stroke covered. Null while it is being made: strokes are painted solid. */
  mosaicUrl: string | null;
  /** With live masks: the source pixelated on the mosaic grid, for painting
   * strokes over the stored pixels. Null while it is being made (or not
   * needed): strokes are painted solid. */
  liveMosaic: ImageBitmap | null;
}

interface Settled {
  source: Blob;
  key: string;
  redactions: readonly Redaction[];
  privacyReviewRequired: boolean;
  /** Null when compositing failed: the preview then stays empty (fail closed). */
  blob: Blob | null;
}

/** Whether an earlier masked result of the same source hides at least what the
 * new masks hide, so it can stay on screen while the new result is made. */
function hidesAtLeast(previous: Settled, redactions: readonly Redaction[], privacyReviewRequired: boolean): boolean {
  if (previous.privacyReviewRequired) return true;
  if (privacyReviewRequired) return false;
  const hidden = new Set(previous.redactions.map(redactionKey));
  return redactions.every((redaction) => hidden.has(redactionKey(redaction)));
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
 * The image a preview shows for a screenshot. Unless `liveMasks` is set, this
 * is never the stored screenshot when anything on it must be hidden: it is a
 * raster with the masks burned in (or all black while privacy review is
 * pending), so saving, copying or dragging a preview cannot recover masked
 * pixels. Until that raster exists, or if it cannot be made, there is no URL.
 */
export function usePreviewImage(
  source: Blob,
  { redactions, screenshotScale, privacyReviewRequired, liveMasks = false, mosaicOrigin = NO_CROP_ORIGIN }: PreviewImageOptions,
): PreviewImage {
  const live = liveMasks && !privacyReviewRequired;
  const needsMasking = !live && (privacyReviewRequired || redactions.length > 0);
  const key = needsMasking ? maskedImageKey(redactions, screenshotScale, privacyReviewRequired, mosaicOrigin) : '';
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!needsMasking || peekMaskedImage(source, key)) return undefined;
    let cancelled = false;
    const done = (blob: Blob | null) => {
      if (!cancelled) setSettled({ source, key, redactions, privacyReviewRequired, blob });
    };
    getMaskedImage(source, redactions, screenshotScale, privacyReviewRequired, mosaicOrigin).then(done, (error) => {
      console.error('[howbeam] failed to mask the preview image', error);
      done(null);
    });
    return () => {
      cancelled = true;
    };
  }, [source, key, needsMasking, redactions, screenshotScale, privacyReviewRequired, mosaicOrigin]);

  let shown: Blob | null;
  if (!needsMasking) {
    shown = source;
  } else {
    shown = peekMaskedImage(source, key) ?? null;
    if (!shown && settled?.source === source) {
      if (settled.key === key) shown = settled.blob;
      else if (settled.blob && hidesAtLeast(settled, redactions, privacyReviewRequired)) shown = settled.blob;
    }
  }

  const url = useObjectUrl(shown) || null;
  const liveMosaic = useMosaicBitmap(source, screenshotScale, mosaicOrigin, live && hasMosaic(redactions));
  return { url, masksBurnedIn: !live, mosaicUrl: live ? null : url, liveMosaic };
}
