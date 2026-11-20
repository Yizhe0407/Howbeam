import { validateRasterImageBlob } from '../capture/raster-image-validation';
import type { Bounds, ImageEdit, Redaction } from '../storage/models';
import { drawImageEdits } from './image-edit-render';
import { getValidScreenshotScale, rasterContext } from './image-utils';
import { NO_CROP_ORIGIN, type CropOrigin } from './crop-offset';
import { drawRedactions, hasMosaic, pixelatedCopy } from './redaction-render';
import {
  BADGE_FONT_FAMILY,
  BADGE_TEXT_COLOR,
  BADGE_RADIUS,
  HIGHLIGHT_COLOR,
  HIGHLIGHT_FILL_COLOR,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
  REDACTION_COLOR,
  isDrawableHighlightFrame,
  type Annotation,
  type AnnotationPoint,
} from './annotation-contract';
import { fitHighlightFrame, getBadgeFontSize } from './annotation-geometry';
import { layoutAnnotations } from './annotation-layout';

function strokeBox(ctx: OffscreenCanvasRenderingContext2D, bounds: Bounds, dpr: number) {
  // Same structural guard as the live thumbnail overlay, so preview and
  // export skip exactly the same clamped-to-edge degenerate frames.
  if (!isDrawableHighlightFrame(bounds)) return;
  const lineWidth = HIGHLIGHT_LINE_WIDTH * dpr;
  const outerX = bounds.x * dpr;
  const outerY = bounds.y * dpr;
  const outerWidth = bounds.width * dpr;
  const outerHeight = bounds.height * dpr;
  // CSS clamps border-radius to half the box; do the same before insetting.
  const outerRadius = Math.max(Math.min(HIGHLIGHT_RADIUS * dpr, outerWidth / 2, outerHeight / 2), 0);
  const x = bounds.x * dpr + lineWidth / 2;
  const y = bounds.y * dpr + lineWidth / 2;
  const w = outerWidth - lineWidth;
  const h = outerHeight - lineWidth;
  const radius = Math.max(outerRadius - lineWidth / 2, 0);

  ctx.fillStyle = HIGHLIGHT_FILL_COLOR;
  ctx.beginPath();
  ctx.roundRect(outerX, outerY, outerWidth, outerHeight, outerRadius);
  ctx.fill();

  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.stroke();
}

