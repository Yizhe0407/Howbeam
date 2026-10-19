import { useEffect, useState } from 'react';
import { getMaskedImage, maskedImageKey, peekMaskedImage } from '@/lib/media/masked-image';
import type { Bounds, Redaction } from '@/lib/storage/models';
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
}

export interface PreviewImage {
  /** Object URL for the image element, or null while nothing safe to show exists yet. */
  url: string | null;
  /** True when the pixels behind `url` already have every mask applied, so
   * overlay masks are decoration rather than the only thing hiding them. */
  masksBurnedIn: boolean;
}

interface Settled {
  source: Blob;
  key: string;
  redactions: readonly Redaction[];
  privacyReviewRequired: boolean;
  /** Null when compositing failed: the preview then stays empty (fail closed). */
  blob: Blob | null;
}

const sameBounds = (a: Bounds, b: Bounds): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Whether an earlier masked result of the same source hides at least what the
 * new masks hide, so it can stay on screen while the new result is made. */
function hidesAtLeast(previous: Settled, redactions: readonly Redaction[], privacyReviewRequired: boolean): boolean {
  if (previous.privacyReviewRequired) return true;
  if (privacyReviewRequired) return false;
  return redactions.every((redaction) => previous.redactions.some((old) => sameBounds(old.bounds, redaction.bounds)));
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
  { redactions, screenshotScale, privacyReviewRequired, liveMasks = false }: PreviewImageOptions,
): PreviewImage {
  const live = liveMasks && !privacyReviewRequired;
  const needsMasking = !live && (privacyReviewRequired || redactions.length > 0);
  const key = needsMasking ? maskedImageKey(redactions, screenshotScale, privacyReviewRequired) : '';
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!needsMasking || peekMaskedImage(source, key)) return undefined;
    let cancelled = false;
    const done = (blob: Blob | null) => {
      if (!cancelled) setSettled({ source, key, redactions, privacyReviewRequired, blob });
    };
    getMaskedImage(source, redactions, screenshotScale, privacyReviewRequired).then(done, (error) => {
      console.error('[howbeam] failed to mask the preview image', error);
      done(null);
    });
    return () => {
      cancelled = true;
    };
  }, [source, key, needsMasking, redactions, screenshotScale, privacyReviewRequired]);

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

  const url = useObjectUrl(shown);
  return { url: url || null, masksBurnedIn: !live };
}
