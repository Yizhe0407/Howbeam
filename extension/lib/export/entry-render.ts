import { compositeHighlight, compositeMultiHighlight } from '../media/annotation-composite';
import { getEffectiveBounds, getEntryCrop, getEntryImageEdits, getEntryPrivacyState, getOrderedAnnotations, type StepEntry } from '../storage/models';
import { getCroppedImage } from '../media/crop-image';
import { NO_CROP_ORIGIN, offsetAnnotations, offsetBounds, offsetImageEdits, offsetRedactions } from '../media/crop-offset';
import { getValidScreenshotScale } from '../media/image-utils';

export type CompositeImageFormat = 'image/jpeg' | 'image/png';

/**
 * Produces the one raster image represented by a timeline entry. Clipboard and
 * ZIP export both call this function so they share screenshot ownership,
 * effective/manual bounds, group numbering, and final privacy redactions.
 */
export async function compositeStepEntry(entry: StepEntry, format: CompositeImageFormat): Promise<Blob> {
  const imageOwner = entry.kind === 'single' ? entry.step : entry.anchor;
  const screenshotScale = getValidScreenshotScale(imageOwner.screenshotScale ?? imageOwner.devicePixelRatio);
  const privacy = getEntryPrivacyState(entry);

  // A crop is applied by cutting the region out of the image and expressing
  // everything drawn on it relative to that region.
  const crop = getEntryCrop(entry);
  const cropped = crop ? await getCroppedImage(imageOwner.screenshotBlob, crop, screenshotScale) : null;
  const screenshot = cropped?.blob ?? imageOwner.screenshotBlob;
  const origin = cropped?.origin ?? NO_CROP_ORIGIN;
  const redactions = offsetRedactions(privacy.redactions, origin);
  const imageEdits = offsetImageEdits(getEntryImageEdits(entry), origin);

  if (entry.kind === 'single') {
    return compositeHighlight(
      screenshot,
      offsetBounds(getEffectiveBounds(entry.step), origin),
      screenshotScale,
      format,
      redactions,
      privacy.reviewRequired,
      imageEdits,
    );
  }

  return compositeMultiHighlight(
    screenshot,
    offsetAnnotations(getOrderedAnnotations(entry.annotations), origin),
    screenshotScale,
    format,
    redactions,
    privacy.reviewRequired,
    imageEdits,
  );
}
