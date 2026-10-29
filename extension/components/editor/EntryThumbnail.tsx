import { useMemo, type ReactNode } from 'react';
import {
  getEffectiveBounds,
  getEntryCrop,
  getEntryImageEdits,
  getEntryImageOwner,
  getEntryPrivacyState,
  getOrderedAnnotations,
  type Bounds,
  type ImageEdit,
  type Redaction,
  type StepEntry,
} from '@/lib/storage/models';
import { offsetAnnotations, offsetBounds, offsetImageEdits, offsetRedactions } from '@/lib/media/crop-offset';
import { useCroppedImage } from '@/lib/editor/use-cropped-image';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';

interface Props {
  entry: StepEntry;
  /** Masks to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  redactions?: Redaction[];
  /** Image edits to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  imageEdits?: ImageEdit[];
  /** The crop to show instead of the entry's saved one; `null` shows the whole image. */
  crop?: Bounds | null;
  /** The image element is exactly the image's box, so masks can be placed in percentages. */
  exactBox?: boolean;
  /**
   * Image editor only: show the stored pixels with the masks drawn live on top,
   * so they can be edited. Every other preview shows the masks burned in.
   */
  liveMasks?: boolean;
  /**
   * Image editor only: the masks are being reviewed right here, so the pixels
   * are shown even while that review is pending (everywhere else they stay hidden).
   */
  reviewing?: boolean;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  fit?: 'cover' | 'contain';
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'sync' | 'auto';
  /** See MultiHighlightThumbnail's badges. */
  badges?: boolean;
}

/**
 * Renders a timeline entry's preview and derives blob/bounds/privacy so
 * callers don't drift in wiring these up. A crop is applied here, once, for
 * every preview: the image is cut to the crop and everything drawn on it is
 * shifted by the crop's origin, so the thumbnails below only ever see an
 * ordinary, uncropped image.
 */
export default function EntryThumbnail({ entry, redactions, imageEdits, crop, reviewing = false, badges, ...presentation }: Props) {
  const privacy = getEntryPrivacyState(entry);
  const privacyReviewRequired = privacy.reviewRequired && !reviewing;
  const owner = getEntryImageOwner(entry);
  const screenshotScale = owner.screenshotScale ?? owner.devicePixelRatio;
  const view = useCroppedImage(owner.screenshotBlob, crop === undefined ? getEntryCrop(entry) : crop, screenshotScale);
  const originX = view?.origin.x ?? 0;
  const originY = view?.origin.y ?? 0;

  const sourceRedactions = redactions ?? privacy.redactions;
  const sourceImageEdits = imageEdits ?? getEntryImageEdits(entry);
  const shown = useMemo(() => {
    const origin = { x: originX, y: originY };
    return {
      redactions: offsetRedactions(sourceRedactions, origin),
      imageEdits: offsetImageEdits(sourceImageEdits, origin),
      bounds: entry.kind === 'single' ? offsetBounds(getEffectiveBounds(entry.step), origin) : null,
      annotations: entry.kind === 'group' ? offsetAnnotations(getOrderedAnnotations(entry.annotations), origin) : [],
    };
  }, [entry, originX, originY, sourceRedactions, sourceImageEdits]);

  // The first cut of a cropped image is still running; never show the uncropped screenshot meanwhile.
  if (!view) return null;

  if (entry.kind === 'single') {
    return (
      <HighlightThumbnail
        blob={view.blob}
        bounds={shown.bounds}
        redactions={shown.redactions}
        imageEdits={shown.imageEdits}
        privacyReviewRequired={privacyReviewRequired}
        screenshotScale={screenshotScale}
        {...presentation}
      />
    );
  }
  return (
    <MultiHighlightThumbnail
      blob={view.blob}
      annotations={shown.annotations}
      redactions={shown.redactions}
      imageEdits={shown.imageEdits}
      privacyReviewRequired={privacyReviewRequired}
      screenshotScale={screenshotScale}
      badges={badges}
      {...presentation}
    />
  );
}
