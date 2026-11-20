import { useMemo, type ReactNode } from 'react';
import {
  getEffectiveBounds,
  getEntryImageEdits,
  getEntryImageOwner,
  getEntryPrivacyState,
  getOrderedAnnotations,
  type Bounds,
  type ImageEdit,
  type Redaction,
  type StepEntry,
} from '@/lib/storage/models';
import HighlightThumbnail from './HighlightThumbnail';
import MultiHighlightThumbnail from './MultiHighlightThumbnail';

interface Props {
  entry: StepEntry;
  /** Masks to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  redactions?: Redaction[];
  /** Image edits to draw instead of the entry's saved ones, for an editor that has unsaved changes. */
  imageEdits?: ImageEdit[];
  /** Recorded boxes to draw instead of the saved ones, in numbering order, for an editor that has unsaved changes. */
  boxes?: Bounds[];
  /** The image element is exactly the image's box, so masks can be placed in percentages. */
  exactBox?: boolean;
  alt: string;
  className?: string;
  imgClassName?: string;
  /** Content rendered over the exact image frame. */
  overlay?: ReactNode;
  fit?: 'cover' | 'contain';
}

/**
 * The image editor's canvas: the whole stored screenshot, uncropped, with the
 * highlight boxes, drawings and masks laid over it live so each gesture shows
 * at once. The editor is where masks are reviewed, so the pixels are shown
 * even while that review is pending. Every other view shows the entry's
 * finished raster instead (EntryPreview).
 */
export default function LiveEntryImage({ entry, redactions, imageEdits, boxes, ...presentation }: Props) {
  const owner = getEntryImageOwner(entry);
  const savedRedactions = getEntryPrivacyState(entry).redactions;
  const shown = useMemo(() => ({
    redactions: redactions ?? savedRedactions,
    imageEdits: imageEdits ?? getEntryImageEdits(entry),
    bounds: entry.kind === 'single' ? (boxes ? boxes[0] ?? null : getEffectiveBounds(entry.step)) : null,
    annotations: entry.kind === 'group'
      ? boxes ? boxes.map((bounds, index) => ({ bounds, order: index + 1 })) : getOrderedAnnotations(entry.annotations)
      : [],
  }), [entry, redactions, savedRedactions, imageEdits, boxes]);
  const screenshotScale = owner.screenshotScale ?? owner.devicePixelRatio;

  if (entry.kind === 'single') {
    return (
      <HighlightThumbnail
        blob={owner.screenshotBlob}
        bounds={shown.bounds}
        redactions={shown.redactions}
        imageEdits={shown.imageEdits}
        screenshotScale={screenshotScale}
        {...presentation}
      />
    );
  }
  return (
    <MultiHighlightThumbnail
      blob={owner.screenshotBlob}
      annotations={shown.annotations}
      redactions={shown.redactions}
      imageEdits={shown.imageEdits}
      screenshotScale={screenshotScale}
      {...presentation}
    />
  );
}
