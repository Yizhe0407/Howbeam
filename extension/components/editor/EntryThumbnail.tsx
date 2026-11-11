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
import type { AnnotationScene } from '@/lib/media/annotation-scene';
import AnnotatedImage from './AnnotatedImage';

interface Props {
  entry: StepEntry;
  /** Masks to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  redactions?: Redaction[];
  /** Image edits to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  imageEdits?: ImageEdit[];
  /** The crop to show instead of the entry's saved one; `null` shows the whole image. */
  crop?: Bounds | null;
  /** Recorded boxes to draw instead of the saved ones, in numbering order, for an editor that has unsaved changes. */
  boxes?: Bounds[];
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
  /** False drops the mark numbers, for previews too small to read them. */
  badges?: boolean;
}

/**
 * Renders a timeline entry's preview and derives blob/bounds/privacy so
 * callers don't drift in wiring these up. A crop is applied here, once, for
 * every preview: the image is cut to the crop and everything drawn on it is
 * shifted by the crop's origin, so the thumbnails below only ever see an
 * ordinary, uncropped image.
 */
export default function EntryThumbnail({ entry, redactions, imageEdits, crop, boxes, reviewing = false, badges = true, ...presentation }: Props) {
  const privacy = getEntryPrivacyState(entry);
  const privacyReviewRequired = privacy.reviewRequired && !reviewing;
  const owner = getEntryImageOwner(entry);
  const screenshotScale = owner.screenshotScale ?? owner.devicePixelRatio;
  const view = useCroppedImage(owner.screenshotBlob, crop === undefined ? getEntryCrop(entry) : crop, screenshotScale);
  const originX = view?.origin.x ?? 0;
  const originY = view?.origin.y ?? 0;

  const sourceRedactions = redactions ?? privacy.redactions;
  const sourceImageEdits = imageEdits ?? getEntryImageEdits(entry);
  const scene = useMemo<AnnotationScene>(() => {
    const origin = { x: originX, y: originY };
    return {
      highlight: entry.kind === 'single'
        ? offsetBounds(boxes ? boxes[0] ?? null : getEffectiveBounds(entry.step), origin)
        : null,
      annotations: entry.kind === 'group'
        ? offsetAnnotations(
          boxes ? boxes.map((bounds, index) => ({ bounds, order: index + 1 })) : getOrderedAnnotations(entry.annotations),
          origin,
        )
        : [],
      badges,
      imageEdits: offsetImageEdits(sourceImageEdits, origin),
      redactions: offsetRedactions(sourceRedactions, origin),
      privacyBlock: privacyReviewRequired,
    };
  }, [entry, originX, originY, sourceRedactions, sourceImageEdits, boxes, badges, privacyReviewRequired]);

  // The first cut of a cropped image is still running; never show the uncropped screenshot meanwhile.
  if (!view) return null;

  return <AnnotatedImage blob={view.blob} scene={scene} screenshotScale={screenshotScale} {...presentation} />;
}