function strokeTarget(ctx: OffscreenCanvasRenderingContext2D, anchor: AnnotationPoint, dpr: number) {
  const x = anchor.x * dpr;
  const y = anchor.y * dpr;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(x, y, MARKER_RADIUS * dpr, 0, Math.PI * 2);
  ctx.fill();
  // The preview's ring is a box-border CSS border: it sits entirely inside the
  // MARKER_RADIUS outer edge. Stroke the ring's centerline accordingly.
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = MARKER_RING_WIDTH * dpr;
  ctx.beginPath();
  ctx.arc(x, y, (MARKER_RADIUS - MARKER_RING_WIDTH / 2) * dpr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.beginPath();
  ctx.arc(x, y, MARKER_INNER_RADIUS * dpr, 0, Math.PI * 2);
  ctx.fill();
}

function drawBadge(ctx: OffscreenCanvasRenderingContext2D, point: AnnotationPoint, order: number, dpr: number) {
  const r = BADGE_RADIUS * dpr;
  const cx = point.x * dpr;
  const cy = point.y * dpr;

  // Subtle elevation matching the preview badge's Tailwind `shadow`
  // (0 1px 3px rgb(0 0 0 / 0.1)). Reset before the digit so it stays crisp.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
  ctx.shadowBlur = 3 * dpr;
  ctx.shadowOffsetY = 1 * dpr;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = HIGHLIGHT_COLOR;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `600 ${getBadgeFontSize(order) * dpr}px ${BADGE_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  // Center the digit glyphs by their actual bounding box rather than the font's
  // full line box, so they sit optically centered like the preview's flexbox.
  ctx.textBaseline = 'alphabetic';
  const text = String(order);
  const metrics = ctx.measureText(text);
  const textY = cy + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  ctx.fillText(text, cx, textY);
}

function drawLeader(ctx: OffscreenCanvasRenderingContext2D, points: AnnotationPoint[], dpr: number) {
  const [first, ...rest] = points;
  if (!first || rest.length === 0) return;
  ctx.strokeStyle = HIGHLIGHT_COLOR;
  ctx.lineWidth = LEADER_LINE_WIDTH * dpr;
  // Match the SVG polyline defaults the preview uses (butt caps, miter joins).
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(first.x * dpr, first.y * dpr);
  for (const point of rest) ctx.lineTo(point.x * dpr, point.y * dpr);
  ctx.stroke();
}

type RasterFormat = 'image/jpeg' | 'image/png';

export interface CompositeOptions {
  /** Downscale the finished image to at most this many pixels wide, after
   * everything is drawn at full size, so marks and mosaic cells look exactly
   * as they do in an export, only smaller. Omitted keeps the full size. */
  maxPixelWidth?: number;
  /** False leaves out the order badges and their leader lines, for previews too small to read them. */
  badges?: boolean;
}

/** The smaller size an image of `width` x `height` is scaled to, or null when it already fits. */
function scaledSize(width: number, height: number, maxPixelWidth: number | undefined): { width: number; height: number } | null {
  if (!maxPixelWidth || width <= maxPixelWidth) return null;
  const scaledWidth = Math.max(1, Math.round(maxPixelWidth));
  return { width: scaledWidth, height: Math.max(1, Math.round(height * scaledWidth / width)) };
}

function downscaled(canvas: OffscreenCanvas, { width, height }: { width: number; height: number }): OffscreenCanvas {
  const target = new OffscreenCanvas(width, height);
  const ctx = rasterContext(target);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, width, height);
  return target;
}

/** High enough that annotation strokes and text stay artifact-free while a
 * typical screenshot re-encodes to roughly half the bytes of quality 1. */
const JPEG_EXPORT_QUALITY = 0.95;

/** Draws source pixels, annotations, then privacy masks in that strict order.
 * Keeping this low-level pipeline shared prevents clipboard and ZIP rendering
 * from drifting in their final redaction treatment.
 *
 * `drawAnnotations: null` declares that the caller has nothing to draw. When
 * additionally no redactions apply, no privacy block is required, and the
 * validated source already has the requested media type, the original blob is
 * returned as-is: re-encoding an untouched screenshot would only cost a full
 * decode/encode round trip plus a JPEG generation loss. */
async function compositeRaster(
  screenshot: Blob,
  screenshotScale: number,
  redactions: readonly Redaction[],
  imageEdits: readonly ImageEdit[],
  privacyBlockRequired: boolean,
  format: RasterFormat,
  mosaicOrigin: CropOrigin,
  drawAnnotations:
    | ((
        ctx: OffscreenCanvasRenderingContext2D,
        dpr: number,
        viewportWidth: number,
        viewportHeight: number,
      ) => void)
    | null,
  maxPixelWidth: number | undefined,
): Promise<Blob> {
  const { width: sourceWidth, height: sourceHeight, mediaType } = await validateRasterImageBlob(screenshot);
  if (
    drawAnnotations === null && redactions.length === 0 && imageEdits.length === 0 && !privacyBlockRequired
    && mediaType === format && !scaledSize(sourceWidth, sourceHeight, maxPixelWidth)
  ) {
    return screenshot;
  }
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
    const ctx = rasterContext(canvas);
    ctx.drawImage(bitmap, 0, 0);
    // Release the decoded pixels before annotating and the (slow) encode; the
    // finally below stays as the safety net for earlier throw paths.
    closeBitmap();

    const dpr = getValidScreenshotScale(screenshotScale);
    const viewportWidth = width / dpr;
    const viewportHeight = height / dpr;
    // Taken from the bare screenshot: a mosaic shows the page, never the marks drawn over it.
    const mosaic = hasMosaic(redactions) ? pixelatedCopy(canvas, dpr, mosaicOrigin) : null;
    drawAnnotations?.(ctx, dpr, viewportWidth, viewportHeight);
    // The person's own drawings sit above the automatic highlights but below every mask.
    drawImageEdits(ctx, imageEdits, dpr);
    // Must remain last: a redaction is privacy-critical and intentionally
    // covers highlight strokes, callouts, markers, and badges beneath it.
    drawRedactions(ctx, redactions, viewportWidth, viewportHeight, dpr, mosaic);
    if (privacyBlockRequired) {
      ctx.fillStyle = REDACTION_COLOR;
      ctx.fillRect(0, 0, width, height);
    }

    const scaled = scaledSize(width, height, maxPixelWidth);
    const result = scaled ? downscaled(canvas, scaled) : canvas;
    return result.convertToBlob(format === 'image/jpeg' ? { type: format, quality: JPEG_EXPORT_QUALITY } : { type: format });
  } finally {
    closeBitmap();
  }
}

/**
 * Composites the red highlight box onto a raw screenshot and returns an image
 * blob. If bounds is null, no box is drawn and any privacy
 * redactions are still rendered; with nothing at all to draw the validated
 * source blob may be returned unchanged instead of re-encoded.
 */
export async function compositeHighlight(
  screenshot: Blob,
  bounds: Bounds | null,
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
  imageEdits: readonly ImageEdit[] = [],
  /** Where `screenshot` was cut from the stored screenshot, so mosaic cells stay on the stored image's grid. */
  mosaicOrigin: CropOrigin = NO_CROP_ORIGIN,
  options: CompositeOptions = {},
): Promise<Blob> {
  const drawHighlight = bounds
    ? (ctx: OffscreenCanvasRenderingContext2D, dpr: number, viewportWidth: number, viewportHeight: number) => {
        strokeBox(ctx, fitHighlightFrame(bounds, viewportWidth, viewportHeight), dpr);
      }
    : null;
  return compositeRaster(screenshot, screenshotScale, redactions, imageEdits, privacyBlockRequired, format, mosaicOrigin, drawHighlight, options.maxPixelWidth);
}

/**
 * Composites every annotation's red box and order badge onto
 * one shared screenshot — the single-image mode counterpart of
 * {@link compositeHighlight}.
 */
export async function compositeMultiHighlight(
  screenshot: Blob,
  annotations: Annotation[],
  screenshotScale: number,
  format: RasterFormat = 'image/jpeg',
  redactions: readonly Redaction[] = [],
  privacyBlockRequired = false,
  imageEdits: readonly ImageEdit[] = [],
  /** Where `screenshot` was cut from the stored screenshot, so mosaic cells stay on the stored image's grid. */
  mosaicOrigin: CropOrigin = NO_CROP_ORIGIN,
  options: CompositeOptions = {},
): Promise<Blob> {
  const { maxPixelWidth, badges = true } = options;
  if (annotations.length === 0) {
    return compositeRaster(screenshot, screenshotScale, redactions, imageEdits, privacyBlockRequired, format, mosaicOrigin, null, maxPixelWidth);
  }
  return compositeRaster(screenshot, screenshotScale, redactions, imageEdits, privacyBlockRequired, format, mosaicOrigin, (ctx, dpr, viewportWidth, viewportHeight) => {
    const layouts = layoutAnnotations(annotations, viewportWidth, viewportHeight);
    for (const layout of layouts) {
      if (layout.markerOnly) {
        strokeTarget(ctx, layout.anchor, dpr);
      } else {
        strokeBox(ctx, layout.frame, dpr);
      }

      if (!badges) continue;
      if (layout.callout) drawLeader(ctx, layout.leader, dpr);
      drawBadge(ctx, layout.callout ?? layout.badgeAnchor, layout.order, dpr);
    }
  }, maxPixelWidth);
}
