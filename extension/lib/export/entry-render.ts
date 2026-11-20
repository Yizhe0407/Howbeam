import { compositeHighlight, compositeMultiHighlight, type CompositeOptions } from '../media/annotation-composite';
import type { Annotation } from '../media/annotation-contract';
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
} from '../storage/models';
import { getCroppedImage } from '../media/crop-image';
import { NO_CROP_ORIGIN, offsetAnnotations, offsetBounds, offsetImageEdits, offsetRedactions } from '../media/crop-offset';
import { getValidScreenshotScale } from '../media/image-utils';

export type CompositeImageFormat = 'image/jpeg' | 'image/png';

/**
 * Everything that decides the pixels of a timeline entry's image, as plain
 * data: what an export, a copy and every preview draw from. It holds no
 * object with methods or identity beyond the screenshot Blob, so it can be
 * posted to a worker and serialized into a cache key.
 */
export interface EntryRasterInput {
  screenshot: Blob;
  screenshotScale: number;
  crop: Bounds | null;
  redactions: Redaction[];
  privacyReviewRequired: boolean;
  imageEdits: ImageEdit[];
  marks:
    | { kind: 'single'; bounds: Bounds | null }
    | { kind: 'group'; annotations: Annotation[] };
}

export interface EntryRasterOptions extends CompositeOptions {
  format: CompositeImageFormat;
}

export function entryRasterInput(entry: StepEntry): EntryRasterInput {
  const owner = getEntryImageOwner(entry);
  const privacy = getEntryPrivacyState(entry);
  return {
    screenshot: owner.screenshotBlob,
    screenshotScale: getValidScreenshotScale(owner.screenshotScale ?? owner.devicePixelRatio),
    crop: getEntryCrop(entry),
    redactions: privacy.redactions,
    privacyReviewRequired: privacy.reviewRequired,
    imageEdits: getEntryImageEdits(entry),
    marks: entry.kind === 'single'
      ? { kind: 'single', bounds: getEffectiveBounds(entry.step) }
      : { kind: 'group', annotations: getOrderedAnnotations(entry.annotations) },
  };
}

/** Identifies the pixels `input` renders to for one screenshot Blob: two
 * inputs of the same Blob with the same key render the same image. */
export function entryRasterKey(input: EntryRasterInput, options: EntryRasterOptions): string {
  const { screenshot: _screenshot, ...drawn } = input;
  return JSON.stringify([drawn, options.format, options.maxPixelWidth ?? null, options.badges ?? true]);
}

/**
 * Produces the one raster image represented by a timeline entry. Clipboard,
 * ZIP/PDF export and every on-screen preview go through here, so they share
 * screenshot ownership, effective/manual bounds, group numbering, and final
 * privacy redactions.
 */
export async function renderEntryRaster(input: EntryRasterInput, options: EntryRasterOptions): Promise<Blob> {
  const { format, ...compositeOptions } = options;
  // A crop is applied by cutting the region out of the image and expressing
  // everything drawn on it relative to that region.
  const cropped = input.crop ? await getCroppedImage(input.screenshot, input.crop, input.screenshotScale) : null;
  const screenshot = cropped?.blob ?? input.screenshot;
  const origin = cropped?.origin ?? NO_CROP_ORIGIN;
  const redactions = offsetRedactions(input.redactions, origin);
  const imageEdits = offsetImageEdits(input.imageEdits, origin);

  if (input.marks.kind === 'single') {
    return compositeHighlight(
      screenshot,
      offsetBounds(input.marks.bounds, origin),
      input.screenshotScale,
      format,
      redactions,
      input.privacyReviewRequired,
      imageEdits,
      origin,
      compositeOptions,
    );
  }

  return compositeMultiHighlight(
    screenshot,
    offsetAnnotations(input.marks.annotations, origin),
    input.screenshotScale,
    format,
    redactions,
    input.privacyReviewRequired,
    imageEdits,
    origin,
    compositeOptions,
  );
}

export function compositeStepEntry(entry: StepEntry, format: CompositeImageFormat): Promise<Blob> {
  return renderEntryRaster(entryRasterInput(entry), { format });
}
