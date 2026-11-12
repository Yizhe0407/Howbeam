import { validateRasterImageBlob } from '../shared/raster-image-validation';
import type { Bounds, ImageEdit, Redaction } from '../storage/models';
import { getValidScreenshotScale } from './image-utils';
import type { Annotation } from './annotation-contract';
import { drawAnnotationScene, isEmptyScene, type AnnotationScene } from './annotation-scene';

export { getExpandedRedactionBounds } from './annotation-scene';

type RasterFormat = 'image/jpeg' | 'image/png';

/** High enough that annotation strokes and text stay artifact-free while a
 * typical screenshot re-encodes to roughly half the bytes of quality 1. */
const JPEG_EXPORT_QUALITY = 0.95;

/**
 * Draws the screenshot and its scene (see drawAnnotationScene) and encodes the
 * result. With nothing to draw and the source already in the requested format,
 * the validated source is returned as-is: re-encoding an untouched screenshot
 * would cost a decode/encode round trip and a JPEG generation loss.
 */
export async function compositeScene(
  screenshot: Blob,
  scene: AnnotationScene,
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
): Promise<Blob> {
  const { mediaType } = await validateRasterImageBlob(screenshot);
  if (isEmptyScene(scene) && mediaType === format) return screenshot;
  const bitmap = await createImageBitmap(screenshot);
  let bitmapClosed = false;
  const closeBitmap = () => {
    if (bitmapClosed) return;
    bitmapClosed = true;
    bitmap.close();
  };
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create a 2D canvas context.');
    ctx.drawImage(bitmap, 0, 0);
    // Release the decoded pixels before drawing and the (slow) encode.
    closeBitmap();
    const dpr = getValidScreenshotScale(screenshotScale);
    drawAnnotationScene(ctx, scene, { dpr, viewportWidth: width / dpr, viewportHeight: height / dpr });
    return canvas.convertToBlob(
      format === 'image/jpeg' ? { type: format, quality: JPEG_EXPORT_QUALITY } : { type: format },
    );
  } finally {
    closeBitmap();
  }
}

/** A step's screenshot with its highlight box, drawings and masks. */
export function compositeHighlight(
  screenshot: Blob,
  bounds: Bounds | null,
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
  imageEdits: readonly ImageEdit[] = [],
): Promise<Blob> {
  return compositeScene(
    screenshot,
    {
      highlight: bounds,
      annotations: [],
      badges: true,
      imageEdits,
      redactions,
      privacyBlock: privacyBlockRequired,
    },
    screenshotScale,
    format,
  );
}

/** A snapshot's screenshot with every numbered mark, drawings and masks. */
export function compositeMultiHighlight(
  screenshot: Blob,
  annotations: Annotation[],
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
  imageEdits: readonly ImageEdit[] = [],
): Promise<Blob> {
  return compositeScene(
    screenshot,
    {
      highlight: null,
      annotations,
      badges: true,
      imageEdits,
      redactions,
      privacyBlock: privacyBlockRequired,
    },
    screenshotScale,
    format,
  );
}
